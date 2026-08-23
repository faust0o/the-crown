// First, and deliberately: spl-token calls a bare `Buffer` the moment an
// instruction is built, and this is the module every path to one goes through.
import "./polyfill";

import type { WalletError } from "@solana/wallet-adapter-base";
import {
  ConnectionProvider,
  WalletProvider,
  useConnection,
  useWallet,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
// From the two adapter packages rather than the `@solana/wallet-adapter-wallets`
// barrel that re-exports them. The barrel depends on all thirty-six adapters, so
// importing two names from it drags WalletConnect, Reown, viem and Torus through
// the transform: 5,882 modules against 1,134, three times the build, and two
// "externalized for browser compatibility" warnings for Node builtins that
// nothing we ship can reach. Rollup does shake it all back out — the emitted
// chunk is byte-identical either way — so this buys no bundle, only a build that
// is quiet enough for a real warning to stand out in.
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import {
} from "@solana/spl-token";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  CLUSTER,
  COMMITMENT,
  RPC_URL,
} from "./program";
import { CrownWalletContext, type CrownWalletValue } from "./wallet";

/**
 * How often the chain is re-read.
 *
 * Twenty times slower than the board's poll, because nothing here moves on its
 * own: a balance changes when a round settles or a bet is relayed, and an
 * allowance only when the player themself signs. The one moment freshness
 * matters — just after a setup transaction — is covered by refreshing on
 * confirmation rather than by polling harder.
 */
const POLL_MS = 20_000;

interface Snapshot {
  sol: number | null;
}

const EMPTY: Snapshot = { sol: null };

/**
 * A dismissed prompt is a decision, not a fault.
 *
 * Wallets deliver it down the same channel as a failed simulation, so without
 * this every "actually, not now" would leave a red error on the card. Matched on
 * the message because the shape differs per wallet — Phantom throws a
 * `{ code: 4001 }`, Solflare a plain rejection — and the wording does not.
 */
function isRejection(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /user rejected|rejected the request|declin(e|ed)|cancell?ed/i.test(message);
}

/**
 * Turn a chain failure into a sentence a player can act on.
 *
 * The two translated here are the ones a first-time setup actually hits, and
 * both are opaque as shipped: an empty wallet reports a debit against an account
 * with no prior credit, and an expired blockhash reports a missing hash. Nothing
 * else is guessed at — an unrecognised error is repeated verbatim, because a
 * wrong translation is worse than an ugly one.
 */
function describe(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/insufficient (lamports|funds)|found no record of a prior credit/i.test(message)) {
    return `This wallet has no SOL on ${CLUSTER}. Setup pays a network fee and the rent for two small accounts.`;
  }
  if (/blockhash not found|block height exceeded/i.test(message)) {
    return "The network moved on before this was signed. Try again.";
  }
  return message;
}

/**
 * Solana for the casino: an RPC connection, a wallet, and the program state
 * that hangs off the pair.
 *
 * Wraps the whole app. The invite code is still what creates an
 * account — this is a second, independent identity that a player may or may not
 * attach, and nothing below assumes both are present.
 */
export function WalletBridge({ children }: { children: ReactNode }) {
  const [connectError, setConnectError] = useState<string | null>(null);

  // Both are also discovered through the wallet-standard, and the adapter
  // de-duplicates by name — naming them explicitly is what gets an
  // install link in front of somebody who has neither.
  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
    []
  );

  const onError = useCallback((error: WalletError) => {
    setConnectError(isRejection(error) ? null : describe(error));
  }, []);

  return (
    <ConnectionProvider endpoint={RPC_URL} config={{ commitment: COMMITMENT }}>
      <WalletProvider wallets={wallets} onError={onError} autoConnect>
        {/*
          The modal's own stylesheet is not imported — it is a dark, fixed
          palette that fights the casino's tokens in light mode. WalletPicker
          renders the same list in this app's language instead. The provider
          stays because everything in wallet-adapter-react-ui expects the
          context, and an absent provider is a runtime error rather than a
          missing feature.
        */}
        <WalletModalProvider>
          <CrownWalletState connectError={connectError}>{children}</CrownWalletState>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

function CrownWalletState({
  connectError,
  children,
}: {
  connectError: string | null;
  children: ReactNode;
}) {
  const { connection } = useConnection();
  const { publicKey, connecting } = useWallet();
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The base58 string, not the PublicKey: it is what the effects below want as
  // a dependency, and a stable identity is not something the adapter promises.
  const address = publicKey?.toBase58() ?? null;

  /**
   * Reads outlive the wallet that started them — a disconnect mid-flight would
   * otherwise land a stale balance on an empty card. Every response checks it
   * is still the newest before it writes.
   */
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    if (!address) {
      setSnapshot(EMPTY);
      return;
    }
    const mine = ++generation.current;
    const owner = new PublicKey(address);
    setLoading(true);
    try {
      // One round trip for the mint, the token account and the delegation:
      // three reads that are only meaningful together, and a card assembled
      // from three separately-timed responses can show an allowance against a
      // token account it has already learned does not exist.
      // **One number: how much SOL this wallet can spend.**
      //
      // It used to read the token account, its delegate and the delegation PDA
      // as well, because the wallet was an identity the program knew about. It
      // is a payment method now — credits live on the account, not in the
      // wallet — so the only thing worth asking the chain is whether there is
      // enough SOL to buy some.
      const lamports = await connection.getBalance(owner);
      if (generation.current !== mine) return;

      setSnapshot({ sol: lamports / LAMPORTS_PER_SOL });
      setError(null);
    } catch (err) {
      if (generation.current !== mine) return;
      setError(describe(err));
    } finally {
      if (generation.current === mine) setLoading(false);
    }
  }, [address, connection]);

  useEffect(() => {
    void refresh();
    if (!address) return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [address, refresh]);



  const value = useMemo<CrownWalletValue>(
    () => ({
      address,
      connecting,
      sol: snapshot.sol,
      loading,
      error: error ?? connectError,
      refresh: () => void refresh(),
    }),
    [address, connectError, connecting, error, loading, refresh, snapshot]
  );

  return (
    <CrownWalletContext.Provider value={value}>{children}</CrownWalletContext.Provider>
  );
}
