# Brand — The Crown

The game ships a self-contained "trading floor" theme, scoped to the `.casino`
class in `src/index.css` and layered over the neutral `:root` tokens.

- **Palette.** Cooler, bluer neutrals than a plain grey ramp, with red/green
  directional accents for up/down markets and a gold for the crown itself.
  Light and dark both exist as token sets; the browser picks via
  `prefers-color-scheme` before the first paint, never in JavaScript.
- **Contrast is checked, not eyeballed.** Every foreground/background pair in
  the token block clears WCAG AA. `--text-muted` on `--inset` is the tightest
  pairing and the one to re-check when editing.
- **Voice.** Plain and specific. Numbers are the interface; prose exists to say
  what a number means, not to sell it.

Colours and typography live in `src/index.css` — that file is the source of
truth, and this one only describes it.
