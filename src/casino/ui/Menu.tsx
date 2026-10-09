import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { cx } from "./cx";
import { Panel, Seam } from "./Panel";

/**
 * A control that drops a panel of actions under itself.
 *
 * The account menu was the only one of these, and it carried its own copy of
 * the outside-click and Escape handling. The header now has a second — on a
 * phone, everything the header has no room for — so the behaviour lives here
 * once and both menus are just their contents.
 *
 * `trigger` draws the control and `children` the items; both are handed what
 * they need rather than a context, because a menu is two elements, not a tree.
 */
export function Menu({
  trigger,
  children,
  className,
}: {
  trigger: (state: { open: boolean; toggle: () => void }) => ReactNode;
  /** The items. `close` is for any that should dismiss the menu once used. */
  children: (close: () => void) => ReactNode;
  /** On the dropped panel — its width, mostly. */
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    // pointerdown, not click: a click listener fires after the target's own
    // handler has already re-opened the menu, so the toggle would never close.
    const onDown = (e: PointerEvent) => {
      if (!anchor.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  return (
    <div ref={anchor} className="relative">
      {trigger({ open, toggle: () => setOpen((v) => !v) })}
      {open && (
        <Panel
          role="menu"
          className={cx(
            "casino-animate-in absolute right-0 z-40 mt-2 p-3",
            // Never wider or taller than the screen it drops onto.
            "max-h-[calc(100dvh-5rem)] max-w-[calc(100vw-2rem)] overflow-y-auto overscroll-contain",
            className ?? "w-64"
          )}
        >
          {children(() => setOpen(false))}
        </Panel>
      )}
    </div>
  );
}

/**
 * One row of a menu.
 *
 * Taller on a phone: a menu row there is pressed with a thumb, and the desktop
 * row is sized for a pointer.
 */
const ITEM =
  "flex w-full items-center justify-between gap-3 rounded px-2 py-2.5 text-left text-sm text-secondary no-underline transition-colors sm:py-1.5 sm:text-xs " +
  "hover:bg-[color-mix(in_oklch,var(--foreground)_7%,transparent)] hover:text-foreground";

export function MenuItem({
  className,
  children,
  type = "button",
  ...rest
}: { children?: ReactNode } & ComponentProps<"button">) {
  return (
    <button type={type} role="menuitem" className={cx(ITEM, className)} {...rest}>
      {children}
    </button>
  );
}

export function MenuLink({
  className,
  children,
  ...rest
}: { children?: ReactNode } & ComponentProps<"a">) {
  return (
    <a role="menuitem" className={cx(ITEM, className)} {...rest}>
      {children}
    </a>
  );
}

/** A group of rows, seamed off from the group above it. */
export function MenuGroup({ first = false, children }: { first?: boolean; children?: ReactNode }) {
  return (
    <>
      {!first && <Seam className="mt-3" />}
      <div className={cx("flex flex-col gap-1", !first && "mt-2")}>{children}</div>
    </>
  );
}
