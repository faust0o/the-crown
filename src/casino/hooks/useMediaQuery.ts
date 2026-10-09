import { useCallback, useSyncExternalStore } from "react";

/**
 * The page is wide enough to stand the ticket beside the board — Tailwind's
 * `lg`. Below it the ticket is a sheet over the board rather than a column next
 * to it, and the components that change shape with it read this one query so
 * the CSS breakpoints and the JavaScript ones cannot disagree.
 */
export const WIDE = "(min-width: 1024px)";

/** Past a phone held upright — Tailwind's `sm`. */
export const ROOMY = "(min-width: 640px)";

/**
 * Whether a media query matches, kept current as it changes.
 *
 * For layout that has to differ in what it *renders*, not only in how it looks:
 * a ticket in a column or in a sheet is one component mounted in one of two
 * places, and mounting it in both and hiding one with CSS would run its quote
 * polling twice and split its state between two copies.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query]
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false
  );
}
