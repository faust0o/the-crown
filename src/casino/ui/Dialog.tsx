import {
  useEffect,
  useRef,
  type FormEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { useScrollLock } from "../crypto/useScrollLock";
import { cx } from "./cx";
import { IconButton } from "./Button";
import { Seam } from "./Panel";

const WIDTH = {
  sm: "sm:max-w-sm",
  md: "sm:max-w-lg",
  lg: "sm:max-w-xl",
  xl: "sm:max-w-3xl",
} as const;

/**
 * Every dialog that is open, oldest first.
 *
 * Overlays stack — the ticket's sheet can put the wallet picker over itself —
 * and each one listens on the window. Only the one on top may answer Escape or
 * keep Tab inside itself: one Escape used to close every dialog on screen at
 * once, and two traps fought over the same keystroke.
 */
const stack: object[] = [];
const onTop = (token: object) => stack[stack.length - 1] === token;

/**
 * Everything a modal in this app has to get right, in one place.
 *
 * There were six of these, each re-deriving the scrim, the Escape key, the
 * scroll lock and the click-outside — and each getting a slightly different
 * subset of it right. Two things that were being claimed but not done are done
 * here: focus is genuinely *trapped* rather than merely moved on open, and it
 * is handed back to whatever opened the dialog on close, so dismissing one with
 * the keyboard does not drop you at the top of the document.
 *
 * On a phone it is a sheet: pinned to the bottom edge, full width, rounded only
 * across the top, and scrolling inside itself — the place a thumb already is,
 * and the shape every phone has taught people to dismiss by tapping above it.
 *
 * `onSubmit` turns the shell into a form. A single-field dialog needs that — a value
 * you can type is a code you expect Enter to send — and wrapping a whole
 * dialog in an outer <form> instead would put the scrim inside the form.
 */
export function Dialog({
  open,
  onClose,
  label,
  title,
  headerAside,
  footer,
  size = "sm",
  align = "center",
  alert = false,
  elevated = false,
  initialFocus,
  onSubmit,
  className,
  bodyClassName,
  children,
}: {
  open: boolean;
  onClose: () => void;
  /** Accessible name. Defaults to `title` when the dialog shows one. */
  label?: string;
  title?: ReactNode;
  /** Sits opposite the title in the header — a cluster tag, a count. */
  headerAside?: ReactNode;
  footer?: ReactNode;
  size?: keyof typeof WIDTH;
  /** `start` for dialogs tall enough to scroll the page behind them. */
  align?: "center" | "start";
  /** An outcome the player must acknowledge, rather than a task. */
  alert?: boolean;
  /**
   * Above any dialog already open. A settlement lands on its own schedule and
   * can arrive while the player is reading something else; it is the one
   * overlay in the app entitled to interrupt another.
   */
  elevated?: boolean;
  initialFocus?: RefObject<HTMLElement | null>;
  onSubmit?: (e: FormEvent) => void;
  className?: string;
  /** The body's classes, padding included — in place of the default `p-5`. */
  bodyClassName?: string;
  children?: ReactNode;
}) {
  const panel = useRef<HTMLElement | null>(null);
  const opener = useRef<Element | null>(null);
  /**
   * The latest `onClose`, read when a key needs it rather than subscribed to.
   *
   * Callers pass a fresh arrow on every render, and the page re-renders on
   * every poll. As a dependency it re-ran the effect below each time — which
   * re-focused the panel out from under whatever was being typed in it, every
   * two seconds, and would re-shuffle the stack of open dialogs.
   */
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });

  useScrollLock(open);

  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement;
    const token = {};
    stack.push(token);

    // Focus lands where the dialog says, and otherwise on the panel itself,
    // which is focusable only for this reason.
    //
    // Not on the close button by default. Moving focus into the dialog is
    // required — a keyboard user must not be left behind the scrim — but a
    // programmatic focus counts as `:focus-visible`, so the X lit up with a
    // full ring the instant any dialog opened, which reads as an error on the
    // one control you did not press. The panel takes focus silently, screen
    // readers still announce the dialog, and the first Tab still lands on the
    // close button.
    (initialFocus?.current ?? panel.current)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (!onTop(token)) return;
      if (e.key === "Escape") {
        close.current();
        return;
      }
      if (e.key !== "Tab" || !panel.current) return;
      // The trap. Without it Tab walks straight out of the dialog and into the
      // page underneath, which is inert to the mouse and not to the keyboard.
      const focusable = panel.current.querySelectorAll<HTMLElement>(
        'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panel.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      stack.splice(stack.indexOf(token), 1);
      // Back where they came from. Guarded because the opener can have been
      // unmounted by whatever the dialog just did.
      const back = opener.current;
      if (back instanceof HTMLElement && back.isConnected) back.focus();
    };
  }, [open, initialFocus]);

  if (!open) return null;

  // A callback ref rather than two typed ones: the shell is a <form> when the
  // dialog submits and a <div> otherwise, and React refs are invariant, so a
  // single useRef cannot be handed to both without a cast.
  const attach = (el: HTMLElement | null) => {
    panel.current = el;
  };

  const shell = {
    ref: attach,
    role: alert ? ("alertdialog" as const) : ("dialog" as const),
    "aria-modal": true,
    "aria-label": label ?? (typeof title === "string" ? title : undefined),
    tabIndex: -1,
    onClick: (e: MouseEvent) => e.stopPropagation(),
    className: cx(
      "mat-panel mat-grain casino-dialog w-full outline-none",
      // The sheet: scrolls inside itself, and clears the home indicator.
      "max-h-[92dvh] overflow-y-auto overscroll-contain rounded-t-2xl pb-[env(safe-area-inset-bottom)]",
      "sm:rounded-xl sm:pb-0",
      WIDTH[size],
      align === "center" ? "sm:max-h-[85dvh]" : "sm:max-h-none sm:overflow-hidden",
      className
    ),
  };

  const inner = (
    <>
      {/* The grip a sheet is drawn with. Only a sheet has one. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-1.5 left-1/2 z-10 h-1 w-9 -translate-x-1/2 rounded-full bg-foreground/20 sm:hidden"
      />
      {(title || headerAside) && (
        <>
          <div className="mat-plate flex items-center justify-between gap-4 px-5 pt-4 pb-3 sm:pt-3">
            <h2 className="mat-engrave m-0 text-base font-semibold text-foreground">
              {title}
            </h2>
            <div className="flex shrink-0 items-center gap-2">
              {headerAside}
              <IconButton label="Close" size="sm" onClick={onClose}>
                <CloseGlyph />
              </IconButton>
            </div>
          </div>
          <Seam />
        </>
      )}

      {/* `bodyClassName` replaces the padding rather than adding to it: two
          paddings on one element are decided by stylesheet order, not by which
          was written last, and `p-5` was beating every caller's `p-0`. */}
      <div className={bodyClassName ?? "p-5"}>{children}</div>

      {footer && (
        <>
          <Seam />
          <div className="mat-plate px-5 py-3">{footer}</div>
        </>
      )}
    </>
  );

  return (
    <div
      className={cx(
        "mat-scrim fixed inset-0 flex items-end justify-center overscroll-contain sm:p-4",
        elevated ? "z-[60]" : "z-50",
        align === "start" ? "sm:items-start sm:overflow-y-auto sm:py-10" : "sm:items-center"
      )}
      onClick={onClose}
    >
      {onSubmit ? (
        <form {...shell} onSubmit={onSubmit}>
          {inner}
        </form>
      ) : (
        <div {...shell}>{inner}</div>
      )}
    </div>
  );
}

function CloseGlyph() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true" fill="none">
      <path
        d="M4 4l8 8M12 4l-8 8"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
