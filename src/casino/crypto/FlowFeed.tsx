import { CoinIcon } from "./CoinIcon";
import { formatCompact } from "../format";
import type { FlowEvent } from "./graphql";
import { Empty, Section } from "../ui";

/**
 * Board movements as they happen.
 *
 * The old panel streamed real exchange trades; tokens.xyz is a REST feed with no
 * per-trade data, so rather than invent a tape this shows the thing the oracle
 * genuinely observes — a token changing rank, and the volume that did it.
 */
export function FlowFeed({
  events,
  status,
  note,
}: {
  events: FlowEvent[];
  status?: string;
  /**
   * Captions the feed, for one that isn't the live board's — the replay's.
   *
   * The live feed has no caption: it sits under the ticket, and what it is is
   * obvious from a single row of it. A replay's feed sits among other captioned
   * sections, and without one of its own it read as the tail of the section
   * above it.
   */
  note?: string;
}) {
  const down = status === "error" || status === "degraded";
  const list = (
    <ul className="m-0 max-h-[460px] min-w-0 list-none overflow-y-auto overflow-x-hidden p-0">
      {events.map((e) => {
        const up = e.from == null || e.to < e.from;
        return (
          <li
            key={`${e.symbol}-${e.at}-${e.to}`}
            className="casino-tape-in grid w-full items-center gap-2 overflow-hidden rounded border-b border-[var(--bevel-lo)] px-2 py-1.5 last:border-b-0"
            style={{ gridTemplateColumns: "18px minmax(0,auto) minmax(0,1fr) minmax(0,auto)" }}
          >
            <CoinIcon ticker={e.ticker} src={e.imageUrl} size={18} />
            <span className="min-w-0 truncate font-mono text-xs font-semibold text-foreground">
              {e.ticker}
            </span>
            <span
              className="min-w-0 truncate font-mono text-[11px] tabular-nums"
              style={{ color: up ? "var(--up)" : "var(--down)" }}
            >
              {e.from == null ? "new" : `${e.from} → ${e.to}`} {up ? "▲" : "▼"}
            </span>
            <span className="min-w-0 truncate text-right font-mono text-xs tabular-nums text-muted">
              ${formatCompact(e.quoteVolume)}
            </span>
          </li>
        );
      })}
      {!events.length && (
        <li>
          <Empty>watching for moves…</Empty>
        </li>
      )}
    </ul>
  );

  if (note) {
    return (
      <Section title="Flow" aside={note}>
        {list}
      </Section>
    );
  }
  return (
    // `min-h-0` lets the list give up height when the ticket column is pinned
    // to the viewport — it scrolls already, so it is the part that can.
    <section aria-label="Flow" className="mb-4 flex min-h-0 min-w-0 flex-col">
      {/* The one thing the old caption said that still needs saying — and only
          when it is true. How long ago a healthy feed synced is noise. */}
      {down && <p className="m-0 mb-1.5 text-[11px] text-down">oracle down — the board may be stale</p>}
      {list}
    </section>
  );
}
