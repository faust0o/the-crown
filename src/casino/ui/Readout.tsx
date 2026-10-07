import type { ReactNode } from "react";
import { cx } from "./cx";
import { Caption } from "./Field";

/**
 * A number behind glass.
 *
 * Every figure the game reports — a balance, a P/L, a quote — is a reading off
 * an instrument rather than a line of prose, so it is set in tabular figures in
 * a well. Tabular matters more than it looks: these update on a two-second
 * poll, and proportional digits make a steady number jitter.
 */
export function Readout({
  label,
  value,
  hint,
  color,
  size = "md",
  inset = false,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  /** A token, for a figure that carries direction. Defaults to the foreground. */
  color?: string;
  size?: "sm" | "md" | "lg";
  /**
   * Cut it into the face. For the handful of figures that genuinely are a
   * display — a countdown, a quote being computed — and not for every number
   * that happens to be important.
   */
  inset?: boolean;
  className?: string;
}) {
  const valueSize =
    size === "lg" ? "text-xl" : size === "sm" ? "text-sm" : "text-lg";
  return (
    <div className={cx(inset && "mat-inset rounded-lg px-3 py-2", className)}>
      <Caption>{label}</Caption>
      <div
        className={cx("mt-0.5 font-mono tabular-nums", valueSize)}
        style={{ color: color ?? "var(--foreground)" }}
      >
        {value}
      </div>
      {hint && <div className="mt-0.5 font-mono text-[11px] text-muted">{hint}</div>}
    </div>
  );
}
