import { useCallback, useEffect, useMemo, useState } from "react";
import { confirmSignature } from "../chain/confirm";
import { Transaction } from "@solana/web3.js";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useCrownWallet } from "../chain/wallet";
import { WalletButton } from "./WalletButton";
import { confirmCreditPurchase, prepareCreditPurchase } from "../chain/setup";
import { formatCredits } from "../format";

/**
 * Buying credits with SOL.
 *
 * The card is the whole of the top-up affordance, and it is on the portfolio
 * because that is where somebody goes to find out what they have. The previous
 * arrangement put a wall of explanation about allowances and relayers in front
 * of a player who wanted to add money — true, and none of it what they came to
 * do.
 *
 * ## What the dialog is careful about
 *
 * The amount is entered in SOL because that is what the wallet holds and what
 * the prompt will show. The credits are quoted by the server, not computed here:
 * a client that decides what its own money is worth is a client that can mint,
 * and the number in the wallet prompt has to be the number the server signed.
 *
 * So the quote is fetched, the rate shown, and the transaction that comes back
 * already contains the result. What the player approves is what they get.
 */

const LAMPORTS = 1_000_000_000;

/** Amounts people actually pick, rather than a slider nobody can hit exactly. */
const PRESETS = [0.1, 0.25, 0.5, 1];

export function TopUpCard({ credits }: { credits: number | null }) {
  const [open, setOpen] = useState(false);
  const { sol, address } = useCrownWallet();

  return (
    <>
      <div className="flex flex-col gap-3 rounded-lg border border-hairline bg-surface p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">Top up your balance</div>
          <div className="mt-0.5 text-xs text-muted">
            {!address
              ? "Connect a wallet to swap SOL for credits."
              : credits != null && credits > 0
                ? `You have ${formatCredits(credits)}. Swap SOL for more.`
                : "Swap SOL for credits to start betting."}
          </div>
        </div>
        {/*
          Always here, whether or not a wallet is attached. The card used to
          hide until the wallet had been through a delegation setup, which meant
          the one control for putting money in was invisible to exactly the
          person who had none — and visible only after a flow whose whole purpose
          was to reach it.
        */}
        {address ? (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="shrink-0 rounded-md bg-accent px-4 py-2 text-sm font-medium text-on-accent transition-opacity hover:opacity-90"
          >
            Add credits
          </button>
        ) : (
          <WalletButton />
        )}
      </div>

      {open && (
        <TopUpDialog onClose={() => setOpen(false)} solBalance={sol} />
      )}
    </>
  );
}

