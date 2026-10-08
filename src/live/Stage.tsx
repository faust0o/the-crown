import { Liveline } from "liveline";
import { useEffect, useMemo, useRef, type RefObject } from "react";
import type { RankPoint } from "../casino/crypto/graphql";
import { proxied } from "../casino/crypto/proxied";
import { raceSeries } from "../casino/crypto/race";
import { fallbackColor, legibleOn, useIconColors } from "../casino/crypto/useIconColors";
import { CHART, HEIGHT, paintScene, readPalette, utcTime, WIDTH, type Crowning, type Race } from "./scene";
import { tick } from "./ticker";

/** Frames a second, painted and recorded. The server encodes at the same rate. */
export const FPS = 30;

/**
 * How much larger the chart is drawn on the stream than liveline lays it out.
 * liveline sets its type at 11px and its marks at 14px, which is right for a
 * page read at arm's length and too small on a phone watching 720p; laying it
 * out smaller and scaling the copy up enlarges all of it together.
 */
const ZOOM = 1.3;

const formatValue = (v: number) => `${v.toFixed(1)}%`;
const formatTime = (t: number) => utcTime(t * 1000);

/**
 * The broadcast frame, and the chart it is built around.
 *
 * The canvas shown here *is* the stream — the page records this element — so
 * the preview and what goes out cannot disagree. Painting runs on a worker's
 * clock rather than on animation frames, so a hidden tab keeps sending; the
 * chart itself, which liveline animates on animation frames, holds still until
 * the tab is visible again.
 */
export function Stage({
  race,
  history,
  crowning,
  canvasRef,
}: {
  race: Race;
  history: RankPoint[];
  crowning: Crowning | null;
  canvasRef: RefObject<HTMLCanvasElement | null>;
}) {
  const chartHost = useRef<HTMLDivElement>(null);
  // The painter reads the latest of these on every tick, without React
  // re-rendering thirty times a second to hand them over.
  const latest = useRef({ race, crowning });
  useEffect(() => {
    latest.current = { race, crowning };
  }, [race, crowning]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const palette = readPalette();
    const host = window.location.host;
    let chart: HTMLCanvasElement | null = null;
    return tick(FPS, () => {
      if (!chart?.isConnected) chart = chartHost.current?.querySelector("canvas") ?? null;
      paintScene(
        ctx,
        {
          now: performance.now(),
          wall: Date.now(),
          race: latest.current.race,
          crowning: latest.current.crowning,
          chart,
          host,
        },
        palette
      );
    });
  }, [canvasRef]);

  const iconColors = useIconColors(race.field.map((s) => proxied(s.imageUrl)));
  const { primary, series, value, spanSecs } = useMemo(
    () =>
      raceSeries({
        history,
        standings: race.field,
        now: Date.now(),
        colorOf: (s) =>
          legibleOn("dark", iconColors.get(proxied(s.imageUrl) ?? "") ?? fallbackColor(s.symbol)),
      }),
    [history, race.field, iconColors]
  );

  return (
    <>
      <canvas
        ref={canvasRef}
        width={WIDTH}
        height={HEIGHT}
        className="block aspect-video h-auto w-full rounded-lg bg-black"
        aria-label="The stream, as it goes out"
      />
      {/* Laid out but never seen: the scene copies its canvas in. */}
      <div
        ref={chartHost}
        aria-hidden="true"
        style={{
          position: "fixed",
          left: -10_000,
          top: 0,
          width: CHART.w / ZOOM,
          height: CHART.h / ZOOM,
          pointerEvents: "none",
        }}
      >
        <Liveline
          data={primary}
          value={value}
          series={series}
          theme="dark"
          color={series[0]?.color ?? "#f7931a"}
          grid
          // The badge is DOM, which the recording cannot see.
          badge={false}
          pulse={false}
          momentum={false}
          fill={false}
          scrub={false}
          window={spanSecs}
          emptyText="collecting…"
          formatValue={formatValue}
          formatTime={formatTime}
          // The right edge carries the value axis; narrower and its labels clip.
          padding={{ top: 10, bottom: 28, right: 46, left: 4 }}
        />
      </div>
    </>
  );
}
