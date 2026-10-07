# Spec — Positions, adding to bets, and market-making bots

> **Superseded in part.** Task 4 below built the market-making bots, which later
> grew from decoration into real accounts placing real bets and became the thing
> that set every price. They have since been removed: the board is priced by
> player flow alone, and `botTape` is now `orders`, a feed of the actual
> `CryptoBet` rows. Tasks 1–3 and 5 still describe the shipped behaviour. Kept as
> the record of what was asked for and when.

Repo: `/Users/ludwigschubert/the-crown`
App: **The Crown** — a play-money prediction game. Ten trending assets from
tokens.xyz compete on traded volume; players bet on where a token's **rank** at
the cut lands versus its rank when the round opened (HIGHER / DRAW / LOWER).

Client lives in `src/casino/crypto/`, server in `server/src/`.

## How to run and verify

```sh
# server (serves the built client too, on :4000)
cd server && node --env-file-if-exists=.env --import tsx src/index.ts

# client build (must pass before you claim done)
bun run build          # repo root: tsc -b && vite build && prerender
node_modules/.bin/tsc -b --force
bunx eslint src/casino/crypto
(cd server && bun run typecheck)
```

Only `bun` auto-loads `.env`; the npm scripts pass `--env-file-if-exists`.
After changing anything under `server/src/schema/`, run
`cd server && bun run nexus:reflect` or typecheck will fail on unknown types.

Browser checks: Playwright is available at
`/Users/ludwigschubert/.npm/_npx/e41f203b7505f1fb/node_modules` — symlink it as
`node_modules` next to your script and `chromium.launch({ channel: "chrome" })`.

Log in with a wallet: connect Phantom or Solflare and sign the sentence the
sign-in prompt shows. The signature is the whole of the auth — an address that
has never played gets an account the first time it signs one. There is no demo
bypass.

Rounds are 30 minutes (wall-clock aligned, so they open on the hour and
half hour) with the cut in the final minute. Use short rounds to see settlement
without waiting:
`ROUND_MINUTES=2 CUT_WINDOW_SECONDS=20`. **Important:** round length only applies
to newly-opened rounds — an in-flight round must end (or be retired in the DB)
before a new length takes effect.

---

## Task 1 — The book must not show the player's position

`src/casino/crypto/BetFlow.tsx` renders the simulated betting book for the
selected token. It currently takes a `bets` prop purely to draw a `+50` marker
on the side the player holds.

- Remove `bets` from `BetFlow` entirely; delete the marker and the `mine` map.
- Stop passing `bets` from `CryptoPage`.
- The book is a market view. It must look identical whether or not the player
  holds a position — the same rule already applied to the board's price chips.

**Done when:** no prop or styling in `BetFlow` varies with the player's bets, and
a Playwright check confirms the rendered book is byte-identical before and after
placing a bet on the selected token.

## Task 2 — Positions move below the buy panel

`BetPanel.tsx` currently ends with a "your position" block listing open lots with
Close buttons. Extract it.

- New `src/casino/crypto/Positions.tsx` exporting `Positions`.
- Rendered in the right rail of `CryptoPage`, directly **below** `BetPanel` and
  above `BetFlow`.
- Shows **all** of the player's positions in the current round, not only those on
  the selected token. Each row: token icon + ticker, direction, total stake,
  average odds, live value, P/L against stake, and a Close control.
- Clicking a row selects that token on the board (reuse `onSelect`).
- Card styling matching `BetPanel` (`rounded-lg border border-hairline bg-surface`).
- Empty state: "No open positions this round."

**Done when:** `BetPanel` no longer renders any position list, `Positions` shows
positions across multiple different tokens simultaneously, and closing from it
works.

## Task 3 — Adding to a bet at various prices

Today each `placeCryptoBet` inserts an independent `CryptoBet` row, so backing
the same token and side twice yields two separate positions at two different
odds. That is actually the correct storage model — **keep it**. No migration.

What changes is aggregation and presentation:

- A **position** is the set of open `CryptoBet` rows sharing
  `(roundId, symbol, direction)`. Aggregate for display:
  - `stake` = sum of lot stakes
  - `odds` = stake-weighted average: `Σ(stake_i × odds_i) / Σ stake_i`
  - `liveValue` = sum of per-lot `liveValue` (already computed server-side per
    lot in `crypto-views.ts`; do **not** re-derive from the average odds — each
    lot's shares were bought at its own price)
- Placing a bet on a token+direction you already hold must succeed and add a lot.
  Verify `placeCryptoBet` has no uniqueness constraint blocking this. It should
  not — but prove it with a test that places three lots at different moments.
- `Positions` shows one row per aggregate position, expandable to the individual
  lots.
- **Close** on an aggregate closes every lot in it, each at its own quote.
  Closing a single lot from the expanded view must also work.
- Closing must stay atomic per lot (`updateMany` guarded on `status: "OPEN"`).
  Closing an aggregate of 3 lots when one was already closed elsewhere must
  close the other 2 and not error.

**Done when:** a test places 3 lots on the same token+direction at different
times, sees one aggregate row with a weighted average entry, closes it, and the
credited amount equals the sum of the three individual lot quotes.

## Task 4 — Market-making bots

Simulated only. This is a play-money game; there is no counterparty model and
nothing here should pretend otherwise.

- New `server/src/bots.ts`. On each oracle publish (the oracle already only
  advances `updatedAt` when tokens.xyz returns new numbers — hook that, do not
  run on a bare timer), generate plausible bot activity:
  - Each bot has a stable identity (name, seeded from an id) and a bias.
  - They "trade" the lines whose price moved most since the last publish.
  - Emit events: bot name, token, direction, stake, price.
- Expose `botTape(limit: Int): [BotTrade!]!` over GraphQL. Keep a bounded
  in-memory ring; **do not persist** — this is decoration, not ledger.
- Bots must **not** touch the `User` or `CryptoBet` tables, and must not affect
  settlement or any player's credits.
- Client: show the bot tape in the right rail. Reuse the `casino-tape-in`
  entrance animation. Label it clearly as simulated activity — the real tape
  (`FlowFeed`) shows genuine rank changes and the two must not be confusable.

**Done when:** the tape populates and animates, and a test proves credits and bet
rows are untouched by bot activity over several publishes.

## Task 5 — Verify the settlement result screen

`src/casino/crypto/BetResult.tsx` exists and is wired but has **never been
observed firing**. It should appear once per bet as it flips out of `OPEN`.

- Drive it end to end: retire in-flight rounds, run with `ROUND_MINUTES=2`,
  redeem a code, place a bet, wait for the cut.
- Confirm: it appears exactly once per settled bet, the payout counts up, the
  credits in the header change to match, dismissing works, and it does not
  reappear on the next poll.
- If it never fires, find out why and fix it. The suspect is the
  `seen` ref in `CryptoPage` — it only queues a result when it has previously
  recorded that bet as `OPEN`, so a bet that first appears already-settled is
  silently skipped.

---

## Rules for all tasks

- Match the surrounding code's style. Comments explain *why*, never *what*.
- Every claim of "done" must be backed by something you ran. Do not report a
  feature working because the code looks right.
- If a task's premise is wrong, say so and stop rather than building on it.
- Do not touch: the crown mechanic, the commit-reveal cut, the wallet-signature
  login, or the oracle's tokens.xyz polling cadence.
- Report what you verified, what you could not, and anything you changed beyond
  the spec.
