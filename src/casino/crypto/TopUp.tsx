import { useCallback, useEffect, useMemo, useState } from "react";
import { confirmSignature } from "../chain/confirm";
import { Transaction } from "@solana/web3.js";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useCrownWallet } from "../chain/wallet";
import { ConnectWalletButton } from "./WalletButton";
import { confirmCreditPurchase, prepareCreditPurchase } from "../chain/setup";
import { formatCredits } from "../format";
import { Button, Dialog, Input, Label, Readout, Section } from "../ui";

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
      <Section title="Top up" bodyClassName="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">
            Swap SOL for credits
          </div>
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

          Metal rather than the lit glass: it stands in the same slot as the
          wallet control it replaces, so a different material here read as a
          different *kind* of control rather than as emphasis.
        */}
        {address ? (
          <Button size="sm" onClick={() => setOpen(true)}>
            Add credits
          </Button>
        ) : (
          <ConnectWalletButton />
        )}
      </Section>

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

  // Base58 rather than the PublicKey, because it is what the quote is keyed on
  // below and the adapter does not promise a stable object identity.
  const owner = publicKey?.toBase58() ?? null;

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
    if (lamports == null || owner == null) {
      setQuote(null);
      return;
    }
    let cancelled = false;
    setQuoting(true);
    const timer = setTimeout(() => {
      prepareCreditPurchase(lamports.toString(), owner)
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
  }, [lamports, owner]);

  const buy = useCallback(async () => {
    if (owner == null || lamports == null) return;
    setBusy(true);
    setError(null);
    try {
      // Re-quoted immediately before signing rather than reusing the debounced
      // one: that quote is up to a few seconds old, and its blockhash ages out.
      // The player sees the same figure either way — the rate is cached for a
      // minute server-side — but the transaction is fresh.
      const prepared = await prepareCreditPurchase(lamports.toString(), owner);
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
  }, [connection, lamports, onClose, owner, refresh, sendTransaction]);

  return (
    <Dialog
      open
      onClose={onClose}
      title="Add credits"
      footer={
        <p className="m-0 text-[11px] leading-relaxed text-muted">
          One transfer, signed by your wallet: the SOL goes to the house, and the
          credits arrive once the server has read that payment off the chain. You
          pay the network fee. The payment is claimed by its signature, so it can
          only ever credit once — and a confirmation that goes astray on the way
          back still credits you when you return.
        </p>
      }
    >
      <Label htmlFor="topup-sol">You pay</Label>
      <div className="mt-1 flex items-center gap-2">
        <Input
          id="topup-sol"
          type="number"
          min="0"
          step="0.01"
          value={sol}
          onChange={(e) => setSol(e.target.value)}
          className="min-w-0 flex-1 py-1.5 font-mono tabular-nums"
        />
        <span className="shrink-0 font-mono text-sm text-muted">SOL</span>
      </div>

      <div className="mt-2 flex gap-1.5">
        {PRESETS.map((p) => (
          <Button
            key={p}
            size="xs"
            onClick={() => setSol(String(p))}
            className="font-mono tabular-nums"
          >
            {p}
          </Button>
        ))}
      </div>

      <Readout
        className="mt-4"
        inset
        size="lg"
        label="You receive"
        value={quoting ? "…" : quote ? formatCredits(quote.credits) : "—"}
        hint={quote ? `at $${quote.solPriceUsd.toFixed(2)} / SOL` : undefined}
      />

      {solBalance != null && (
        <div className="mt-2 font-mono text-[11px] text-muted">
          wallet holds {solBalance.toFixed(4)} SOL
        </div>
      )}

      {tooMuch && (
        <div className="mt-2 text-xs text-down">That is more SOL than the wallet holds.</div>
      )}
      {error && <div className="mt-2 text-xs text-down">{error}</div>}

      <Button
        variant="glass"
        side="buy"
        size="lg"
        block
        className="mt-4"
        disabled={busy || quoting || !quote || tooMuch || lamports == null}
        onClick={() => void buy()}
      >
        {busy ? "Confirming…" : quote ? `Buy ${formatCredits(quote.credits)}` : "Enter an amount"}
      </Button>
    </Dialog>
  );
}
