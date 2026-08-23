import { useSyncExternalStore } from "react";

/**
 * The colour scheme the browser has resolved, as a value React can read.
 *
 * The palette itself is pure CSS — see the token block in index.css — and needs
 * nothing from JavaScript. This exists for the one thing CSS cannot reach: a
 * canvas-drawn component that takes its theme as a prop rather than reading
 * custom properties. Keep it for those, not for styling.
 *
 * Subscribed rather than read once, so dragging the OS between light and dark
 * repaints the chart along with everything else instead of leaving it on
 * whichever scheme happened to be active when the page loaded.
 */
const QUERY = "(prefers-color-scheme: dark)";

function subscribe(onChange: () => void) {
  const mql = window.matchMedia(QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

export function useColorScheme(): "light" | "dark" {
  return useSyncExternalStore(
    subscribe,
    () => (window.matchMedia(QUERY).matches ? "dark" : "light"),
    // Client-only in practice, but a server snapshot must exist and must not
    // touch matchMedia — "light" is the safe answer for one.
    () => "light"
  );
}
