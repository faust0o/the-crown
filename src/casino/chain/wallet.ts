import { createContext, useContext } from "react";

/**
 * What the casino knows about the connected wallet.
 *
 * One shape, read from three places — the header control, the setup card, and
 * the balance strip — so the RPC polling behind it happens once rather than
 * once per consumer. Everything is nullable because "not connected" and "not
 * fetched yet" are both ordinary states here, and the difference between them
 * is `loading`.
 */
export interface CrownWalletValue {
  /** Base58 of the connected wallet, or null when there isn't one. */
  address: string | null;
  connecting: boolean;
  /** SOL, not lamports — it pays the setup transaction's fee and rent. */
  sol: number | null;
  loading: boolean;
  /** A failed read or a failed transaction — never a user cancelling a prompt. */
  error: string | null;
  refresh: () => void;
}

export const CrownWalletContext = createContext<CrownWalletValue | null>(null);

export function useCrownWallet(): CrownWalletValue {
  const ctx = useContext(CrownWalletContext);
  if (!ctx) throw new Error("useCrownWallet must be used within a WalletBridge.");
  return ctx;
}
