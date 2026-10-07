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

## Develop

```sh
bun install
bun run server:prepare   # install server/ deps + generate the Prisma client
bun run dev:server       # GraphQL on :4000
bun run dev              # Vite on :5173, proxies /graphql to :4000
```

`server/` is a separate package with its own `package.json` and lockfile, so a
root `bun install` does not reach it — and the Prisma client it imports is
generated, not committed. `server:prepare` covers both; run it again after
changing `server/prisma/schema.prisma` or `server/package.json`.

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
