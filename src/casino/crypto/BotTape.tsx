import { gql, type TypedDocumentNode } from "@apollo/client";
import { useQuery } from "@apollo/client/react";
import { CoinIcon } from "./CoinIcon";
import type { Direction } from "./graphql";

interface BotTrade {
  id: string;
  at: number;
  bot: string;
  symbol: string;
  ticker: string;
  imageUrl: string | null;
  direction: Direction;
  /** Shares changing hands. */
  size: number;
  /** Price per share in cents. */
  cents: number;
}

/**
 * Kept out of `graphql.ts` and off the board query on purpose: the desks are
 * decoration, so nothing on the page should wait on them, and a failure here
 * must not blank the board.
 */
const BOT_TAPE: TypedDocumentNode<{ botTape: BotTrade[] }, { limit?: number }> = gql`
  query BotTape($limit: Int) {
    botTape(limit: $limit) {
      id
      at
      bot
      symbol
      ticker
      imageUrl
      direction
      size
      cents
    }
  }
`;

/** The desks only print when the upstream publishes, roughly once a minute. */
const POLL_MS = 5_000;

const TONE: Record<Direction, { label: string; color: string }> = {
  HIGHER: { label: "higher", color: "var(--up)" },
  DRAW: { label: "same", color: "var(--gold)" },
  LOWER: { label: "lower", color: "var(--down)" },
};

/**
 * Simulated market-making desks.
 *
 * This is *not* flow. There is no counterparty in this game — every bet is
 * priced by a model and settled against the board — so the panel says so in as
 * many words, sits under its own heading, and prints a price in cents rather
 * than a rank change, which is what `FlowFeed` above it shows and genuinely
 * observed. Nothing here touches anyone's credits.
 */
export function BotTape({ onSelect }: { onSelect?: (symbol: string) => void }) {
  const { data } = useQuery(BOT_TAPE, {
    variables: { limit: 24 },
    pollInterval: POLL_MS,
    fetchPolicy: "cache-and-network",
  });
  const trades = data?.botTape ?? [];

  return (
    <div className="flex min-w-0 flex-col overflow-hidden">
      <div className="flex items-baseline justify-between gap-2 px-1 pb-1">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">Desks</h2>
        <span
          className="shrink-0 rounded border border-hairline px-1.5 py-px text-[10px] uppercase tracking-wider text-muted"
          title="Bots, not players. Simulated activity that never touches credits or settlement."
        >
          simulated
        </span>
      </div>
      <ul className="m-0 max-h-[300px] min-w-0 list-none overflow-y-auto overflow-x-hidden p-0">
        {trades.map((t) => {
          const tone = TONE[t.direction];
          return (
            <li
              key={t.id}
              className="casino-tape-in grid w-full items-center gap-2 overflow-hidden border-b border-hairline/40 px-1 py-1.5 last:border-b-0"
              style={{ gridTemplateColumns: "18px minmax(0,1fr) minmax(0,auto)" }}
            >
              <CoinIcon ticker={t.ticker} src={t.imageUrl} size={18} />
              <button
                type="button"
                onClick={() => onSelect?.(t.symbol)}
                className="min-w-0 cursor-pointer border-0 bg-transparent p-0 text-left"
              >
                <span className="flex min-w-0 items-baseline gap-1.5">
                  <span className="truncate font-mono text-xs font-semibold text-foreground">
                    {t.ticker}
                  </span>
                  <span className="shrink-0 text-[11px]" style={{ color: tone.color }}>
                    {tone.label}
                  </span>
                </span>
                <span className="block truncate text-[10px] text-muted">{t.bot}</span>
              </button>
              <span className="min-w-0 text-right">
                <span className="block font-mono text-xs tabular-nums text-secondary">
                  {t.size.toLocaleString()}
                </span>
                <span className="block font-mono text-[10px] tabular-nums text-muted">
                  {t.cents}¢
                </span>
              </span>
            </li>
          );
        })}
        {!trades.length && (
          <li className="px-4 py-6 text-center text-xs text-muted">
            desks are quiet — they trade when the board republishes
          </li>
        )}
      </ul>
    </div>
  );
}
