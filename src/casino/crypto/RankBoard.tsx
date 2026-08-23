import { useEffect, useRef, useState } from "react";
import { formatCompact } from "../format";
import { CoinIcon } from "./CoinIcon";
import { formatPrice } from "./format";
import type { Direction, Entry, Line, Standing } from "./graphql";

const ROW_H = 76; // px — rows are absolutely positioned so reordering can animate

const TONE: Record<Direction, { label: string; color: string }> = {
  HIGHER: { label: "Higher", color: "var(--up)" },
  DRAW: { label: "Same", color: "var(--gold)" },
  LOWER: { label: "Lower", color: "var(--down)" },
};

/**
 * The competing field, ordered by trailing-window volume, with the round's
 * three-way book on each row.
 *
 * Rows are keyed by symbol and positioned with `translateY`, so when the oracle
 * reorders them React keeps the same DOM node and CSS slides it to its new slot.
 * That's a FLIP animation without any measuring — the browser interpolates the
 * transform for free.
 */
export function RankBoard({
  standings,
  entries,
  selected,
  onSelect,
  window,
}: {
  standings: Standing[];
  entries: Map<string, Entry>;
  selected: string | null;
  /** Selecting a coin fills the ticket; a price chip also preselects its side. */
  onSelect: (symbol: string, direction?: Direction) => void;
  window: string;
}) {
  // Totals across the whole board, so the header states the size of the race.
  const totalVolume = standings.reduce((n, s) => n + s.quoteVolume, 0);
  const totalTrades = standings.reduce((n, s) => n + s.trades1h, 0);

  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-hairline bg-surface">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-hairline px-4 py-2.5">
        <h2 className="text-sm font-semibold text-foreground">
          The Field
          <span className="ml-2 font-mono text-xs font-normal tabular-nums text-secondary">
            ${formatCompact(totalVolume)}
          </span>
          <span className="ml-2 font-mono text-xs font-normal tabular-nums text-secondary">
            {formatCompact(totalTrades)} tx
          </span>
        </h2>
        <span className="shrink-0 text-[11px] uppercase tracking-wider text-muted">
          volume · trailing {window}
        </span>
      </div>
      <ol
        className="relative m-0 list-none p-2"
        style={{ height: standings.length * ROW_H + 8 }}
      >
        {standings.map((s, slot) => (
          <RankRow
            key={s.symbol}
            standing={s}
            slot={slot}
            entry={entries.get(s.symbol)}
            selected={s.symbol === selected}
            onSelect={onSelect}
          />
        ))}
      </ol>
    </div>
  );
}

