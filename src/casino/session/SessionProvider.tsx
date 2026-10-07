import { useWallet } from "@solana/wallet-adapter-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { gql, type TypedDocumentNode } from "@apollo/client";
import { useApolloClient, useQuery } from "@apollo/client/react";
import { getToken, setToken } from "../../apollo";

export interface UserAccount {
  id: string;
  handle: string;
  credits: number;
  walletAddress: string | null;
}

const ME: TypedDocumentNode<{ me: UserAccount | null }, Record<string, never>> = gql`
  query Me {
    me {
      id
      handle
      credits
      walletAddress
    }
  }
`;

const CHALLENGE: TypedDocumentNode<
  { walletChallenge: { nonce: string; message: string } },
  { address: string }
> = gql`
  mutation WalletChallenge($address: String!) {
    walletChallenge(address: $address) {
      nonce
      message
    }
  }
`;

const LOGIN: TypedDocumentNode<
  { walletLogin: { token: string; user: UserAccount } },
  { address: string; nonce: string; signature: string }
> = gql`
  mutation WalletLogin($address: String!, $nonce: String!, $signature: String!) {
    walletLogin(address: $address, nonce: $nonce, signature: $signature) {
      token
      user {
        id
        handle
        credits
        walletAddress
      }
    }
  }
`;

/**
 * Revoke the session server-side as well as forgetting it here.
 *
 * Dropping the token locally leaves the row alive for the rest of its thirty
 * days, so "log out" on a shared machine wasn't logging out — anything that had
 * seen the token still held the account.
 */
const LOGOUT: TypedDocumentNode<{ logout: boolean }, Record<string, never>> = gql`
  mutation Logout {
    logout
  }
`;

export interface SessionValue {
  user: UserAccount | null;
  loading: boolean;
  /**
   * Sign in with the connected wallet.
   *
   * Arms the attempt rather than performing it, because the wallet may not be
   * connected yet: picking one is asynchronous, and the caller that opens the
   * picker wants to say "and then sign me in" without waiting around for it.
   * Once a key is available the signature prompt goes up on its own.
   */
  signIn: () => void;
  /** A wallet prompt is up, or the server is being asked. */
  signingIn: boolean;
  /** Why the last attempt failed. Cleared by the next one. */
  error: string | null;
  logout: () => void;
}

const SessionContext = createContext<SessionValue | null>(null);

/** A dismissed wallet prompt is a decision, not a failure worth a red line. */
function isRejection(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /user rejected|rejected the request|declin(e|ed)|cancell?ed/i.test(message);
}

/** Signatures cross the wire as base64; `signMessage` hands back raw bytes. */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * Auth for The Crown: prove the wallet, get an opaque bearer token, resolve it
 * to an account with `me`.
 *
 * The wallet is the whole of the identity — there is no code to redeem, no
 * account to register and nothing to remember. Connecting proves nothing on its
 * own (an address is public), so signing in is a signature over a nonce the
 * server picked; an address that has never been here gets an account the first
 * time it signs one.
 *
 * Bets are placed and settled server-side against the round, so the session
 * holds no wager state of its own.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const client = useApolloClient();
  const { publicKey, signMessage } = useWallet();
  const address = publicKey?.toBase58() ?? null;

  // Track the token in state (not just localStorage) so setting it re-renders
  // and un-skips the ME query, which then fetches automatically.
  const [token, setTok] = useState<string | null>(() => getToken());
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Set by `signIn`, cleared when an attempt finishes. */
  const [wanted, setWanted] = useState(false);
  const meQ = useQuery(ME, { skip: !token });
  const user = meQ.data?.me ?? null;

  const applyToken = useCallback((next: string | null) => {
    setToken(next);
    setTok(next);
  }, []);

  const signIn = useCallback(() => {
    setError(null);
    setWanted(true);
  }, []);

  const forget = useCallback(() => {
    applyToken(null);
    void client.resetStore();
  }, [applyToken, client]);

  const logout = useCallback(() => {
    // Revoke first, while the token is still attached to outgoing requests —
    // but don't make signing out wait on the network, and don't leave the user
    // signed in if it fails. Locally forgetting the token is the part that has
    // to be unconditional.
    void client.mutate({ mutation: LOGOUT }).catch(() => {});
    setWanted(false);
    forget();
  }, [client, forget]);

  /**
   * The signature round trip, once there is a key to ask.
   *
   * Guarded by `running` as well as by `wanted`, because the effect's own
   * dependencies change while it is in flight — a re-render mid-prompt must not
   * put a second wallet dialog on top of the first.
   *
   * Gated on having no account rather than on having no token: a token that
   * outlived its session (expired, revoked, or from the invite-code era) still
   * sits in storage but resolves to nobody, and waiting for it to be absent
   * would leave "Sign in" doing nothing at all. A fresh signature replaces it.
   */
  const running = useRef(false);
  useEffect(() => {
    if (!wanted || user || running.current) return;
    if (!address || !signMessage) return;

    running.current = true;
    setSigningIn(true);
    void (async () => {
      try {
        const challenge = await client.mutate({
          mutation: CHALLENGE,
          variables: { address },
        });
        const issued = challenge.data?.walletChallenge;
        if (!issued) throw new Error("The server would not start a sign-in.");

        // The message is signed exactly as it was handed over, and the server
        // rebuilds it from the nonce rather than trusting what comes back — so
        // what the wallet displays is what gets verified.
        const signature = await signMessage(new TextEncoder().encode(issued.message));

        const res = await client.mutate({
          mutation: LOGIN,
          variables: { address, nonce: issued.nonce, signature: toBase64(signature) },
        });
        const next = res.data?.walletLogin.token;
        if (!next) throw new Error("The server would not issue a session.");
        applyToken(next);
        await client.refetchQueries({ include: [ME] });
        setError(null);
      } catch (err) {
        setError(isRejection(err) ? null : err instanceof Error ? err.message : "Sign-in failed.");
      } finally {
        running.current = false;
        setSigningIn(false);
        setWanted(false);
      }
    })();
  }, [address, applyToken, client, signMessage, user, wanted]);

  /**
   * The session follows the wallet.
   *
   * Switching accounts inside Phantom used to leave the page signed in as the
   * previous one: the board would show that account's balance and positions
   * while every wallet prompt came from a key it no longer belonged to, and a
   * top-up would be refused as somebody else's. The wallet *is* the account
   * now, so changing it is signing out.
   *
   * Only when a different wallet is actually connected. Disconnecting is not a
   * sign-out — the token is the session, and a player who closed their wallet
   * extension still has their bets.
   */
  useEffect(() => {
    if (!user?.walletAddress || !address) return;
    if (address === user.walletAddress) return;
    void client.mutate({ mutation: LOGOUT }).catch(() => {});
    forget();
  }, [address, client, forget, user?.walletAddress]);

  const value = useMemo<SessionValue>(
    () => ({
      user,
      loading: meQ.loading,
      signIn,
      signingIn,
      error,
      logout,
    }),
    [user, meQ.loading, signIn, signingIn, error, logout]
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used within a SessionProvider.");
  return ctx;
}
