import type { ComponentProps, ReactNode } from "react";
import { cx } from "./cx";
import { TONE_COLOR, type Tone } from "./tone";

/**
 * A small keycap that carries a tone.
 *
 * Two states worth naming: an unpressed chip is metal with the faintest wash of
 * its tone, and a pressed one lights from behind. That difference is what makes
 * the board's price chips readable as a market — a row of them is a row of keys,
 * and the one you have chosen is lit.
 */
export function Chip({
  tone = "neutral",
  active = false,
  className,
  children,
  type = "button",
  ...rest
}: {
  tone?: Tone;
  active?: boolean;
  children?: ReactNode;
} & ComponentProps<"button">) {
  return (
    <button
      type={type}
      data-active={active}
      style={{ ["--tone" as string]: TONE_COLOR[tone] }}
      className={cx(
        "mat-key mat-chip relative rounded-md text-left",
        "disabled:cursor-not-allowed disabled:opacity-40",
        className
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
