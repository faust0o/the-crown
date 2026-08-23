import { useClock } from "../hooks/useClock";
import { CoinIcon } from "./CoinIcon";
import { formatCompact } from "../format";
import type { FlowEvent } from "./graphql";

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
  updatedAt,
  note,
}: {
  events: FlowEvent[];
  status?: string;
  /** When the upstream last published new numbers. */
  updatedAt?: number;
  /** Replaces the sync age — for feeds that aren't tracking the live board. */
  note?: string;
}) {
  useClock(); // tick the sync age once a second
  const age =
    updatedAt && updatedAt > 0
      ? Math.max(0, Math.round((Date.now() - updatedAt) / 1000))
      : null;
  const sync =
    note ??
    (status === "error" || status === "degraded"
      ? "oracle down"
      : age == null
        ? "syncing…"
        : `synced ${age < 90 ? `${age}s` : `${Math.round(age / 60)}m`} ago`);

  return (
    <div className="flex min-w-0 flex-col overflow-hidden">
      <div className="flex items-baseline justify-between px-1 pb-1">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">Flow</h2>
        {/* Fixed box and tabular figures — this rewrites every second, and
            letting it size itself shifted the column heading around. */}
        <span
          className="w-[96px] shrink-0 whitespace-nowrap text-right text-[11px] tabular-nums text-muted"
          title={note ? undefined : "tokens.xyz republishes about once a minute"}
        >
          {sync}
        </span>
      </div>
      <ul className="m-0 max-h-[460px] min-w-0 list-none overflow-y-auto overflow-x-hidden p-0">
        {events.map((e) => {
          const up = e.from == null || e.to < e.from;
          return (
            <li
              key={`${e.symbol}-${e.at}-${e.to}`}
              className="casino-tape-in grid w-full items-center gap-2 overflow-hidden border-b border-hairline/40 px-1 py-1.5 last:border-b-0"
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
          <li className="px-4 py-6 text-center text-xs text-muted">watching for moves…</li>
        )}
      </ul>
    </div>
  );
}
