import type { ReactNode } from "react";
import { cx } from "./cx";

export interface Segment<T extends string> {
  value: T;
  label: ReactNode;
  /** Named for screen readers when `label` is only an icon. */
  title?: string;
}

/**
 * A switch with more than two positions: a track cut into the face, and one
 * raised key sitting in it.
 *
 * `tabs` swaps the ARIA from a radio group to a tab list. The two look
 * identical and mean different things — a tab list says the thing below is
 * about to change, a radio group says a setting is — and the only view that
 * gets it wrong is one that has to choose without being asked.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  tabs = false,
  size = "md",
  block = false,
  className,
}: {
  options: readonly Segment<T>[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  tabs?: boolean;
  size?: "sm" | "md";
  /** Fill the width of whatever holds it, the positions sharing it evenly. */
  block?: boolean;
  className?: string;
}) {
  return (
    <div
      role={tabs ? "tablist" : "radiogroup"}
      aria-label={label}
      className={cx(
        "mat-inset items-center gap-0.5 rounded-lg p-1",
        block ? "flex w-full" : "inline-flex",
        className
      )}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role={tabs ? "tab" : "radio"}
            {...(tabs ? { "aria-selected": on } : { "aria-checked": on })}
            title={o.title}
            aria-label={o.title}
            onClick={() => onChange(o.value)}
            className={cx(
              "relative inline-flex items-center justify-center gap-1.5 rounded-md",
              "transition-colors",
              block && "flex-1",
              size === "sm" ? "h-6 px-2 text-[11px]" : "h-7 px-3 text-xs",
              on
                ? "mat-key mat-engrave font-semibold text-foreground"
                : "text-muted hover:text-foreground"
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
