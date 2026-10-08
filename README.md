# The Crown

Solana's top assets, ranked by volume. Ten majors race for the crown, and
players bet on where each one's **rank** at the cut lands versus its rank when
the round opened — HIGHER / DRAW / LOWER.

Three pieces, one deploy:

| path      | what it is                                                        |
| --------- | ----------------------------------------------------------------- |
| `src/`    | the React + Vite SPA                                              |
| `server/` | the Apollo/Nexus GraphQL API (Postgres via Prisma), which also serves the built SPA |
| `crown/`  | the Anchor program the on-chain half settles against              |

Split out of the Utopian Contributors website, where it lived at `/casino`;
that is why the client still sits under `src/casino/`.

## How a line is priced

**A line's price is its share of the credits behind its coin.** The three
outcomes on an asset are exhaustive, so what is staked on each one, over what is
staked on all of them, is a probability already; that number in cents is the
mark. There is no coefficient between the book and the price and nothing damps
how far a credit can move it.

Two things put credits in the book. The opening auction stakes
`MARKET_OPENING_POOL` credits across a coin's lines in proportion to the model's
prior, so an untouched book quotes the prior exactly — that is the model's entire
say, and every credit traded after it dilutes it. Everything else is players. A
bet joins the pool and moves the mark; closing takes it back out, so a round trip
costs the spread and nothing else, at any size.

There is no market maker. Until recently there were eight simulated ones — real
accounts, real bets, sized off a fair-value model — and they were what dragged a
line toward the outcome as a round ran. They are gone, along with the model that
told them where to aim. What that buys is that the board says what the room
thinks; what it costs is that a line nobody trades sits at its opening prior all
round, and a line the room has wrong stays wrong until somebody takes the other
side. That is the trade being offered.

The whole of it lives in `server/src/market.ts`, and nothing outside that module
may invent a price. `Orders` in the client is the flow that moved them: every bet
opened and every position closed this round, off the `CryptoBet` rows themselves.

## Develop

```sh
bun install
bun dev                  # the whole stack: GraphQL on :4000, Vite on :5173
```

`bun dev` runs `server:prepare`, applies pending migrations to the database in
`server/.env` (`prisma migrate deploy` — never `migrate dev`, which can offer to
reset it), then runs the API and Vite side by side; Ctrl-C stops both. Open
:5173 — under `bun dev` a page asked of :4000 is redirected there, since what
:4000 would otherwise serve is `dist/`, the last build, not the code. Postgres
itself is yours to have running. `dev:server` and `dev:client` start either half
on its own.

`server/` is a separate package with its own `package.json` and lockfile, so a
root `bun install` does not reach it — and the Prisma client it imports is
generated, not committed. `server:prepare` covers both, which is why `bun dev`
runs it every time.

**Login is your wallet.** Connect Phantom or Solflare and sign the sentence the
server hands back — `walletChallenge` issues a single-use nonce,
`walletLogin` checks the signature (`server/src/wallet-auth.ts`) and finds or
creates the account behind that address. Nothing is minted, nothing is
registered, and there is no code to have been given.

## Build and serve

```sh
bun run start        # prepare, typecheck, build, migrate, serve on :4000
```

Each step is a gate on the next:

| step             | what it does                                        | why it's here                                                                                      |
| ---------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `server:prepare` | `bun install --frozen-lockfile` + `prisma generate` | the deploy container only runs `bun install` at the repo root, and `server/` is a separate package  |
| `server:check`   | `tsc --noEmit` over `server/`                        | production runs TypeScript through `tsx`, so nothing else would ever typecheck it                   |
| `build`          | `tsc -b` → `vite build` → `scripts/prerender.mjs`    | the prerender step inlines the stylesheet, so a cold load is one request to first paint             |
| `server:migrate` | `prisma migrate deploy`, then `migrate status`       | **generating a Prisma client is not migrating a database**                                          |

That last one is the one worth spelling out. `prisma generate` builds a client
that knows about the columns in `schema.prisma`; it does not put them in the
database. A deploy carrying a schema change used to ship a client that expected
columns Postgres did not have — and nothing failed at boot. It failed later, on
the first query touching the new column, in the middle of a live round.
`scripts/migrate.mjs` applies the migrations and then re-checks that none are
pending, and a container that cannot do both refuses to start rather than
opening a book against a schema it does not understand.

