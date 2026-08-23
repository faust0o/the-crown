import { useState } from "react";
import { formatCompact, formatCredits } from "../format";
import { CoinIcon } from "./CoinIcon";
import { Marquee } from "./Marquee";
import type { CryptoBet, Direction, Entry, Standing } from "./graphql";

const STAKES = [25, 50, 100, 250] as const;

const TONE: Record<Direction, { label: string; blurb: string; color: string }> = {
  HIGHER: { label: "Higher", blurb: "climbs the board", color: "var(--up)" },
  DRAW: { label: "Same", blurb: "holds its rank", color: "var(--gold)" },
  LOWER: { label: "Lower", blurb: "slips down", color: "var(--down)" },
};

/**
 * Ticket for the selected coin.
 *
 * Every line is a claim about where this coin's *rank* lands at the cut,
 * relative to where it started the round — not about price. Rank is zero-sum
 * across the field, which is what stops "everything goes up" being a strategy.
 */
export function BetPanel({
  standing,
  entry,
  bets,
  bettable,
  disabledReason,
  direction,
  onDirection,
  busy,
  credits,
  onPlace,
  onClose,
  closing,
}: {
  standing: Standing | null;
  entry: Entry | null;
  bets: CryptoBet[];
  bettable: boolean;
  disabledReason: string | null;
  direction: Direction;
  onDirection: (d: Direction) => void;
  busy: boolean;
  credits: number | null;
  onPlace: (stake: number) => void;
  /** Close an open position at its current quote. */
  onClose: (id: string) => void;
  closing: string | null;
}) {
  const [stake, setStake] = useState<number>(50);

  /** Chips stack, so four taps on +25 is a hundred. Never past what you hold. */
  const ceiling = credits == null ? null : Math.max(0, Math.floor(credits));
  const addStake = (n: number) =>
    setStake((s) => (ceiling == null ? s + n : Math.min(s + n, ceiling)));

  if (!standing || !entry) {
    return (
      <div className="rounded-lg border border-hairline bg-surface p-6 text-center text-sm text-muted">
        Pick a coin from the board to place a bet.
      </div>
    );
  }

  const line = entry.lines.find((l) => l.direction === direction);
  const crowned = entry.isCrown;
  const moved = standing.rank - entry.startRank;
  const canPlace =
    bettable && !busy && Boolean(line?.available) && stake > 0 && (credits ?? 0) >= stake;

  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-hairline bg-surface">
      <div className="flex items-center gap-3 border-b border-hairline px-4 py-3">
        <CoinIcon ticker={standing.ticker} src={standing.imageUrl} size={32} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-2 text-sm font-semibold text-foreground">
            <span className="shrink-0">{standing.ticker}</span>
            <Marquee text={standing.name} className="min-w-0 flex-1 font-normal text-muted" />
          </div>
          <div className="font-mono text-[11px] tabular-nums text-muted">
            rank {entry.startRank} → {standing.rank}
            {moved !== 0 && (
              <span style={{ color: moved < 0 ? "var(--up)" : "var(--down)" }}>
                {" "}
                {moved < 0 ? "▲" : "▼"} {Math.abs(moved)}
              </span>
            )}
            {" · $"}
            {formatCompact(standing.quoteVolume)}
          </div>
        </div>
      </div>

      {crowned && (
        <div
          title="The reigning token can't be backed. Win the crown by finishing first."
          className="cursor-help border-b border-hairline px-4 py-2.5 text-sm text-gold"
        >
          Wearing the crown — no book this round.
        </div>
      )}

      <div className="grid grid-cols-3 gap-1.5 p-3">
        {entry.lines.map((l) => {
          const tone = TONE[l.direction];
          const active = l.direction === direction;
          return (
            <button
              key={l.direction}
              type="button"
              disabled={!l.available}
              onClick={() => onDirection(l.direction)}
              className="rounded-md border px-2 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-40"
              style={{
                borderColor: active
                  ? tone.color
                  : `color-mix(in oklch, ${tone.color} 30%, transparent)`,
                backgroundColor: active
                  ? `color-mix(in oklch, ${tone.color} 16%, transparent)`
                  : "transparent",
              }}
            >
              <span
                className="block text-[10px] font-semibold uppercase tracking-wide"
                style={{ color: tone.color }}
              >
                {tone.label}
              </span>
              <span className="block font-mono text-sm tabular-nums text-foreground">
                {l.available ? `${l.cents}¢` : "—"}
              </span>
              <span className="block font-mono text-[10px] tabular-nums text-muted">
                {l.available ? `${l.multiplier.toFixed(2)}x` : "n/a"}
              </span>
            </button>
          );
        })}
      </div>

      {!crowned && (
        <p className="px-4 pb-3 text-xs text-secondary">
          {standing.ticker} {TONE[direction].blurb} by the cut, against its rank of{" "}
          {entry.startRank} at the open.
        </p>
      )}

      <div className="border-t border-hairline p-3">
        <div className="mb-2 flex items-center gap-1.5">
          {STAKES.map((s) => (
            <button
              key={s}
              type="button"
              disabled={ceiling != null && stake >= ceiling}
              onClick={() => addStake(s)}
              aria-label={`Add $${s} to the stake`}
              className="flex-1 rounded border border-hairline px-2 py-1 font-mono text-xs tabular-nums text-muted transition-colors hover:border-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-hairline disabled:hover:text-muted"
            >
              +{s}
            </button>
          ))}
          <button
            type="button"
            disabled={!ceiling || stake >= ceiling}
            onClick={() => ceiling != null && setStake(ceiling)}
            title="Stake every credit you hold"
            className="flex-1 rounded border border-hairline px-2 py-1 font-mono text-xs uppercase tabular-nums text-muted transition-colors hover:border-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-hairline disabled:hover:text-muted"
          >
            Max
          </button>
        </div>
        <div className="relative mb-2">
          <input
            type="number"
            min={1}
            step={1}
            value={stake}
            onChange={(e) => setStake(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
            aria-label="Stake in dollars"
            className="w-full rounded border border-hairline bg-inset py-1.5 pl-14 pr-2 text-right font-mono text-sm tabular-nums text-foreground outline-none focus:border-accent"
          />
          {stake > 0 && (
            <button
              type="button"
              onClick={() => setStake(0)}
              className="absolute inset-y-0 left-1.5 my-auto h-5 rounded px-1.5 text-[10px] uppercase tracking-wide text-muted transition-colors hover:text-foreground"
            >
              Clear
            </button>
          )}
        </div>

        <div className="mb-3 flex items-baseline justify-between font-mono text-xs tabular-nums">
          <span className="text-muted">to win</span>
          <span className="text-foreground">
            {line?.available ? formatCredits(stake * line.multiplier) : "—"}
          </span>
        </div>

        <button
          type="button"
          disabled={!canPlace}
          onClick={() => onPlace(stake)}
          className="w-full rounded-md bg-accent px-3 py-2 text-sm font-semibold text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "Placing…" : `Bet ${stake} on ${TONE[direction].label}`}
        </button>
        {!canPlace && (
          <p className="mt-2 text-center text-[11px] text-muted">
            {crowned
              ? "The reigning coin can't be bet on."
              : (disabledReason ??
                ((credits ?? 0) < stake ? "Not enough balance." : "Unavailable for this coin."))}
          </p>
        )}
      </div>

      {bets.length > 0 && (
        <div className="border-t border-hairline px-4 py-3">
          <div className="mb-1.5 text-[10px] uppercase tracking-wider text-muted">
            your position
          </div>
          <ul className="m-0 list-none space-y-1.5 p-0">
            {bets.map((b) => {
              const tone = TONE[b.direction];
              const value = b.liveValue;
              const pnl = value == null ? null : value - b.stake;
              return (
                <li key={b.id} className="flex items-center gap-2">
                  <span
                    className="w-12 shrink-0 font-mono text-[11px]"
                    style={{ color: tone.color }}
                  >
                    {tone.label}
                  </span>
                  <span className="min-w-0 flex-1 font-mono text-[11px] tabular-nums text-muted">
                    {formatCredits(b.stake)} @ {b.odds.toFixed(2)}x
                  </span>
                  {value != null && (
                    <span
                      className="shrink-0 font-mono text-[11px] tabular-nums"
                      style={{
                        color:
                          pnl! > 0 ? "var(--up)" : pnl! < 0 ? "var(--down)" : "var(--text-muted)",
                      }}
                      title="What closing this position pays right now, priced at this position's size"
                    >
                      {formatCredits(value)}
                    </span>
                  )}
                  <button
                    type="button"
                    disabled={value == null || closing === b.id}
                    onClick={() => onClose(b.id)}
                    title={
                      value == null
                        ? "Only open positions can be closed"
                        : `Close for ${formatCredits(value)}`
                    }
                    className="shrink-0 rounded border border-hairline px-1.5 py-0.5 text-[10px] text-secondary transition-colors hover:text-foreground disabled:opacity-40"
                  >
                    {closing === b.id ? "…" : "Close"}
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="mt-1.5 text-[10px] leading-snug text-muted">
            Closing pays the current quote — it moves with the coin's rank and
            tightens as the cut approaches.
          </p>
        </div>
      )}
    </div>
  );
}
