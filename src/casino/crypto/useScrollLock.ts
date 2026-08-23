import { useEffect } from "react";

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
    const previousOverflow = body.style.overflow;
    const previousPadding = body.style.paddingRight;
    const gutter = window.innerWidth - document.documentElement.clientWidth;

    body.style.overflow = "hidden";
    if (gutter > 0) body.style.paddingRight = `${gutter}px`;

    return () => {
      body.style.overflow = previousOverflow;
      body.style.paddingRight = previousPadding;
    };
  }, [locked]);
}
