import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cx } from "./cx";
import { TONE_COLOR, type Tone } from "./tone";

/**
 * A legend stamped into the case: cluster names, "simulated", "detected".
 *
 * Not a chip — nothing here is pressable, and the material says so by sitting
 * flush with the face rather than proud of it.
 *
 * Flush, and specifically not sunken. This used to be a well — `mat-inset`, an
 * inner shadow and a gradient — which is the exact treatment every text field on
 * the page wears, so "devnet" read as an empty input someone had forgotten to
 * fill in. A legend is engraved into a surface; a well is a place to put
 * something.
 */
export function Tag({
  tone,
  className,
  children,
  ...rest
}: {
  tone?: Tone;
  children?: ReactNode;
} & ComponentPropsWithoutRef<"span">) {
  return (
    <span
      style={tone ? { color: TONE_COLOR[tone] } : undefined}
      className={cx(
        "mat-engrave inline-flex shrink-0 items-center rounded px-1.5 py-px",
        "border border-hairline",
        "font-mono text-[10px] uppercase tracking-wider",
        !tone && "text-muted",
        className
      )}
      {...rest}
    >
      {children}
    </span>
  );
}
