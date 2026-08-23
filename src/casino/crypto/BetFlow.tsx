import { useQuery } from "@apollo/client/react";
import { useMemo } from "react";
import { CRYPTO_BOOK, type BookLevel, type Direction, type Entry, type Standing } from "./graphql";

const TONE: Record<Direction, { label: string; color: string }> = {
  HIGHER: { label: "Higher", color: "var(--up)" },
  DRAW: { label: "Same", color: "var(--gold)" },
  LOWER: { label: "Lower", color: "var(--down)" },
};

/** Matches the board's cadence, so the bars and the price chips move together. */
const POLL_MS = 2_000;

/**
 * Depth across the three outcomes for the selected coin.
 *
 * `cryptoBook` aggregates the same tape that sets each line's price, so this
 * panel and the board's chips are two views of one ledger. It used to draw a
 * seeded-PRNG book instead, which looked plausible and agreed with nothing.
 * What it shows is traded interest, not resting orders — there is no matching
 * engine behind a market in "will ADA hold rank 5".
 *
 * It is a market view: it never reads the player's own bets, so it renders
 * identically whether or not they hold a position — the same rule the board's
 * price chips follow.
 */
export function BetFlow({
  standing,
  entry,
}: {
  standing: Standing | null;
  entry: Entry | null;
}) {
  const { data } = useQuery(CRYPTO_BOOK, {
    variables: { symbol: entry?.symbol ?? "" },
    skip: !entry,
    pollInterval: POLL_MS,
    fetchPolicy: "cache-and-network",
    // A failed poll must leave the rail standing: `data` stays undefined and
    // the "no book yet" card below takes over.
    errorPolicy: "all",
  });

  const levels = useMemo<BookLevel[]>(() => {
    if (!entry) return [];
    // A line the round rules out isn't a market, and one the tape has never
    // printed has no price to quote — the server sends 0¢ for both.
    const playable = new Set(entry.lines.filter((l) => l.available).map((l) => l.direction));
    return (data?.cryptoBook ?? []).filter((l) => playable.has(l.direction) && l.cents > 0);
  }, [data?.cryptoBook, entry]);

  if (!standing || !entry || !levels.length) {
    // The reigning coin is off the book by design, and it is also whoever leads
    // the board — so it is what the ticket defaults to. Saying why beats a bare
    // "no book yet", which is indistinguishable from a broken panel and is
    // exactly what this card shows most of the time otherwise.
    return (
      <div className="rounded-lg border border-hairline bg-surface p-4 text-center text-xs text-muted">
        {entry?.isCrown ? "Wearing the crown — no book this round." : "no book yet"}
      </div>
    );
  }

  const max = Math.max(...levels.map((l) => l.size), 1);
  const total = levels.reduce((n, l) => n + l.size, 0);

  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-hairline bg-surface">
      <div className="flex items-baseline justify-between border-b border-hairline px-4 py-2.5">
        <h2 className="text-sm font-semibold text-foreground">
          Book <span className="font-normal text-muted">· {standing.ticker}</span>
        </h2>
        <span
          className="shrink-0 text-[11px] uppercase tracking-wider text-muted"
          title="Shares traded on these lines in the last few minutes."
        >
          {total.toLocaleString()} traded
        </span>
      </div>
      <ul className="m-0 list-none p-2">
        {levels.map((l) => {
          const tone = TONE[l.direction];
          return (
            <li key={l.direction} className="relative mb-1 overflow-hidden rounded last:mb-0">
              <span
                aria-hidden="true"
                className="absolute inset-y-0 left-0 transition-[width] duration-500"
                style={{
                  width: `${(100 * l.size) / max}%`,
                  background: `color-mix(in oklch, ${tone.color} 16%, transparent)`,
                }}
              />
              <span className="relative grid grid-cols-[1fr_auto_auto] items-center gap-2 px-2 py-1.5">
                <span className="min-w-0 truncate text-xs font-semibold" style={{ color: tone.color }}>
                  {tone.label}
                </span>
                <span className="font-mono text-[11px] tabular-nums text-muted">{l.cents}¢</span>
                <span className="w-16 text-right font-mono text-xs tabular-nums text-foreground">
                  {l.size.toLocaleString()}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
