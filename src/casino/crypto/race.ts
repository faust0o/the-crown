import type { LivelinePoint, LivelineSeries } from "liveline";
import type { Mover } from "./GameStats";
import type { Entry, RankPoint, Standing } from "./graphql";
import { lineIcon } from "./lineIcon";
import { proxied } from "./proxied";

/**
 * The race, as the chart plots it: each coin's share of the field's total
 * volume.
 *
 * Plotting raw volume made the chart useless: BTC runs ~10x the next coin, so
 * it filled the axis and ETH-through-TRX collapsed into a smudge along the
 * bottom. Share-of-total spreads all ten across the axis and is the same
 * ordering — a coin overtaking another still crosses here exactly when the rows
 * swap below, because dividing every coin by the same total preserves rank.
 *
 * Shared by the board's chart and the livestream's, so the two can never draw
 * the same race differently.
 */
export function raceSeries({
  history,
  standings,
  colorOf,
  hidden,
  shift = 0,
  now,
}: {
  history: RankPoint[];
  standings: Standing[];
  /** The line's colour for a coin — see `VolumeChart` for how it is chosen. */
  colorOf: (s: Standing) => string;
  /** Coins drawn with no data: they keep their legend entry and place. */
  hidden?: ReadonlySet<string>;
  /** Milliseconds added to every sample, for a replay — see `VolumeChart`. */
  shift?: number;
  /** The instant the chart's right edge stands for. */
  now: number;
}): { primary: LivelinePoint[]; series: LivelineSeries[]; value: number; spanSecs: number } {
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

  const series: LivelineSeries[] = ordered.map((s) => ({
    id: s.symbol,
    data: hidden?.has(s.symbol) ? [] : (bySymbol.get(s.symbol) ?? []),
    value: liveTotal > 0 ? (100 * s.quoteVolume) / liveTotal : 0,
    color: colorOf(s),
    // Still feeds the scrub tooltip and the legend.
    label: s.ticker,
    // Drawn at the line's end in place of the ticker. liveline reserves room
    // there for its widest label, so text tickers resized the plot — and
    // shifted every line — whenever the field changed. Icons are all one width.
    icon: lineIcon(s.symbol, s.ticker, proxied(s.imageUrl)),
  }));

  const lead = series.find((b) => b.data.length) ?? series[0];
  // liveline crops to `window` seconds. Size it to the data we actually hold,
  // never to wall-clock time since the round opened — doing that left an empty
  // region wherever the round predates our recording, which reads as a broken
  // chart. Matching the window to the data keeps the line spanning the
  // container edge to edge, always continuous.
  const times = history.map((p) => p.t + shift);
  const spanMs = times.length ? now - Math.min(...times) : 0;
  return {
    primary: lead?.data ?? [],
    series,
    value: lead?.value ?? 0,
    spanSecs: Math.max(60, Math.ceil(spanMs / 1000)),
  };
}

/**
 * The field: every coin the board has to show, which is not the same set as
 * the live top ten.
 *
 * A coin that opened in the round and has since been pushed off the board is
 * still in the race, standing where the cut will score it — one below the last
 * visible slot. A coin that trended in after the open is there too, as a
 * spectator. Between rounds there is no field, and the live board is all there
 * is. The board page builds the same list; this is it for the livestream.
 */
export function fieldOf(
  round: {
    entries: Pick<Entry, "symbol" | "ticker" | "imageUrl" | "startRank" | "liveRank" | "liveVolume" | "livePrice">[];
  } | null,
  standings: Standing[]
): Standing[] {
  if (!round?.entries.length) return standings;
  const live = new Map(standings.map((s) => [s.symbol, s]));
  const inRound = round.entries.map(
    (e): Standing =>
      live.get(e.symbol) ?? {
        symbol: e.symbol,
        ticker: e.ticker,
        name: e.ticker,
        rank: e.liveRank ?? e.startRank,
        previousRank: null,
        quoteVolume: e.liveVolume,
        price: e.livePrice,
        imageUrl: e.imageUrl,
        trades1h: 0,
        wallets1h: 0,
        priceChange1hPercent: 0,
      }
  );
  const entered = new Set(round.entries.map((e) => e.symbol));
  const newcomers = standings.filter((s) => !entered.has(s.symbol));
  return [...inRound, ...newcomers].sort((a, b) => a.rank - b.rank);
}

/**
 * The round's own coins, measured from where each opened — what the stats over
 * the chart count. A coin that trended in since is not in this race.
 */
export function moversOf(field: Standing[], entries: ReadonlyMap<string, Pick<Entry, "startRank">>): Mover[] {
  return (entries.size ? field.filter((s) => entries.has(s.symbol)) : field).map((s) => ({
    symbol: s.symbol,
    ticker: s.ticker,
    imageUrl: s.imageUrl,
    from: entries.get(s.symbol)?.startRank ?? s.rank,
    to: s.rank,
    volume: s.quoteVolume,
  }));
}
