import type { ComponentProps, ReactNode } from "react";
import { cx } from "./cx";

/**
 * A value typed into a well cut in the face.
 *
 * 16px on a phone: iOS zooms the whole page into any field set smaller than
 * that the moment it is focused, and leaves it zoomed after.
 */
export function Input({ className, ...rest }: ComponentProps<"input">) {
  return (
    <input
      className={cx(
        "mat-inset w-full rounded-md px-3 py-2 text-base text-foreground outline-none sm:text-sm",
        "placeholder:text-muted",
        className
      )}
      {...rest}
    />
  );
}

/**
 * The one number a ticket is about, written straight onto the face.
 *
 * Flat, and that is the point: this is the figure, not a field. Cutting a well
 * for it put the amount in a box among the other boxes on the panel, at the size
 * a box implies — while the amount is the thing the panel is *for*, and on every
 * market anybody has used it is the largest number on the ticket.
 *
 * A text input rather than a number one. `type="number"` draws a pair of spinner
 * arrows that no amount of `appearance` is reliably rid of across browsers, and
 * they are the wrong control anyway: a stake moves in fives and hundreds, which
 * is what the chips under it are. `inputMode` still brings up the numeric keypad.
 *
 * Sized to its own digits so the `$` stays against the number as it grows. The
 * face is monospaced, so a `ch` is exactly a digit.
 */
export function Amount({
  value,
  onValue,
  className,
  ...rest
}: {
  value: number;
  onValue: (n: number) => void;
} & Omit<ComponentProps<"input">, "value" | "onChange" | "type">) {
  const digits = Math.max(1, String(value).length);
  return (
    <span
      className={cx(
        "inline-flex items-baseline justify-end gap-0.5",
        "font-mono text-3xl leading-none tabular-nums text-foreground",
        className
      )}
    >
      <span aria-hidden="true" className="text-muted">
        $
      </span>
      <input
        type="text"
        inputMode="numeric"
        value={value}
        onChange={(e) => onValue(Math.max(0, Math.floor(Number(e.target.value.replace(/[^\d]/g, "")) || 0)))}
        style={{ width: `${digits}ch` }}
        className="min-w-0 border-0 bg-transparent p-0 text-right font-mono tabular-nums text-inherit outline-none"
        {...rest}
      />
    </span>
  );
}

/** The engraved caption over a field. Names a control, so it is a real label. */
export function Label({
  className,
  children,
  ...rest
}: { children?: ReactNode } & ComponentProps<"label">) {
  return (
    <label className={cx("mat-engrave block", CAPTION, className)} {...rest}>
      {children}
    </label>
  );
}

/**
 * The same engraved caption over something that is not a control — a readout, a
 * column, a group. A <label> here would name nothing, which reads to a screen
 * reader as a control that has gone missing.
 */
export function Caption({
  className,
  children,
  ...rest
}: { children?: ReactNode } & ComponentProps<"span">) {
  return (
    <span className={cx("mat-engrave block", CAPTION, className)} {...rest}>
      {children}
    </span>
  );
}

const CAPTION = "text-[10px] uppercase tracking-wider text-muted";