function TopUpDialog({
  onClose,
  solBalance,
}: {
  onClose: () => void;
  solBalance: number | null;
}) {
  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const { refresh } = useCrownWallet();

  const [sol, setSol] = useState("0.25");
  const [quote, setQuote] = useState<{ credits: number; solPriceUsd: number } | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lamports = useMemo(() => {
    const n = Number(sol);
    if (!Number.isFinite(n) || n <= 0) return null;
    return BigInt(Math.floor(n * LAMPORTS));
  }, [sol]);

  const tooMuch = lamports != null && solBalance != null && Number(lamports) / LAMPORTS > solBalance;

  /**
   * Re-quote as the amount changes, debounced.
   *
   * Debounced rather than quoted per keystroke because each one is a rate lookup
   * on the server, and a player typing "0.25" would otherwise ask three times for
   * a number they were still in the middle of writing.
   */
  useEffect(() => {
    if (lamports == null) {
      setQuote(null);
      return;
    }
    let cancelled = false;
    setQuoting(true);
    const timer = setTimeout(() => {
      prepareCreditPurchase(lamports.toString())
        .then((q) => {
          if (cancelled) return;
          setQuote({ credits: q.credits, solPriceUsd: q.solPriceUsd });
          setError(null);
        })
        .catch((err: Error) => {
          if (cancelled) return;
          setQuote(null);
          setError(err.message);
        })
        .finally(() => !cancelled && setQuoting(false));
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [lamports]);

  const buy = useCallback(async () => {
    if (!publicKey || lamports == null) return;
    setBusy(true);
    setError(null);
    try {
      // Re-quoted immediately before signing rather than reusing the debounced
      // one: that quote is up to a few seconds old, and its blockhash ages out.
      // The player sees the same figure either way — the rate is cached for a
      // minute server-side — but the transaction is fresh.
      const prepared = await prepareCreditPurchase(lamports.toString());
      const tx = Transaction.from(
        Uint8Array.from(atob(prepared.transaction), (c) => c.charCodeAt(0))
      );
      // The buyer pays their own fee here, which is the one transaction in this
      // game where that is the natural arrangement: they are spending their own
      // SOL, so there is nothing for the house to co-sign.
      const signature = await sendTransaction(tx, connection);
      await confirmSignature(connection, {
          signature,
          blockhash: prepared.blockhash,
          lastValidBlockHeight: prepared.lastValidBlockHeight,
      });

      // The chain has the payment; the account does not have the credits until
      // the server has read that transaction back. Only the signature crosses —
      // what it was worth is the server's to determine, or this would be a
      // request to be credited rather than a purchase.
      await confirmCreditPurchase(signature);
      await refresh();
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Backing out of the wallet prompt is not an error worth a red box.
      if (!/user rejected|cancell?ed|denied/i.test(message)) setError(message);
    } finally {
      setBusy(false);
    }
  }, [connection, lamports, onClose, publicKey, refresh, sendTransaction]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Add credits"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-lg border border-hairline bg-surface p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="m-0 text-sm font-medium text-foreground">Add credits</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-muted transition-colors hover:text-foreground"
          >
            ✕
          </button>
        </div>

        <label className="block text-[10px] uppercase tracking-wider text-muted" htmlFor="topup-sol">
          You pay
        </label>
        <div className="mt-1 flex items-center gap-2">
          <input
            id="topup-sol"
            type="number"
            min="0"
            step="0.01"
            value={sol}
            onChange={(e) => setSol(e.target.value)}
            className="min-w-0 flex-1 rounded border border-hairline bg-inset px-2 py-1.5 font-mono text-sm tabular-nums text-foreground"
          />
          <span className="shrink-0 font-mono text-sm text-muted">SOL</span>
        </div>

        <div className="mt-2 flex gap-1.5">
          {PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setSol(String(p))}
              className="rounded border border-hairline px-2 py-0.5 font-mono text-[11px] text-secondary transition-colors hover:text-foreground"
            >
              {p}
            </button>
          ))}
        </div>

        <div className="mt-4 rounded border border-hairline bg-inset px-3 py-2.5">
          <div className="text-[10px] uppercase tracking-wider text-muted">You receive</div>
          <div className="font-mono text-xl tabular-nums text-foreground">
            {quoting ? "…" : quote ? formatCredits(quote.credits) : "—"}
          </div>
          {quote && (
            <div className="mt-0.5 font-mono text-[11px] text-muted">
              at ${quote.solPriceUsd.toFixed(2)} / SOL
            </div>
          )}
        </div>

        {solBalance != null && (
          <div className="mt-2 font-mono text-[11px] text-muted">
            wallet holds {solBalance.toFixed(4)} SOL
          </div>
        )}

        {tooMuch && (
          <div className="mt-2 text-xs text-down">That is more SOL than the wallet holds.</div>
        )}
        {error && <div className="mt-2 text-xs text-down">{error}</div>}

        <button
          type="button"
          disabled={busy || quoting || !quote || tooMuch || lamports == null}
          onClick={() => void buy()}
          className="mt-4 w-full rounded-md bg-accent px-4 py-2 text-sm font-medium text-on-accent transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {busy ? "Confirming…" : quote ? `Buy ${formatCredits(quote.credits)}` : "Enter an amount"}
        </button>

        <p className="mt-3 mb-0 text-[11px] leading-relaxed text-muted">
          One transfer, signed by your wallet: the SOL goes to the house, and the
          credits arrive once the server has read that payment off the chain. You
          pay the network fee. The payment is claimed by its signature, so it can
          only ever credit once — and a confirmation that goes astray on the way
          back still credits you when you return.
        </p>
      </div>
    </div>
  );
}
