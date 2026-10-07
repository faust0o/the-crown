import { gql, type TypedDocumentNode } from "@apollo/client";
import { useQuery } from "@apollo/client/react";
import { CoinIcon } from "./CoinIcon";
import { useClock } from "../hooks/useClock";
import { formatCredits } from "../format";
import type { Direction } from "./graphql";
import { Empty, Section, TONE_COLOR, type Tone } from "../ui";

type OrderKind = "BUY" | "SELL";

interface Order {
  id: string;
  at: number;
  handle: string;
  symbol: string;
  ticker: string;
  imageUrl: string | null;
  direction: Direction;
  kind: OrderKind;
  /** Credits staked on a BUY, credits returned on a SELL. */
  credits: number;
  /** Price per share in cents. */
  cents: number;
  /** Against the stake, on a SELL only. */
  pnl: number | null;
}

/**
 * Kept out of `graphql.ts` and off the board query on purpose: the board must
 * not wait on the feed, and a failure here must not blank it.
 */
const ORDERS: TypedDocumentNode<{ orders: Order[] }, { limit?: number }> = gql`
  query Orders($limit: Int) {
    orders(limit: $limit) {
      id
      at
      handle
      symbol
      ticker
      imageUrl
      direction
      kind
      credits
      cents
      pnl
    }
  }
`;

/**
 * How often the feed refreshes.
 *
 * Fast, because this is the one panel whose whole claim is that it is live —
 * somebody who has just placed a bet should see it arrive, not wonder whether it
 * worked. The server caches the read for a second, so the cost of every viewer
 * asking twice as often as that is a cache hit rather than a query.
 */
const POLL_MS = 2_000;

const TONE: Record<Direction, { label: string; tone: Tone }> = {
  HIGHER: { label: "higher", tone: "up" },
  DRAW: { label: "same", tone: "gold" },
  LOWER: { label: "lower", tone: "down" },
};

/** "now", "40s", "6m" — coarse on purpose; this is a feed, not a stopwatch. */
function ago(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 5) return "now";
  if (seconds < 90) return `${seconds}s`;
  return `${Math.round(seconds / 60)}m`;
}

/**
 * The order flow: every bet placed and every position closed this round.
 *
 * This panel used to show simulated market-making desks, and the difference is
 * the whole point of the change rather than a rename. There are no desks and no
 * model chasing the board any more: a line moves when somebody backs it, so what
 * is printed here *is* what moved the prices above it. Nothing is labelled
 * simulated because nothing is.
 *
 * A BUY is credits going into a line and a SELL is a position leaving it, priced
 * at what each actually filled at. The two are drawn differently on purpose —
 * a feed in which taking profit looks the same as opening a position tells you
 * how busy the room is and nothing about what it thinks.
 */
export function Orders({ onSelect }: { onSelect?: (symbol: string) => void }) {
  const { data } = useQuery(ORDERS, {
    variables: { limit: 30 },
    pollInterval: POLL_MS,
    fetchPolicy: "cache-and-network",
  });
  const now = useClock().getTime();
  const rows = data?.orders ?? [];

  return (
    // Shrinkable, like the flow feed under it, for when the ticket column is
    // pinned to the viewport and the list has to scroll in less room.
    <Section title="Orders" className="min-h-0" bodyClassName="flex min-h-0 flex-col">
      <ul className="m-0 max-h-[360px] min-w-0 list-none overflow-y-auto overflow-x-hidden p-0">
        {rows.map((o) => {
          const tone = TONE[o.direction];
          const sell = o.kind === "SELL";
          // A closed position is reported by what it made, not by what it cost:
          // the credits are already in the row above it, and the number a reader
          // wants from somebody else's exit is whether it was a good one.
          const pnl = sell && o.pnl != null ? o.pnl : null;
          return (
            <li
              key={o.id}
              className="casino-tape-in grid w-full items-center gap-2 overflow-hidden rounded border-b border-[var(--bevel-lo)] px-2 py-1.5 last:border-b-0"
              style={{ gridTemplateColumns: "18px minmax(0,1fr) minmax(0,auto)" }}
            >
              <CoinIcon ticker={o.ticker} src={o.imageUrl} size={18} />
              <button
                type="button"
                onClick={() => onSelect?.(o.symbol)}
                className="min-w-0 cursor-pointer border-0 bg-transparent p-0 text-left"
              >
                <span className="flex min-w-0 items-baseline gap-1.5">
                  {/*
                    Blue in, amber out — the same pair the ticket's two buttons
                    use, so a row on the tape and the control that produced it
                    are recognisably the same event. The direction word beside
                    it still carries the rank tone; these two colours are about
                    which way the credits went, not which way the coin did.
                  */}
                  <span
                    className="shrink-0 font-mono text-[10px] font-semibold uppercase tracking-wider"
                    style={{ color: sell ? "var(--sell-ink)" : "var(--buy-ink)" }}
                  >
                    {sell ? "sold" : "bought"}
                  </span>
                  <span className="truncate font-mono text-xs font-semibold text-foreground">
                    {o.ticker}
                  </span>
                  <span className="shrink-0 text-[11px]" style={{ color: TONE_COLOR[tone.tone] }}>
                    {tone.label}
                  </span>
                </span>
                <span className="block truncate text-[10px] text-muted">
                  {o.handle} · {ago(o.at, now)}
                </span>
              </button>
              <span className="min-w-0 text-right">
                <span className="block font-mono text-xs tabular-nums text-secondary">
                  {formatCredits(o.credits)}
                </span>
                {pnl == null ? (
                  <span className="block font-mono text-[10px] tabular-nums text-muted">
                    {o.cents}¢
                  </span>
                ) : (
                  <span
                    className="block font-mono text-[10px] tabular-nums"
                    style={{ color: pnl >= 0 ? "var(--up)" : "var(--down)" }}
                  >
                    {pnl >= 0 ? "+" : "−"}
                    {formatCredits(Math.abs(pnl)).replace("$", "")} @ {o.cents}¢
                  </span>
                )}
              </span>
            </li>
          );
        })}
        {!rows.length && (
          <li>
            <Empty>nobody has bet this round yet — the first one sets the price</Empty>
          </li>
        )}
      </ul>
    </Section>
  );
}
