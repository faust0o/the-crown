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
  sm: "max-w-sm",
  md: "max-w-lg",
  lg: "max-w-xl",
  xl: "max-w-3xl",
} as const;

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
  bodyClassName?: string;
  children?: ReactNode;
}) {
  const panel = useRef<HTMLElement | null>(null);
  const opener = useRef<Element | null>(null);

  useScrollLock(open);

  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement;

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
      if (e.key === "Escape") {
        onClose();
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
      // Back where they came from. Guarded because the opener can have been
      // unmounted by whatever the dialog just did.
      const back = opener.current;
      if (back instanceof HTMLElement && back.isConnected) back.focus();
    };
  }, [open, onClose, initialFocus]);

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
      "mat-panel mat-grain casino-animate-in w-full overflow-hidden rounded-xl outline-none",
      WIDTH[size],
      align === "center" && "max-h-[85dvh] overflow-y-auto",
      className
    ),
  };

  const inner = (
    <>
      {(title || headerAside) && (
        <>
          <div className="mat-plate flex items-center justify-between gap-4 px-5 py-3">
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

      <div className={cx("p-5", bodyClassName)}>{children}</div>

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
        "mat-scrim fixed inset-0 flex justify-center p-4",
        elevated ? "z-[60]" : "z-50",
        align === "start" ? "items-start overflow-y-auto py-10" : "items-center"
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
