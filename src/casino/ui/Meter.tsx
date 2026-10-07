import type { ReactNode } from "react";
import { cx } from "./cx";
import { TONE_COLOR, type Tone } from "./tone";

/**
 * A lit bar in a cut track.
 *
 * The fill glows in its tone rather than merely being tinted, so depth reads at
 * a glance on a panel where every other surface is unlit.
 */
export function Meter({
  fraction,
  tone = "neutral",
  className,
  children,
}: {
  /** 0…1. Clamped, because a live maximum can lag the value that set it. */
  fraction: number;
  tone?: Tone;
  className?: string;
  /** Drawn over the bar — the labels a depth row carries. */
  children?: ReactNode;
}) {
  const pct = Math.max(0, Math.min(1, fraction)) * 100;
  return (
    <div
      className={cx("mat-inset relative overflow-hidden rounded-md", className)}
      // Set on the track rather than the fill, so a label drawn over the bar can
      // colour itself from the same source the bar lights from.
      style={{ ["--tone" as string]: TONE_COLOR[tone] }}
    >
      <span
        aria-hidden="true"
        className="mat-meter-fill absolute inset-y-px left-px transition-[width] duration-500"
        style={{ width: `calc(${pct}% - 2px)` }}
      />
      <span className="relative block">{children}</span>
    </div>
  );
}
