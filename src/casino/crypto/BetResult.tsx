import { useEffect, useMemo, useRef, useState } from "react";
import { CoinIcon } from "./CoinIcon";
import { Confetti } from "./Confetti";
import { Button, Dialog } from "../ui";
import type { CryptoBet } from "./graphql";
import { PositionBubbles, type Bubble } from "./PositionBubbles";

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
 * One coin and direction in one round — what a player thinks of as a position.
 * Lots bought on the same line at different times settle together, so they're
 * summed here rather than shown as a stack of identical coins.
 */
interface Position {
  key: string;
  symbol: string;
  ticker: string;
  direction: CryptoBet["direction"];
  startRank: number;
  cutRank: number | null;
  stake: number;
  payout: number;
  /** Stake-weighted, so a big lot's price counts for more than a small one's. */
  odds: number;
  won: boolean;
}

function positions(bets: CryptoBet[]): Position[] {
  const byLine = new Map<string, Position>();
  for (const b of bets) {
    const key = `${b.roundId}:${b.symbol}:${b.direction}`;
    const p = byLine.get(key);
    if (!p) {
      byLine.set(key, {
        key,
        symbol: b.symbol,
        ticker: b.ticker,
        direction: b.direction,
        startRank: b.startRank,
        cutRank: b.cutRank,
        stake: b.stake,
        payout: b.payout,
        odds: b.odds,
        won: b.status === "WON",
      });
      continue;
    }
    p.odds = (p.odds * p.stake + b.odds * b.stake) / (p.stake + b.stake);
    p.stake += b.stake;
    p.payout += b.payout;
  }
  return [...byLine.values()];
}

/**
 * Shown once per settlement — every position it closed, together.
 *
 * Payouts are credited server-side the moment a round settles, so this isn't a
 * claim step — it's the receipt. Without it a balance simply changed while you
 * were looking elsewhere, and a win felt like nothing happened.
 *
 * One position gets its coin; several get a bubble each, sized by stake, so the
 * one that carried the round is the one you see first.
 */
export function BetResult({
  bets,
  imageUrl,
  onDismiss,
}: {
  bets: CryptoBet[] | null;
  imageUrl: (symbol: string) => string | null;
  onDismiss: () => void;
}) {
  const held = useMemo(() => positions(bets ?? []), [bets]);
  const staked = held.reduce((n, p) => n + p.stake, 0);
  const paid = held.reduce((n, p) => n + p.payout, 0);
  const profit = paid - staked;
  // A win that still left the round down overall isn't one to celebrate.
  const won = held.some((p) => p.won) && profit >= 0;
  const shown = useCountUp(Math.abs(profit));
  const anchor = useRef<HTMLDivElement | null>(null);

  const bubbles = useMemo<Bubble[]>(
    () =>
      held.map((p) => ({
        key: p.key,
        ticker: p.ticker,
        imageUrl: imageUrl(p.symbol),
        stake: p.stake,
        won: p.won,
        label: `${p.ticker} ${LABEL[p.direction]}, ${p.stake.toLocaleString()} staked, ${
          p.won ? `won ${p.payout.toLocaleString()}` : "lost"
        }`,
      })),
    [held, imageUrl]
  );

  if (!held.length) return null;

  const single = held.length === 1 ? held[0] : null;
  const wins = held.filter((p) => p.won).length;
  const kicker = single
    ? won
      ? "Bet won"
      : "Bet lost"
    : wins === held.length
      ? `All ${held.length} bets won`
      : wins === 0
        ? `${held.length} bets lost`
        : `${wins} of ${held.length} bets won`;

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
      {won && <Confetti origin={anchor} />}

      <div ref={anchor} className="mx-auto mb-3 w-fit">
        {single ? (
          <div className="casino-result-pop">
            <CoinIcon ticker={single.ticker} src={imageUrl(single.symbol)} size={44} />
          </div>
        ) : (
          <PositionBubbles bubbles={bubbles} />
        )}
      </div>

      <div
        className="text-xs font-semibold uppercase tracking-[0.18em]"
        style={{ color: won ? "var(--up)" : "var(--text-muted)" }}
      >
        {kicker}
      </div>

      <div className="mt-2 font-mono text-4xl tabular-nums text-foreground">
        {profit >= 0 ? "+" : "−"}
        {shown.toLocaleString()}
      </div>
      <div className="text-xs text-muted">credits</div>

      <p className="mt-4 text-sm text-secondary">
        {single ? (
          <>
            {single.ticker} {moved(single)} from rank {single.startRank} to{" "}
            {single.cutRank ?? "—"}. You backed{" "}
            <span className="font-semibold">{LABEL[single.direction]}</span> at{" "}
            {single.odds.toFixed(2)}x.
          </>
        ) : (
          <>
            {staked.toLocaleString()} staked across {held.length} positions,{" "}
            {paid.toLocaleString()} paid out.
          </>
        )}
      </p>

      <Button variant="glass" size="lg" block onClick={onDismiss} className="mt-5">
        {won ? "Collect" : "Next round"}
      </Button>
    </Dialog>
  );
}

function moved(p: Position): string {
  if (p.cutRank == null) return "—";
  if (p.cutRank < p.startRank) return "climbed";
  if (p.cutRank > p.startRank) return "slipped";
  return "held";
}
