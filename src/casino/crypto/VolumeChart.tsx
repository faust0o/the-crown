import { useCallback, useMemo, useState } from "react";
import { useColorScheme } from "../hooks/useColorScheme";
import { proxied } from "./proxied";
import { fallbackColor, useIconColors } from "./useIconColors";
import { Liveline } from "liveline";
import type { LivelinePoint, LivelineSeries } from "liveline";

import type { RankPoint, Standing } from "./graphql";


const formatValue = (v: number) => `${v.toFixed(1)}%`;

/**
 * The race, as each coin's share of the field's total volume.
 *
 * Plotting raw volume made this chart useless: BTC runs ~10x the next coin, so
 * it filled the axis and ETH-through-TRX collapsed into a smudge along the
 * bottom. Share-of-total spreads all ten across the axis and is the same
 * ordering — a coin overtaking another still crosses here exactly when the rows
 * swap below, because dividing every coin by the same total preserves rank.
 *
 * liveline takes `data`/`value` for a primary line plus `series` for the rest;
 * the leader is the primary so the badge tracks whoever wears the crown.
 */
export function VolumeChart({
  history,
  standings,
  window,
  replay = false,
}: {
  history: RankPoint[];
  standings: Standing[];
  window: string;
  /** Draw a finished round rather than the live board — see `shift` below. */
  replay?: boolean;
}) {
  const iconColors = useIconColors(standings.map((s) => proxied(s.imageUrl)));
  const scheme = useColorScheme();

  // liveline anchors its time axis to the wall clock, so samples from a round
  // that has already ended either squeeze into a sliver at the far left or fall
  // off the plot entirely. Sliding the whole series forward until its last
  // sample lands on "now" makes the round fill the chart; `formatTime` takes the
  // shift back off so the axis still reads the hours the race actually ran.
  const shift = useMemo(() => {
    if (!replay || !history.length) return 0;
    return Date.now() - Math.max(...history.map((p) => p.t));
  }, [replay, history]);

  const formatTime = useCallback(
    (t: number) =>
      new Date(t * 1000 - shift).toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      }),
    [shift]
  );

  // Visibility is ours, keyed by symbol.
  //
  // liveline tracks hidden series internally, but we rebuild and reorder the
  // series array on every poll (it follows the board's volume ordering), and
  // that internal state doesn't survive the reshuffle — a hidden line would
  // reattach to whichever series now sits in its slot. Owning it by id and
  // feeding the hidden series an empty dataset makes visibility a function of
  // the data, so nothing can drift out of sync.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const onSeriesToggle = useCallback((id: string, visible: boolean) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (visible) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const { primary, series, value, spanSecs } = useMemo(() => {
    // Total the field per timestamp first, so each point is a share of that
    // instant rather than of some fixed denominator.
    const totalAt = new Map<number, number>();
    for (const p of history) totalAt.set(p.t, (totalAt.get(p.t) ?? 0) + p.quoteVolume);

    const bySymbol = new Map<string, LivelinePoint[]>();
    for (const p of history) {
      if (!bySymbol.has(p.symbol)) bySymbol.set(p.symbol, []);
      const total = totalAt.get(p.t) ?? 0;
      bySymbol.get(p.symbol)!.push({
        // liveline's time axis is in seconds.
        time: Math.round((p.t + shift) / 1000),
        value: total > 0 ? (100 * p.quoteVolume) / total : 0,
      });
    }
    const liveTotal = standings.reduce((n, s) => n + s.quoteVolume, 0);

    // Ordered by volume, matching the board. Reordering is safe now that a
    // token's colour comes from its symbol rather than its position — that
    // index-keyed palette was what made lines swap colours and appear to lurch
    // whenever the ranking changed.
    const ordered = standings.filter((s) => bySymbol.has(s.symbol));

    const built: LivelineSeries[] = ordered.map((s) => ({
      id: s.symbol,
      // Hidden series stay in the array so they keep their legend entry and
      // their place in the volume ordering; they just draw nothing.
      data: hidden.has(s.symbol) ? [] : (bySymbol.get(s.symbol) ?? []),
      value: liveTotal > 0 ? (100 * s.quoteVolume) / liveTotal : 0,
      // The line takes the logo's own colour, so a series is identifiable
      // against the row it belongs to rather than by legend order.
      color: iconColors.get(proxied(s.imageUrl) ?? "") ?? fallbackColor(s.symbol),
      label: s.ticker,
    }));

    const lead = built.find((b) => b.data.length) ?? built[0];
    // liveline crops to `window` seconds. Size it to the data we actually hold,
    // never to wall-clock time since the round opened — doing that left an empty
    // region wherever the round predates our recording, which reads as a broken
    // chart. Matching the window to the data keeps the line spanning the
    // container edge to edge, always continuous.
    const times = history.map((p) => p.t + shift);
    const spanMs = times.length ? Date.now() - Math.min(...times) : 0;
    return {
      primary: lead?.data ?? [],
      series: built,
      value: lead?.value ?? 0,
      spanSecs: Math.max(60, Math.ceil(spanMs / 1000)),
    };
  }, [history, standings, iconColors, hidden, shift]);

  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between px-1 pb-1">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">
          Volume race
        </h2>
        <span className="shrink-0 text-[11px] text-muted">
          share of field · {replay ? "this round" : `trailing ${window}`}
        </span>
      </div>

      <div
        className="h-[320px] min-h-0 pb-2"
        role="img"
        aria-label={`Trailing ${window} traded volume for the ten competing coins`}
      >
        <Liveline
          data={primary}
          value={value}
          series={series}
          // liveline draws to a canvas, so it cannot read the CSS tokens the
          // rest of the page themes with — it has to be told. Pinned to "light",
          // its grid and empty state were all but invisible on a dark board.
          theme={scheme}
          color={series[0]?.color ?? "#f7931a"}
          grid
          badge
          badgeVariant="minimal"
          pulse={false}
          momentum={false}
          fill={false}
          scrub
          onSeriesToggle={onSeriesToggle}
          window={spanSecs}
          emptyText="collecting…"
          formatValue={formatValue}
          formatTime={formatTime}
          // Keep the plot clear of the card header and the legend strip liveline
          // draws at the top — without this the leader's line runs into both.
          padding={{ top: 18, bottom: 40, right: 46, left: 4 }}
        />
      </div>

    </div>
  );
}
