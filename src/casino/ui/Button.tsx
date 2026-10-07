import type { ComponentProps, ReactNode } from "react";
import { cx } from "./cx";

type Variant = "glass" | "key" | "ghost";
type Size = "xs" | "sm" | "md" | "lg";

/**
 * Which way the money is going, for the controls where that is the point.
 *
 * Only `glass` reads it: a buy lights blue and a sell lights amber, which is
 * also the default, so an ordinary primary action needs to say nothing.
 */
type Side = "buy" | "sell";

const SIZE: Record<Size, string> = {
  xs: "h-6 rounded-md px-2 text-[11px]",
  sm: "h-7 rounded-md px-2.5 text-xs",
  md: "h-9 rounded-lg px-3.5 text-sm",
  lg: "h-11 rounded-lg px-4 text-sm",
};

const VARIANT: Record<Variant, string> = {
  // The lit amber key. One per view, on the thing the view is for.
  glass: "mat-glass font-semibold",
  // Brushed metal. Everything else that is a button.
  key: "mat-key mat-grain text-foreground mat-engrave",
  // Not a key at all — a legend on the case that happens to be pressable.
  ghost:
    "text-muted transition-colors hover:text-foreground disabled:opacity-40 disabled:hover:text-muted",
};

/**
 * A pressable control.
 *
 * Three materials, and the choice between them is a claim about importance
 * rather than a colour: glass is lit and there should be one of it on screen,
 * metal is every other real button, and ghost is a legend that responds. The
 * physics — the travel on press, the shadow collapsing under it — lives in the
 * `.mat-*` recipes so both themes press identically.
 */
export function Button({
  variant = "key",
  side,
  size = "md",
  block = false,
  className,
  children,
  type = "button",
  ...rest
}: {
  variant?: Variant;
  side?: Side;
  size?: Size;
  /** Fill the width of whatever holds it. */
  block?: boolean;
  children?: ReactNode;
} & ComponentProps<"button">) {
  return (
    <button
      type={type}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 whitespace-nowrap",
        "disabled:cursor-not-allowed",
        // A button in a tight row must not be squashed to fit — except a
        // full-width one, which has to be allowed to give way. Two `block`
        // buttons side by side each ask for 100%, and with `shrink-0` on both
        // neither could yield: a two-button dialog footer had its right button pushed
        // clean outside the panel. Letting them shrink settles them at half
        // each, which is what a row of two full-width buttons means.
        !block && "shrink-0",
        variant !== "ghost" && SIZE[size],
        VARIANT[variant],
        variant === "glass" && side === "buy" && "mat-glass-buy",
        block && "w-full",
        className
      )}
      {...rest}
    >
      {/* Above the specular cap, which is drawn on the button's own ::before. */}
      <span className="relative inline-flex items-center justify-center gap-1.5">
        {children}
      </span>
    </button>
  );
}

const DOME_SIZE: Record<Size, string> = {
  xs: "h-6 w-6",
  sm: "h-7 w-7",
  md: "h-8 w-8",
  lg: "h-10 w-10",
};

/**
 * A round control carrying an icon and no words.
 *
 * `dome` is the lit glass bubble from the reference and is reserved the way the
 * reference reserves it — the one control that is currently *doing* something.
 * `etched` is the rest of the row: an outline cut into the face, which is what
 * the other icons on that bar are. Reaching for a dome per icon would leave a
 * bar of lamps all claiming to be active.
 */
export function IconButton({
  label,
  variant = "etched",
  size = "md",
  className,
  children,
  type = "button",
  ...rest
}: {
  /** Required: the control has no visible text to name it. */
  label: string;
  variant?: "dome" | "etched" | "key";
  size?: Size;
  children?: ReactNode;
} & Omit<ComponentProps<"button">, "aria-label">) {
  const material =
    variant === "dome"
      ? "mat-glass mat-dome"
      : variant === "key"
        ? "mat-key mat-grain rounded-full text-foreground"
        : "rounded-full text-muted transition-colors hover:text-foreground hover:bg-[color-mix(in_oklch,var(--foreground)_8%,transparent)]";

  return (
    <button
      type={type}
      aria-label={label}
      title={rest.title ?? label}
      className={cx(
        "grid shrink-0 place-items-center disabled:cursor-not-allowed disabled:opacity-40",
        DOME_SIZE[size],
        material,
        className
      )}
      {...rest}
    >
      <span className="relative grid place-items-center">{children}</span>
    </button>
  );
}
