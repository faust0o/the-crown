import type { ComponentPropsWithoutRef, ElementType, ReactNode } from "react";
import { cx } from "./cx";

/**
 * The case of something: a raised face with a lit top edge, a shaded bottom
 * one, and a shadow under it.
 *
 * Reserved for the two things in the app that genuinely sit above the page: a
 * dialog and a menu. Sections of a page are not among them — see `Section`.
 * Everything was a panel once, and a screen of instruments read as a stack of
 * receipts.
 *
 * `flush` drops the cast shadow, for a panel that is part of the case rather
 * than resting on it — the header rail. Nothing floats above a surface it is
 * screwed to.
 */
export function Panel({
  as,
  flush = false,
  className,
  children,
  ...rest
}: {
  as?: ElementType;
  flush?: boolean;
  className?: string;
  children?: ReactNode;
} & Omit<ComponentPropsWithoutRef<"div">, "className" | "children">) {
  const Tag = as ?? "div";
  return (
    <Tag
      className={cx(
        flush ? "mat-panel-flush" : "mat-panel",
        "mat-grain overflow-hidden rounded-xl",
        className
      )}
      {...rest}
    >
      {children}
    </Tag>
  );
}

/** A bevelled seam between two regions of one face. Replaces a flat border. */
export function Seam({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cx("mat-seam", className)} />;
}