function RankRow({
  standing: s,
  slot,
  entry,
  selected,
  onSelect,
}: {
  standing: Standing;
  /**
   * Which row this is, counting from the top — not the coin's rank.
   *
   * They used to be the same number and the row was placed at `rank - 1`, which
   * worked only while the board was exactly the visible ten. It is not: a coin
   * that has dropped out stands below the last slot, so it was translated past
   * the bottom of the list and clipped away — the row existed and could not be
   * seen — and any two coins that had dropped shared a rank and so were drawn
   * one on top of the other. Position comes from the ordering, the rank is a
   * label, and the two are allowed to disagree.
   */
  slot: number;
  entry: Entry | undefined;
  selected: boolean;
  onSelect: (symbol: string, direction?: Direction) => void;
}) {
  const moved = useRankFlash(s.rank);
  // Movement is measured against where the coin started the round — that's what
  // the bet actually resolves on, not the 60s-ago rank.
  const from = entry?.startRank ?? s.previousRank;
  const delta = from == null ? 0 : from - s.rank;

  return (
    <li
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={() => onSelect(s.symbol)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(s.symbol);
        }
      }}
      className={`absolute inset-x-2 flex cursor-pointer items-center gap-3 overflow-hidden rounded-md px-2 ${
        selected ? "ring-2 ring-accent" : ""
      }`}
      style={{
        height: ROW_H - 4,
        transform: `translateY(${slot * ROW_H}px)`,
        backgroundColor:
          moved === "up"
            ? "color-mix(in oklch, var(--up) 14%, transparent)"
            : moved === "down"
              ? "color-mix(in oklch, var(--down) 14%, transparent)"
              : "transparent",
        transitionProperty: "transform, background-color",
        transitionDuration: "520ms, 900ms",
        transitionTimingFunction: "cubic-bezier(0.22, 1, 0.36, 1)",
      }}
    >
      {/* One fixed box for every row: an emoji's side bearings differ from a
          digit's, so right-aligning both left the crown off the number column.
          Centring the box aligns "1", "10" and the crown alike. */}
      <span
        className="grid w-6 shrink-0 place-items-center font-mono text-lg tabular-nums leading-none text-muted"
        title={entry?.isCrown ? "Wearing the crown" : undefined}
      >
        {entry?.isCrown ? (
          <span aria-label="wearing the crown" className="text-base leading-none">
            👑
          </span>
        ) : (
          s.rank
        )}
      </span>
      <span
        aria-hidden="true"
        className="w-3 shrink-0 text-xs"
        style={{ color: delta > 0 ? "var(--up)" : delta < 0 ? "var(--down)" : "transparent" }}
      >
        {delta > 0 ? "▲" : delta < 0 ? "▼" : "•"}
      </span>
      <CoinIcon ticker={s.ticker} src={s.imageUrl} size={28} />

      <span className="min-w-0 flex-1">
        <span className="block truncate font-semibold text-foreground">{s.ticker}</span>
        <span className="block truncate font-mono text-[11px] tabular-nums text-muted">
          ${formatCompact(s.quoteVolume)} · {formatPrice(s.price)}
        </span>
      </span>

      <span className="flex shrink-0 items-center gap-1.5">
        {!entry ? (
          <span className="w-[234px] shrink-0 text-right text-[11px] leading-tight text-muted">
            Climbed onto the board after this round opened — in from the next one.
          </span>
        ) : entry.isCrown ? (
          <span
            title="Wearing the crown — the reigning token can't be backed. Win it by finishing first."
            className="w-[234px] shrink-0 cursor-help text-right text-[11px] text-muted"
          >
            crown — no book
          </span>
        ) : (
          entry.lines.map((line) => (
          <PriceChip
            key={line.direction}
            line={line}
            symbol={s.symbol}
            onSelect={onSelect}
          />
          ))
        )}
      </span>
    </li>
  );
}

/**
 * A price, not a position. Deliberately identical whether or not you hold this
 * side — the board reads as a market, and the ticket is where your own stake
 * belongs.
 */
function PriceChip({
  line,
  symbol,
  onSelect,
}: {
  line: Line;
  symbol: string;
  onSelect: (symbol: string, direction?: Direction) => void;
}) {
  const tone = TONE[line.direction];
  const disabled = !line.available;

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation(); // the row's own click would drop the side
        onSelect(symbol, line.direction);
      }}
      title={
        line.available
          ? `${tone.label} — ${line.cents}¢, pays ${line.multiplier.toFixed(2)}x`
          : `${tone.label} is impossible from this rank`
      }
      className="w-[74px] shrink-0 rounded-md border px-2 py-1.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-40"
      style={{
        borderColor: `color-mix(in oklch, ${tone.color} 35%, transparent)`,
        backgroundColor: `color-mix(in oklch, ${tone.color} 7%, transparent)`,
      }}
    >
      <span className="block text-[10px] font-semibold uppercase tracking-wide" style={{ color: tone.color }}>
        {tone.label}
      </span>
      <span className="block font-mono text-xs tabular-nums text-foreground">
        {line.available ? `${line.cents}¢` : "—"}
        {line.available && (
          <span className="ml-1 text-[10px] text-muted">{line.multiplier.toFixed(1)}x</span>
        )}
      </span>
    </button>
  );
}

/** Flash "up"/"down" for a moment whenever the rank changes. */
function useRankFlash(rank: number): "up" | "down" | null {
  const prev = useRef(rank);
  const [flash, setFlash] = useState<"up" | "down" | null>(null);

  useEffect(() => {
    if (prev.current === rank) return;
    setFlash(rank < prev.current ? "up" : "down");
    prev.current = rank;
    const id = setTimeout(() => setFlash(null), 900);
    return () => clearTimeout(id);
  }, [rank]);

  return flash;
}
