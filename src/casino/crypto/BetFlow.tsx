import { useQuery } from "@apollo/client/react";
import { useMemo } from "react";
import { CRYPTO_BOOK, type BookLevel, type Direction, type Entry, type Standing } from "./graphql";
import { Empty, Meter, Section, type Tone } from "../ui";

const TONE: Record<Direction, { label: string; tone: Tone }> = {
  HIGHER: { label: "Higher", tone: "up" },
  DRAW: { label: "Same", tone: "gold" },
  LOWER: { label: "Lower", tone: "down" },
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
      <Section title="Book">
        <Empty>
          {entry?.isCrown ? "Wearing the crown — no book this round." : "no book yet"}
        </Empty>
      </Section>
    );
  }

  const max = Math.max(...levels.map((l) => l.size), 1);
  const total = levels.reduce((n, l) => n + l.size, 0);

  return (
    <Section
      title={`Book · ${standing.ticker}`}
      aside={
        <span title="Shares traded on these lines in the last few minutes.">
          {total.toLocaleString()} traded
        </span>
      }
    >
      <ul className="m-0 list-none p-0">
        {levels.map((l) => {
          const tone = TONE[l.direction];
          return (
            <li key={l.direction} className="mb-1 last:mb-0">
              <Meter fraction={l.size / max} tone={tone.tone}>
                <span className="grid grid-cols-[1fr_auto] items-center gap-2 px-2 py-1.5">
                  {/* Price rides with the name, not with the size: "Higher 49¢"
                      reads as one quote, where a right-aligned column of cents
                      reads as a second size. */}
                  <span className="flex min-w-0 items-baseline gap-1.5">
                    <span
                      className="truncate text-xs font-semibold"
                      style={{ color: "var(--tone)" }}
                    >
                      {tone.label}
                    </span>
                    <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted">
                      {l.cents}¢
                    </span>
                  </span>
                  <span className="w-16 text-right font-mono text-xs tabular-nums text-foreground">
                    {l.size.toLocaleString()}
                  </span>
                </span>
              </Meter>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
