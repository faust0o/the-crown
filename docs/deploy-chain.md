# Deploying the on-chain half

The database game and the chain game ship in the same container. Which one runs
is `CHAIN_MODE`, and the shipping default is `off` — a deploy that sets nothing
behaves exactly as it did before any of this existed.

Turning it on is a two-step move on purpose: deploy with the variables set and
`CHAIN_MODE=off`, confirm the preflight is clean, then flip the flag. That way
the thing being switched on has already been checked in the environment it will
run in.

```sh
cd server && bun run chain:preflight   # exits non-zero if anything is fatal
```

The server runs the same checks at boot. If any fatal check fails it logs the
whole list, stays off, and serves the database game — a chain that cannot start
is a reason to serve the old game, not a reason to serve nothing.

## Variables

### Server-side, secret

| Variable | What it is |
|---|---|
| `SOLANA_RPC_URL` | The RPC the server uses. **May carry a provider key** — it never reaches the browser, which talks to this server's `/rpc` instead. |
| `CROWN_AUTHORITY_KEY` | Opens rounds, posts the board at the cut, reveals seeds, funds the opening auctions, and **mints credits**. The most dangerous key here. |
| `CROWN_RELAYER_KEY` | Pays every fee and every position's rent, and is the key players name when they approve. Holds no credits. |
| `CROWN_CREDIT_MINT` | The SPL mint credits are denominated in. Written by `bun run chain:seed`. |
| `CHAIN_MODE` | `on` or `off`. Off is the default and the safe deploy. |

Keys may be the key itself (a `solana-keygen` JSON byte array, or base58 as any
wallet exports it) or a path to one. A container has no `~/.config/solana`, so
in production they are the key itself. Nothing ever logs their value — a failure
names the *variable*, because a stack trace carrying a private key is worse than
the error it was reporting.

### Build-time, public

These are substituted into the browser bundle by Vite **at build time**, not read
per request. Changing one requires a rebuild, not a restart.

| Variable | Value |
|---|---|
| `VITE_SOLANA_RPC_URL` | `/rpc` — always. See below. |
| `VITE_SOLANA_CLUSTER` | `devnet` / `mainnet` / `testnet` / `local`, for explorer links. |
| `VITE_CROWN_CREDIT_MINT` | The mint, so the client can find a player's token account. |
| `VITE_CROWN_RELAYER` | The relayer the player approves. |

**`VITE_SOLANA_RPC_URL` must stay `/rpc`.** Setting it to a provider URL puts
that URL — key and all — into `dist/assets/*.js`, readable by anyone who opens
the page and free for them to spend. The preflight fails on this specifically.
The seeder writes `/rpc` unconditionally so the mistake cannot be made by editing
an env var.

## What has to be true before flipping the flag

The preflight checks all of this, but the two that cost money are worth
understanding rather than merely passing:

**The relayer needs SOL, sized by what is outstanding at once.** It opens a
rent-exempt account per position (~0.00195 SOL) and gets it back when the
position settles — so the floor is set by how many positions are unsettled
simultaneously, not by how fast people play. A full round is roughly 240
positions; 3.5 SOL covers about seven rounds' worth outstanding together.
`CROWN_RELAYER_FLOOR_SOL` sets where the check complains.

**The vault has to hold credits.** It is what pays winners. An empty vault
settles every winning position to nothing, which is indistinguishable from the
game cheating. `CROWN_VAULT_BUFFER` controls what the seeder puts there.

## Rounds are mirrored, not owned

The database round keeps the clock — it is wall-clock aligned, it holds the seed,
and it is what the API serves. The chain round is opened *from* it and matched on
`startsAt`. So the flag can be flipped mid-round without the game stopping: the
next database round gets a chain round, and players who have not connected a
wallet keep playing exactly as before.

## Players and the two ledgers

A player's credits live in exactly one place. Connecting a wallet **moves** the
database balance on-chain and zeroes it, so:

- a player who has connected bets through the program;
- a player who has not bets through Postgres, as always.

`placeCryptoBet` switches on the player's `walletAddress`, not on `CHAIN_MODE`
alone. That is what makes turning the flag on safe while people are mid-round.

`claimChainCredits` refuses outright while `CHAIN_MODE=off`, because moving
credits out of the database is only safe when there is somewhere to spend them.

## The house pays for everything

A player never needs SOL. The server builds and part-signs both transactions a
player is involved in — the one-time setup and each cash-out — with the relayer
as fee payer; the player's wallet adds the signature only it can give. This is
asserted end to end by `bun run chain:play-check`, which fails if the player's
SOL balance is anything but zero when the journey finishes.

## Connecting a wallet takes a signature

A player signs a server-issued nonce before their wallet is linked to their
account. That signature is the only thing that proves the wallet is theirs —
the delegation account created during setup proves the *wallet holder* set it
up, which is a fact about them and not about who is asking.

Without it, any logged-in account could claim any wallet that had completed
setup, including a market-making desk's: desk pubkeys are public, every desk has
a delegation and a bankroll, and the relayer is its delegate. Desk pubkeys are
also refused outright, because their keys derive from `DESK_SECRET` — a
deployment that leaves it unset has published them with the source.

**Set `DESK_SECRET` in production.**

## Two ledgers, one balance

`cashOutCryptoBet` refuses a position that has a `chainAddress`. Paying one out
of the database would be money from nowhere, and it would close nothing — the
`Bet` account survives and settlement pays it again. On-chain positions close
through `prepareCloseBet`, which is the only route that can, since closing takes
the owner's signature.

## The RPC ceiling is a real constraint, and it must be measured

The chain loop is paced by `SOLANA_MAX_RPS`, and that number has to come from
the endpoint rather than from its documentation. Ramping request rate against
the devnet endpoint in use:

| offered | refused |
|---|---|
| 4 req/s | 8% |
| 6 req/s | 39% |
| 8 req/s | 38% |
| 14 req/s | 52% |

So the usable ceiling is under 4, not the 8 that was configured on the strength
of a published figure. Everything downstream is sized to fit inside it:

| variable | default | why |
|---|---|---|
| `SOLANA_MAX_RPS` | 3 | headroom under where refusals start |
| `DESK_ARRIVAL_MS` | 3000 | a fill costs 3–4 requests between reading, sending and confirming |
| `CHAIN_SETTLE_IDLE` | 5 | settlement gets what the tape is not using |

At those settings a 180-second run produced **0 rate-limit errors, 0 warnings,
50 fills and every round paid out**. At the previous settings the same run
produced 71 refusals and *fewer* fills, because above the ceiling the retries
become load themselves.

**After upgrading the plan, re-run the ramp and raise these together.** Raising
`SOLANA_MAX_RPS` alone just moves the refusals somewhere less visible.

## Checks

| Command | What it proves |
|---|---|
| `chain:preflight` | this deployment can run on-chain play at all |
| `chain:setup-check` | a wallet holding **no SOL** can complete the setup |
| `chain:credits-check` | credits move rather than duplicate, exactly once, even when raced |
| `chain:play-check` | connect → fund → bet → cash out, without the player ever holding SOL |
| `chain:wallet-check` | the browser's hand-rolled instruction matches Anchor's, byte for byte |
| `chain:smoke` | the program's own arithmetic against a live validator |

Run them against the environment you are about to enable, not against localhost.
They spend real (devnet) SOL and mint real credits, so point them at a cluster
where that is acceptable.
