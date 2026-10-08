import { Liveline } from "liveline";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useColorScheme } from "../theme";
import { proxied } from "./proxied";
import { raceSeries } from "./race";
import { fallbackColor, legibleOn, useIconColors } from "./useIconColors";

import { Section } from "../ui";
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
  title,
  history,
  standings,
  window,
  replay = false,
}: {
  /** The caption row. The page sets the round's stats there — see `GameStats`. */
  title: ReactNode;
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
  //
  // "Now" for a replay is the instant it opened, and stays that. The chart is
  // paused from its first frame, so liveline's clock stops there too — left
  // running, every line went on drawing flat past the cut and the round slid
  // off the left edge. Anything measured against the clock has to use this
  // same instant, or a rerun of the memo would move it out from under the
  // frozen plot.
  const [openedAt] = useState(() => Date.now());
  const shift = useMemo(() => {
    if (!replay || !history.length) return 0;
    return openedAt - Math.max(...history.map((p) => p.t));
  }, [replay, history, openedAt]);

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

  const { primary, series, value, spanSecs } = useMemo(
    () =>
      raceSeries({
        history,
        standings,
        // Hidden series stay in the array so they keep their legend entry and
        // their place in the volume ordering; they just draw nothing.
        hidden,
        shift,
        now: replay ? openedAt : Date.now(),
        // The line takes the logo's own colour, so a series is identifiable
        // against the row it belongs to rather than by legend order — lightened
        // when that colour is too dark to see on the dark theme.
        colorOf: (s) =>
          legibleOn(scheme, iconColors.get(proxied(s.imageUrl) ?? "") ?? fallbackColor(s.symbol)),
      }),
    [history, standings, iconColors, hidden, shift, scheme, replay, openedAt]
  );

  return (
    <Section title={title}>
      <div
        className="h-[320px] min-h-0"
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
          // A finished round is drawn once and held — see `openedAt`.
          paused={replay}
          window={spanSecs}
          emptyText="collecting…"
          formatValue={formatValue}
          formatTime={formatTime}
          // Keep the plot clear of the card header and the legend strip liveline
          // draws at the top — without this the leader's line runs into both.
          padding={{ top: 18, bottom: 40, right: 46, left: 4 }}
        />
      </div>
    </Section>
  );
}
