/**
 * The five things a control can be *about*, as names rather than colours.
 *
 * Kept in its own module because everything else in `ui/` exports components,
 * and a file that exports both a component and a constant breaks Fast Refresh
 * for the whole file.
 */
export type Tone = "up" | "down" | "gold" | "accent" | "buy" | "sell" | "neutral";

/** Tone names resolve to tokens, so nothing downstream carries a literal colour. */
export const TONE_COLOR: Record<Tone, string> = {
  up: "var(--up)",
  down: "var(--down)",
  gold: "var(--gold)",
  accent: "var(--accent-ink)",
  // The ink variants: these are read as type and as hairlines, and the fills
  // they name do not clear 4.5:1 at that weight.
  buy: "var(--buy-ink)",
  sell: "var(--sell-ink)",
  neutral: "var(--text-muted)",
};
