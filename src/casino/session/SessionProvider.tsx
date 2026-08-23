import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { gql, type TypedDocumentNode } from "@apollo/client";
import { useApolloClient, useQuery } from "@apollo/client/react";
import { getToken, setToken } from "../../apollo";

export interface UserAccount {
  id: string;
  handle: string;
  credits: number;
}

const ME: TypedDocumentNode<{ me: UserAccount | null }, Record<string, never>> = gql`
  query Me {
    me {
      id
      handle
      credits
    }
  }
`;

const LOGIN: TypedDocumentNode<
  { redeemInvite: { token: string; user: UserAccount } },
  { code: string }
> = gql`
  mutation RedeemInvite($code: String!) {
    redeemInvite(code: $code) {
      token
      user {
        id
        handle
        credits
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
  login: (code: string) => Promise<{ ok: boolean; error?: string }>;
  logout: () => void;
}

const SessionContext = createContext<SessionValue | null>(null);

/**
 * Auth for The Crown: an opaque bearer token in localStorage, resolved to an
 * account by `me`. Bets are placed and settled server-side against the round,
 * so the session holds no wager state of its own.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const client = useApolloClient();
  // Track the token in state (not just localStorage) so setting it re-renders
  // and un-skips the ME query, which then fetches automatically.
  const [token, setTok] = useState<string | null>(() => getToken());
  const meQ = useQuery(ME, { skip: !token });

  const applyToken = useCallback((next: string | null) => {
    setToken(next);
    setTok(next);
  }, []);

  const login = useCallback(
    async (code: string) => {
      try {
        const res = await client.mutate({ mutation: LOGIN, variables: { code } });
        const token = res.data?.redeemInvite.token;
        if (!token) return { ok: false, error: "That code didn't work." };
        applyToken(token);
        await client.refetchQueries({ include: [ME] });
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : "Something went wrong.",
        };
      }
    },
    [client, applyToken]
  );

  const logout = useCallback(() => {
    // Revoke first, while the token is still attached to outgoing requests —
    // but don't make signing out wait on the network, and don't leave the user
    // signed in if it fails. Locally forgetting the token is the part that has
    // to be unconditional.
    void client.mutate({ mutation: LOGOUT }).catch(() => {});
    applyToken(null);
    void client.resetStore();
  }, [client, applyToken]);

  const value = useMemo<SessionValue>(
    () => ({
      user: meQ.data?.me ?? null,
      loading: meQ.loading,
      login,
      logout,
    }),
    [meQ.data?.me, meQ.loading, login, logout]
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used within a SessionProvider.");
  return ctx;
}
