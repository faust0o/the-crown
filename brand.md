# Brand — The Crown

The game ships a self-contained skeuomorphic theme: a physical instrument, with
a case, keys, lamps, cut wells and walnut trim. `src/index.css` is the source of
truth and this file only describes it.

- **Two objects, not two palettes.** Dark is walnut, dark anodised aluminium and
  amber glass. Light is ivory ABS, brushed aluminium and the same walnut, lit by
  daylight. Both are built from one set of *material* tokens — which way a bevel
  catches light, how deep a well is cut, what the glass glows — so the recipes
  in `.mat-*` are written once and the two themes are two lighting conditions
  over one construction, not two sets of shadows.
- **The controls are physical; the containers are not.** Buttons, chips,
  toggles, fields, lamps and the header rail carry the full material treatment.
  Sections of a page do not: they are a caption, a rule, and content on the
  page's own ground. A raised panel is a claim that you could pick the thing up,
  and there are exactly two things in the app you can — a dialog and a menu.
  Everything was a card once, and a screen of instruments read as a stack of
  receipts.
- **One section, one title.** Every region of every screen is `Section`, so the
  board, the book, the flow, the order tape and the portfolio tables all
  announce themselves the same way instead of each inventing a heading.
- **Data stays calm.** Board rows, tape rows and tables keep flat grounds and
  tabular figures. The page repaints every two seconds; nothing that moves that
  often should also be embossed.
- **The clock is in the case.** The countdown is the one number relevant on
  every screen, so it lives in the header rather than in a bar that scrolls
  away. The round's commitment hash is not shown: it is a proof, not a reading,
  and it belongs with a settled round rather than in the chrome of a live one.
- **Lit means active.** The glass key is the one control on screen that is
  currently doing something. A row of lamps all claiming to be active says
  nothing, so every other icon is etched into the face instead.
- **Blue in, amber out.** `--buy` and `--sell` are the only colours that mean a
  direction of *money*; `--up`/`--down` mean a direction of rank. Placing a bet
  and the "bought" line on the order tape are blue; closing a position and
  "sold" are amber. `--gold` stays reserved for the crown.
- **Three themes, one of which is "auto".** Light, dark, or follow the system —
  one key in the header that cycles through all three, because a two-state
  toggle can only express "follow the system" by never having been pressed, and
  throws it away the first time it is used. The choice is stored
  under `crown:theme` and resolved to a `data-theme` attribute by an inline
  script in `index.html`, before the first paint; `src/casino/theme.ts` owns it
  from there. The palette itself is still pure CSS.
- **Contrast is checked, not eyeballed.** Every foreground/background pair in
  the token block clears WCAG AA, measured in oklch rather than judged by eye.
  `--text-muted` on `--inset` is the tightest pairing in light and the one to
  re-check when editing. Two rules fall out of that and are worth knowing before
  reaching for a colour: the legend on a lit key is `--on-accent`, a near-black,
  in *both* themes — amber and blue both sit mid-luminance, so neither white nor
  black clears AA on them at every brightness the key is drawn at. And `--accent`
  and `--buy` are **fills**; anything set as type or drawn as a hairline uses
  `--accent-ink` / `--buy-ink`, which clear 4.5:1 on every surface.
- **Voice.** Plain and specific. Numbers are the interface; prose exists to say
  what a number means, not to sell it.

## Where things live

| path                   | what it is                                              |
| ---------------------- | ------------------------------------------------------- |
| `src/index.css`        | the tokens, both themes, and the `.mat-*` material recipes |
| — note                 | the recipes live in `@layer components`, so Tailwind utilities can still override them; unlayered, they silently beat every utility |
| `src/casino/ui/`       | the primitives every screen composes                    |
| `src/casino/theme.ts`  | the light/dark/auto store                               |
| `index.html`           | the pre-paint script that resolves the theme            |

A component that needs a new look should want a new primitive or a new token,
not a shadow written inline.
