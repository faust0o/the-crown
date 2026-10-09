import { useEffect } from "react";

/**
 * How many overlays currently want the page frozen, and what the body looked
 * like before the first of them arrived.
 *
 * Counted rather than saved per caller, because overlays stack — the ticket's
 * sheet can put the wallet picker over itself — and do not always close in the
 * order they opened. Each one restoring what *it* found would let the first to
 * close unlock a page another is still covering, or the last to close re-lock
 * it for good with the `hidden` it saved from its neighbour.
 */
let holders = 0;
let saved: { overflow: string; paddingRight: string } | null = null;

/**
 * Freeze the page behind an open overlay.
 *
 * Compensates for the scrollbar's width while locked — setting `overflow:
 * hidden` alone removes the scrollbar and the whole layout jumps sideways as
 * the dialog opens.
 */
export function useScrollLock(locked: boolean): void {
  useEffect(() => {
    if (!locked) return;
    const { body } = document;
    if (holders++ === 0) {
      saved = { overflow: body.style.overflow, paddingRight: body.style.paddingRight };
      const gutter = window.innerWidth - document.documentElement.clientWidth;
      body.style.overflow = "hidden";
      if (gutter > 0) body.style.paddingRight = `${gutter}px`;
    }

    return () => {
      if (--holders > 0 || !saved) return;
      body.style.overflow = saved.overflow;
      body.style.paddingRight = saved.paddingRight;
      saved = null;
    };
  }, [locked]);
}
