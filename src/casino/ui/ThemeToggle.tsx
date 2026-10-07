import {
  setPreference,
  useThemePreference,
  type ThemePreference,
} from "../theme";
import { IconButton } from "./Button";

/**
 * One key that cycles: match system → light → dark → match system.
 *
 * A three-position switch was the honest way to draw three states, and it cost
 * three keys' worth of header for a control almost nobody touches twice. A
 * single key that steps through them is the hardware answer — the legend on the
 * key is the state it is *in*, and pressing it moves to the next one.
 *
 * "Auto" stays in the cycle rather than being the state you get by never having
 * pressed anything. A control that can only reach two of its three positions
 * has thrown the third away the first time it is used.
 */
const NEXT: Record<ThemePreference, ThemePreference> = {
  auto: "light",
  light: "dark",
  dark: "auto",
};

const NAME: Record<ThemePreference, string> = {
  auto: "matching the system",
  light: "light",
  dark: "dark",
};

export function ThemeToggle({ className }: { className?: string }) {
  const preference = useThemePreference();
  const next = NEXT[preference];

  return (
    <IconButton
      variant="key"
      size="md"
      className={className}
      // Both halves matter: a screen reader needs to know what the theme is now,
      // and a button whose icon is its state is otherwise indistinguishable from
      // a button whose icon is its action.
      label={`Theme: ${NAME[preference]}. Switch to ${NAME[next]}.`}
      onClick={() => setPreference(next)}
    >
      {preference === "light" ? (
        <SunGlyph />
      ) : preference === "dark" ? (
        <MoonGlyph />
      ) : (
        <AutoGlyph />
      )}
    </IconButton>
  );
}

/**
 * Drawn rather than emoji: an emoji sun renders in whatever colour the
 * platform's font decides, which on a panel of engraved marks is the one thing
 * on screen ignoring the theme it exists to change.
 */
const STROKE = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

function SunGlyph() {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden="true" {...STROKE}>
      <circle cx="10" cy="10" r="3.4" />
      <path d="M10 2.6v1.8M10 15.6v1.8M17.4 10h-1.8M4.4 10H2.6M15.2 4.8l-1.3 1.3M6.1 13.9l-1.3 1.3M15.2 15.2l-1.3-1.3M6.1 6.1L4.8 4.8" />
    </svg>
  );
}

function MoonGlyph() {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden="true" {...STROKE}>
      <path d="M16.2 12.3A6.8 6.8 0 0 1 7.7 3.8a6.9 6.9 0 1 0 8.5 8.5Z" />
    </svg>
  );
}

/** A display, because "auto" means whatever the machine is already doing. */
function AutoGlyph() {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden="true" {...STROKE}>
      <rect x="2.6" y="4.2" width="14.8" height="9.6" rx="1.6" />
      <path d="M7.4 16.6h5.2" />
    </svg>
  );
}
