import { useEffect, useRef, useState } from "react";
import { formatCompact } from "../format";
import { Chip, Section, TONE_COLOR, type Tone } from "../ui";
import { MoveArrow, RankedCoin } from "./CoinIcon";
import { formatPrice } from "./format";
import type { Direction, Entry, Line, Standing } from "./graphql";

/**
 * A row's pitch. Rows are absolutely positioned so reordering can animate, so
 * the list has to know how tall each one is — and it is a CSS variable rather
 * than a constant because a phone's rows are shorter: their chips carry a price
 * and no caption, the captions standing once over the columns instead.
 */
const ROW_H = "var(--row-h)";

const TONE: Record<Direction, { label: string; tone: Tone }> = {
  HIGHER: { label: "Higher", tone: "up" },
  DRAW: { label: "Same", tone: "gold" },
  LOWER: { label: "Lower", tone: "down" },
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
}: {
  standings: Standing[];
  entries: Map<string, Entry>;
  selected: string | null;
  /** Selecting a coin fills the ticket; a price chip also preselects its side. */
  onSelect: (symbol: string, direction?: Direction) => void;
}) {
  // Totals across the whole board, so the header states the size of the race.
  const totalVolume = standings.reduce((n, s) => n + s.quoteVolume, 0);
  const totalTrades = standings.reduce((n, s) => n + s.trades1h, 0);

  return (
    <Section
      title="The Field"
      className="mt-0.5"
      aside={
        <span className="font-mono tabular-nums">
          ${formatCompact(totalVolume)} · {formatCompact(totalTrades)} tx
        </span>
      }
    >
      {/*
        What to do with the board, wherever the ticket is not on screen beside
        it to say so — and on a phone, what the columns are. Each chip there is
        only its price (three captions per row, ten rows deep, was most of the
        board's width), so the captions stand once, over the columns.
      */}
      <div aria-hidden="true" className="mb-1 flex items-center gap-2 px-1.5 lg:hidden">
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted">Tap a price to bet</span>
        <span className="flex shrink-0 gap-1 sm:hidden">
          {(["HIGHER", "DRAW", "LOWER"] as const).map((d) => (
            <span
              key={d}
              className="w-[52px] text-center text-[10px] font-semibold uppercase tracking-wide"
              style={{ color: TONE_COLOR[TONE[d].tone] }}
            >
              {TONE[d].label}
            </span>
          ))}
        </span>
      </div>
      <ol
        className="relative m-0 list-none p-0 [--row-h:58px] sm:[--row-h:76px]"
        style={{ height: `calc(${ROW_H} * ${standings.length} + 8px)` }}
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
    </Section>
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
  // The crown and a coin that arrived mid-round have no book, so their rows are
  // not a control at all — the right-hand column already says why.
  const selectable = Boolean(entry && !entry.isCrown);

  return (
    <li
      role={selectable ? "button" : undefined}
      tabIndex={selectable ? 0 : undefined}
      aria-pressed={selectable ? selected : undefined}
      onClick={selectable ? () => onSelect(s.symbol) : undefined}
      onKeyDown={
        selectable
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(s.symbol);
              }
            }
          : undefined
      }
      className={`absolute inset-x-0 flex items-center gap-2.5 overflow-hidden rounded-lg px-2 sm:gap-3 sm:px-3 ${
        selected
          ? "mat-row-on cursor-pointer"
          : selectable
            ? "cursor-pointer hover:bg-[color-mix(in_oklch,var(--foreground)_4%,transparent)]"
            : ""
      }`}
      style={{
        height: `calc(${ROW_H} - 4px)`,
        transform: `translateY(calc(${ROW_H} * ${slot}))`,
        backgroundColor:
          moved === "up"
            ? "color-mix(in oklch, var(--up) 14%, transparent)"
            : moved === "down"
              ? "color-mix(in oklch, var(--down) 14%, transparent)"
              : undefined,
        transitionProperty: "transform, background-color",
        transitionDuration: "520ms, 900ms",
        transitionTimingFunction: "cubic-bezier(0.22, 1, 0.36, 1)",
      }}
    >
      {/* The rank, and the crown, are worn on the tile — see `RankedCoin`. The
          crown holder still shows its number: it wore the crown at the open,
          and where it stands now is the question the round is asking. */}
      <RankedCoin
        ticker={s.ticker}
        src={s.imageUrl}
        rank={s.rank}
        crown={entry?.isCrown ? "Wearing the crown" : undefined}
      />

      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-1">
          <span className="truncate text-sm font-semibold text-foreground sm:text-base">
            {s.ticker}
          </span>
          {/* Which way it has gone since the open, beside the name it belongs
              to rather than in a column of its own. */}
          <MoveArrow delta={delta} />
        </span>
        {/* The price is the one figure on the row the race is not about, so it
            is the one a phone does without. */}
        <span className="block truncate font-mono text-[11px] tabular-nums text-muted">
          ${formatCompact(s.quoteVolume)}
          <span className="max-sm:hidden"> · {formatPrice(s.price)}</span>
        </span>
      </span>

      <span className="flex shrink-0 items-center gap-1 sm:gap-1.5">
        {!entry ? (
          <span className="w-[164px] shrink-0 text-right text-[11px] leading-tight text-muted sm:w-[234px]">
            <span className="sm:hidden">In from the next round</span>
            <span className="max-sm:hidden">
              Climbed onto the board after this round opened — in from the next one.
            </span>
          </span>
        ) : entry.isCrown ? (
          <span
            title="Wearing the crown — the reigning token can't be backed. Win it by finishing first."
            className="w-[164px] shrink-0 cursor-help text-right text-[11px] text-muted sm:w-[234px]"
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

  return (
    <Chip
      tone={tone.tone}
      disabled={!line.available}
      onClick={(e) => {
        e.stopPropagation(); // the row's own click would drop the side
        onSelect(symbol, line.direction);
      }}
      title={
        line.available
          ? `${tone.label} — ${line.cents}¢, pays ${line.multiplier.toFixed(2)}x`
          : `${tone.label} is impossible from this rank`
      }
      // Named in full, because on a phone the caption is not drawn on the chip.
      aria-label={
        line.available
          ? `${tone.label}, ${line.cents}¢, pays ${line.multiplier.toFixed(2)}x`
          : `${tone.label}, unavailable`
      }
      className="w-[52px] shrink-0 px-1 py-2 max-sm:text-center sm:w-[74px] sm:px-2 sm:py-1.5"
    >
      {/* Captioned per chip only where there is room; a phone captions the
          columns once, over the board. */}
      <span
        className="block text-[10px] font-semibold uppercase tracking-wide max-sm:hidden"
        style={{ color: "var(--tone)" }}
      >
        {tone.label}
      </span>
      <span className="block font-mono text-sm tabular-nums text-foreground sm:text-xs">
        {line.available ? `${line.cents}¢` : "—"}
        {line.available && (
          <span className="ml-1 text-[10px] text-muted max-sm:hidden">
            {line.multiplier.toFixed(1)}x
          </span>
        )}
      </span>
    </Chip>
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
