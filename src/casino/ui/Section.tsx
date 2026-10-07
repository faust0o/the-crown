import type { ReactNode } from "react";
import { cx } from "./cx";

/**
 * A region of the page with a name.
 *
 * Every section of the app is one of these and they all look the same: an
 * engraved caption, a rule under it, and the content on the page's own ground.
 * Nothing here is raised, and that is the point — the page had become a stack
 * of cards, each with its own shadow and its own idea of what a title looks
 * like, which made a screen of instruments read as a screen of receipts.
 *
 * The case, the keys, the lamps and the wells all stay physical. What went flat
 * is the *containers* — a panel that floats above the page is a claim that you
 * could pick it up, and there are only two things in the app you can: a dialog,
 * and a menu.
 */
export function Section({
  title,
  aside,
  className,
  bodyClassName,
  children,
}: {
  title: ReactNode;
  /** Opposite the caption: a total, a sync age, a status. */
  aside?: ReactNode;
  className?: string;
  bodyClassName?: string;
  children?: ReactNode;
}) {
  return (
    <section className={cx("mb-4 flex min-w-0 flex-col", className)}>
      <div className="mb-2 flex items-baseline justify-between gap-4 border-b border-hairline pb-1.5">
        <h2 className="mat-engrave m-0 text-xs font-semibold uppercase tracking-wider text-muted">
          {title}
        </h2>
        {aside != null && <div className="shrink-0 text-[11px] text-muted">{aside}</div>}
      </div>
      <div className={cx("min-w-0", bodyClassName)}>{children}</div>
    </section>
  );
}

/**
 * What a section shows when it has nothing to show.
 *
 * Its own component so an empty Flow and an empty Book are the same shape of
 * nothing, rather than each panel inventing a differently-padded sentence.
 */
export function Empty({ children }: { children?: ReactNode }) {
  return <p className="m-0 px-2 py-6 text-center text-xs text-muted">{children}</p>;
}
