import { useEffect, useState } from "react";
import { CoinIcon } from "./CoinIcon";
import { Button, Dialog } from "../ui";
import type { CryptoBet } from "./graphql";

const LABEL: Record<string, string> = {
  HIGHER: "Higher",
  DRAW: "Same",
  LOWER: "Lower",
};

/** Count from 0 to `to` on mount, so a payout lands rather than appears. */
function useCountUp(to: number, ms = 900): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (to <= 0) return setN(0);
    const start = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / ms);
      // Ease-out so it decelerates into the final figure.
      setN(Math.round(to * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [to, ms]);
  return n;
}

/**
 * Shown once per settled bet.
 *
 * Payouts are credited server-side the moment a round settles, so this isn't a
 * claim step — it's the receipt. Without it a balance simply changed while you
 * were looking elsewhere, and a win felt like nothing happened.
 */
export function BetResult({
  bet,
  imageUrl,
  onDismiss,
}: {
  bet: CryptoBet | null;
  imageUrl: string | null;
  onDismiss: () => void;
}) {
  const won = bet?.status === "WON";
  const profit = bet ? bet.payout - bet.stake : 0;
  const shown = useCountUp(bet ? Math.abs(profit) : 0);

  if (!bet) return null;

  const moved =
    bet.cutRank == null
      ? "—"
      : bet.cutRank < bet.startRank
        ? "climbed"
        : bet.cutRank > bet.startRank
          ? "slipped"
          : "held";

  return (
    <Dialog
      open
      onClose={onDismiss}
      alert
      elevated
      label={won ? "Bet won" : "Bet settled"}
      className={won ? "casino-result-in mat-won" : "casino-result-in"}
      bodyClassName="p-6 text-center"
    >
      {won && <Rays />}

      <div className="relative">
        <div className="casino-result-pop mx-auto mb-3 w-fit">
          <CoinIcon ticker={bet.ticker} src={imageUrl} size={44} />
        </div>

        <div
          className="text-xs font-semibold uppercase tracking-[0.18em]"
          style={{ color: won ? "var(--up)" : "var(--text-muted)" }}
        >
          {won ? "Bet won" : "Bet lost"}
        </div>

        <div className="mt-2 font-mono text-4xl tabular-nums text-foreground">
          {won ? "+" : "−"}
          {shown.toLocaleString()}
        </div>
        <div className="text-xs text-muted">credits</div>

        <p className="mt-4 text-sm text-secondary">
          {bet.ticker} {moved} from rank {bet.startRank} to {bet.cutRank ?? "—"}. You
          backed <span className="font-semibold">{LABEL[bet.direction]}</span> at{" "}
          {bet.odds.toFixed(2)}x.
        </p>

        <Button variant="glass" size="lg" block onClick={onDismiss} className="mt-5">
          {won ? "Collect" : "Next round"}
        </Button>
      </div>
    </Dialog>
  );
}

/** Radial burst behind a win. Purely decorative. */
function Rays() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      {Array.from({ length: 12 }, (_, i) => (
        <span
          key={i}
          className="casino-ray absolute left-1/2 top-[64px] block h-[140px] w-[2px] origin-top"
          style={{
            transform: `rotate(${i * 30}deg)`,
            background:
              "linear-gradient(to bottom, color-mix(in oklch, var(--up) 45%, transparent), transparent)",
            animationDelay: `${i * 28}ms`,
          }}
        />
      ))}
    </div>
  );
}
