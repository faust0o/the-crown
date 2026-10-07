import { useSyncExternalStore } from "react";

/**
 * The theme, as a value React can read and a person can change.
 *
 * Three preferences, two schemes. "auto" is not a scheme — it is a standing
 * instruction to follow the system, so it has to be stored as itself rather
 * than resolved once and written down, or the choice would silently freeze to
 * whatever the OS happened to be doing the day it was made.
 *
 * This is a module-level store rather than a context because two very different
 * consumers need it: the toggle in the header, and a canvas-drawn chart deep in
 * the tree that takes its colours as props. A store both can subscribe to means
 * neither has to be positioned under a provider.
 *
 * The palette itself is still entirely CSS — see the token block in index.css.
 * Nothing here knows a colour. All it does is decide which of the two token
 * sets is live, by stamping `data-theme` on <html>; index.html does the same
 * thing once, inline, before the first paint.
 */

export type ThemePreference = "light" | "dark" | "auto";
export type ColorScheme = "light" | "dark";

/** Shared with the boot script in index.html. Changing it means changing both. */
const KEY = "crown:theme";
const QUERY = "(prefers-color-scheme: dark)";

const listeners = new Set<() => void>();

/**
 * Cached rather than read from storage per call.
 *
 * `useSyncExternalStore` calls the snapshot on every render and bails out only
 * when the value is identical, so a getter that touched `localStorage` each time
 * would put a synchronous disk read in the render path — and, in Safari's
 * private mode, a throw.
 */
let preference: ThemePreference = read();

function read(): ThemePreference {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === "light" || stored === "dark" || stored === "auto") return stored;
  } catch {
    /* private mode — the default below is the answer */
  }
  return "auto";
}

function systemScheme(): ColorScheme {
  return typeof window !== "undefined" && window.matchMedia(QUERY).matches ? "dark" : "light";
}

export function resolve(p: ThemePreference): ColorScheme {
  return p === "auto" ? systemScheme() : p;
}

/** Stamp the resolved scheme on <html>, which is what the token blocks select on. */
function apply() {
  document.documentElement.setAttribute("data-theme", resolve(preference));
}

export function setPreference(next: ThemePreference) {
  preference = next;
  try {
    // "auto" is stored, not cleared: an absent key and an explicit "follow the
    // system" look identical to the boot script, and only one of them should
    // survive the system changing under a person who chose a fixed theme.
    localStorage.setItem(KEY, next);
  } catch {
    /* the preference still holds for this tab */
  }
  apply();
  for (const l of listeners) l();
}

/**
 * Subscribe once, to three things that can move the theme: the system, another
 * tab, and this tab's own toggle.
 *
 * The system query is watched unconditionally rather than only while the
 * preference is "auto" — the listener is idempotent, and gating it would mean
 * re-subscribing every time the preference changed for no gain.
 */
function subscribe(onChange: () => void) {
  listeners.add(onChange);
  const mql = window.matchMedia(QUERY);
  const onSystem = () => {
    if (preference === "auto") {
      apply();
      onChange();
    }
  };
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY) return;
    preference = read();
    apply();
    onChange();
  };
  mql.addEventListener("change", onSystem);
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    mql.removeEventListener("change", onSystem);
    window.removeEventListener("storage", onStorage);
  };
}

/**
 * The scheme is derived, never stored, so it is recomputed in the snapshot.
 *
 * Both strings are interned literals, so an unchanged scheme compares equal and
 * React bails out — this does not re-render on every check.
 */
const snapshot = () => resolve(preference);

/**
 * The colour scheme in force. For the one thing CSS cannot reach: a component
 * that takes its theme as a prop rather than reading custom properties.
 * Everything else should use the tokens and needs nothing from this.
 */
export function useColorScheme(): ColorScheme {
  return useSyncExternalStore(subscribe, snapshot, () => "dark");
}

/** The preference itself — what the toggle shows selected, including "auto". */
export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(
    subscribe,
    () => preference,
    () => "auto" as const
  );
}

/**
 * Re-apply on load.
 *
 * The boot script has already done this, and in the common case this changes
 * nothing. It matters when the two could disagree — a page restored from the
 * back/forward cache, or a preference written by another tab before this one
 * finished starting — and it costs one attribute write.
 */
if (typeof document !== "undefined") apply();