Set `NODE_ENV=production` on the deploy. It is what enables HSTS, disables
GraphQL introspection, the Apollo landing page and stack traces in errors. See
`server/.env.example`.

Set `SITE_ORIGIN=https://thecrowngame.fun` when building, so the link-preview
card resolves to an absolute URL. Set `CLIENT_DIR` to serve a build from
somewhere other than `<repo>/dist`.

The on-chain half is off by default and is its own document:
[`docs/deploy-chain.md`](docs/deploy-chain.md).

## The livestream

`/live` is a password-protected studio that broadcasts the race to any number
of RTMP destinations — YouTube, Twitch, Kick, X — with uploaded MP3s looping
underneath. When a round's cut lands, the chart fades out and the winner is
shown taking the crown, then the chart comes back.

Set `LIVE_PASSWORD` to switch it on; unset, every `/api/live` route is a 404.
The server needs ffmpeg, which Railpack installs from
`RAILPACK_DEPLOY_APT_PACKAGES=ffmpeg` (already in `.railway/railway.ts`).

```
browser tab (/live)                         server                         platforms
canvas 1280×720 ─┐                    ┌─ encoder ffmpeg ─┬─ pusher ffmpeg ─► rtmp://…/key
music (WebAudio) ┴─ MediaRecorder ─ws─┤  WebM → H.264/AAC│─ pusher ffmpeg ─► rtmps://…/key
                    (WebM, 0.5 s)     └─  as MPEG-TS     └─ …one per destination
```

The page *is* the broadcaster: it draws the scene (`src/live/scene.ts`) onto a
canvas, records it with the music, and streams the recording up a WebSocket.
The server encodes once and copies the result to each destination in its own
process, so one destination dropping, being added or being switched off never
interrupts the others, and a dropped one reconnects on a backoff
(`server/src/live/broadcast.ts`). Two things follow from that design:

- **The stream runs while the tab is open.** Keep it on a machine that stays
  up, in a window that stays visible: a hidden tab keeps broadcasting, but
  liveline only animates the chart while the tab is on screen.
- **Stream keys never come back to the browser.** They are written to the
  volume (`LIVE_DIR`, mode 0600) and redacted out of ffmpeg's error lines.

Destinations and music live on the volume beside the token logos, not in
Postgres. Uploads go up in 2 MB parts, because the server gives any one
request 30 seconds to arrive.

## How requests are defended

Four layers, each answering a question the others can't.

| layer                  | file                          | question                                     |
| ---------------------- | ----------------------------- | -------------------------------------------- |
| HTTP                   | `server/src/http.ts`          | headers, per-IP budgets, socket timeouts     |
| document               | `server/src/schema/limits.ts` | may this *query* be asked at all?            |
| field                  | `server/src/schema/guards.ts` | may this caller call this field, this often? |
| resolver / transaction | `bets.ts`, `rounds.ts`        | is this a legal move, and does it balance?   |

The field guards are `graphql-middleware` and are applied in `schema/index.ts`,
so there is no way to build an unguarded schema — a test or a script gets the
same one the API serves. Anything authenticated reads its user through
`callerId(ctx)`, which throws if a field ever loses its guard rather than
silently serving an anonymous caller.

The document limits exist because rate limiting counts *requests*, and one
request can ask for the same field five hundred times under five hundred
aliases. Costing is schema-aware: only fields that actually return a list
multiply their selection.

Two properties worth not breaking:

- **Session tokens are stored as sha256, never in the clear** (`auth.ts`). The
  plaintext exists once, in the reply to `walletLogin`.
- **`/logo` will not connect to a private address.** The check is in the
  dispatcher's DNS lookup (`logo-proxy.ts`), so it covers every redirect hop and
  leaves no rebinding window — and it does not rewrite the URL to an IP, which
  would break TLS validation on every multi-tenant host.

## Tests

```sh
cd server && bun run test    # node --test over server/src/**/*.test.ts
cd crown  && cargo test      # the Anchor program's lifecycle + vectors
```
