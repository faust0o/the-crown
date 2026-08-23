import { AnchorProvider, Program, Wallet, type Idl } from "@coral-xyz/anchor";
// Not re-exported as an ESM named binding by @coral-xyz/anchor 0.32, so taken
// from the package Anchor itself uses.
import BN from "bn.js";
import {
  Connection,
  Keypair,
  PublicKey,
  type Commitment,
} from "@solana/web3.js";
import { readFileSync } from "node:fs";
import bs58 from "bs58";
import idl from "./idl/crown.json" with { type: "json" };

/**
 * Getting at the program.
 *
 * One place that knows the PDA seeds, so nothing else has to. Every seed here
 * has a counterpart in `crown/programs/crown/src/constants.rs`, and a mismatch
 * between the two does not fail loudly — it derives a *different, valid* address
 * that simply has no account at it, and the error surfaces as
 * `AccountNotInitialized` somewhere unrelated. Changing a seed means changing
 * both.
 */

export const PROGRAM_ID = new PublicKey(idl.address);

const CONFIG_SEED = Buffer.from("config");
const VAULT_SEED = Buffer.from("vault");
const ROUND_SEED = Buffer.from("round");
const ENTRY_SEED = Buffer.from("entry");
const BET_SEED = Buffer.from("bet");
const DELEGATION_SEED = Buffer.from("delegation");

const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];

/** Little-endian, matching `to_le_bytes()` in the seeds on the Rust side. */
const u64le = (n: bigint | number): Buffer => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};

export const configPda = () => pda([CONFIG_SEED]);
export const vaultPda = () => pda([VAULT_SEED]);
export const roundPda = (index: bigint | number) => pda([ROUND_SEED, u64le(index)]);
export const entryPda = (round: PublicKey, index: number) =>
  pda([ENTRY_SEED, round.toBuffer(), Buffer.from([index])]);
export const delegationPda = (owner: PublicKey) =>
  pda([DELEGATION_SEED, owner.toBuffer()]);
/**
 * A position, keyed by its leg.
 *
 * Not by a counter: buying the same leg twice adds to this account rather than
 * opening another, which is what keeps rent bounded by desks × coins × legs
 * instead of by how often anyone trades.
 */
export const betPda = (
  round: PublicKey,
  owner: PublicKey,
  entryIndex: number,
  direction: number
) =>
  pda([
    BET_SEED,
    round.toBuffer(),
    owner.toBuffer(),
    Buffer.from([entryIndex]),
    Buffer.from([direction]),
  ]);

/**
 * Where the chain is.
 *
 * Defaults to a local validator rather than devnet, and deliberately: the desks
 * open a rent-exempt account per fill, so pointing a dev run at devnet by
 * accident spends real (if free) SOL that then has to be reclaimed a round at a
 * time. Localnet costs nothing and resets.
 */
export const RPC_URL = process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899";

/**
 * How long to wait before believing a transaction happened.
 *
 * `confirmed`, not `finalized`. The desks re-price every tick off accounts they
 * just wrote, and waiting for finality would put roughly twelve seconds between
 * a fill and the book that fill produced — long enough that every desk would be
 * trading against a stale mark and sizing clips to correct errors it had already
 * corrected. `confirmed` is a supermajority vote and is what a trading loop can
 * actually use.
 */
export const COMMITMENT: Commitment = (process.env.SOLANA_COMMITMENT as Commitment) ?? "confirmed";

/**
 * How many times to retry a call the endpoint refused for rate.
 *
 * Bounded, and small. A 429 that survives four escalating waits is not a burst
 * any longer, it is a quota — and retrying past that turns "the desks traded a
 * little less this minute" into "every path in the server is blocked on an
 * endpoint that has already said no".
 */
const RATE_LIMIT_RETRIES = Number(process.env.SOLANA_RATE_LIMIT_RETRIES ?? 4);

/**
 * A `fetch` that waits and tries again when the endpoint says it is too busy.
 *
 * Put here rather than at the call sites because every one of them needs it and
 * none of them can do it well alone: a desk that swallows a 429 declines to
 * trade for no reason a log would explain, and a round sync that swallows one
 * silently posts a partial board. Handling it at the transport means the caller
 * above sees either an answer or a real failure.
 *
 * Retrying a rejected `sendTransaction` is safe *because* it was rejected: a 429
 * is the endpoint declining to forward it, so nothing reached the cluster and
 * there is no transaction to duplicate. That is not true of a timeout, which is
 * why only this status is retried.
 *
 * Honours `Retry-After` when the endpoint sends one, since a provider's own
 * number is better than our guess; otherwise backs off exponentially with a
 * little jitter, so eight desks refused in the same instant do not all come back
 * in the same instant.
 */
/**
 * Requests per second this process will make, across everything.
 *
 * A ceiling we impose on ourselves, because reacting to 429s is not the same as
 * not causing them. Retrying absorbs a burst; it does nothing about a *rate*
 * that is simply above what the endpoint sells, and under one the retries
 * themselves become load — every refused call comes back and asks again, so the
 * queue grows faster than it drains and the failures move from the desks (which
 * can skip a turn) to settlement (which cannot).
 *
 * Set this to the tier's limit with a margin — and *measure* the tier rather
 * than trusting its documentation. This defaulted to 8 on the strength of a
 * published figure; a ramp against the actual endpoint refused 8% of requests at
 * 4/s and 38% at 8/s, so the pacer was set to roughly double what could be
 * bought and every other tuning was nibbling at a budget that was never real.
 *
 * Three leaves headroom under the point where refusals begin. It is a real
 * constraint on how fast the tape can run, not a knob to turn up hopefully:
 * above the ceiling the retries become load themselves, and the failures move
 * from the desks (which can skip a turn) to settlement (which cannot).
 */
const MAX_RPS = Number(process.env.SOLANA_MAX_RPS ?? 3);

/**
 * A token bucket over the whole process.
 *
 * Deliberately global rather than per-connection: `connection()` is called all
 * over and each call makes a new `Connection`, so a per-instance limiter would
 * limit nothing. What matters is the number of requests leaving this process.
 */
let tokens = MAX_RPS;
let lastRefill = Date.now();

async function takeToken(): Promise<void> {
  for (;;) {
    const now = Date.now();
    tokens = Math.min(MAX_RPS, tokens + ((now - lastRefill) / 1000) * MAX_RPS);
    lastRefill = now;
    if (tokens >= 1) {
      tokens -= 1;
      return;
    }
    // Wait for roughly the time one token takes to accrue, plus jitter so a
    // queue of waiters does not wake in lockstep and race for the same token.
    await new Promise((r) => setTimeout(r, (1000 / MAX_RPS) * (1 - tokens) + Math.random() * 25));
  }
}

/**
 * How long one request may take before it is abandoned.
 *
 * The only unbounded wait in this process, and it cost four days of a dead
 * market. web3.js sets no timeout and this `fetch` passed none, so a connection
 * the endpoint accepted and then stopped answering hung its caller *forever*.
 * The round loop survived it — that is an interval, and the next tick does not
 * wait on the last — while the desks did not, because each of their turns
 * scheduled the next one. Eight hung turns, nothing thrown, nothing logged, and
 * a settlement sweep reporting every round paid out in full because by then
 * nothing had bet on them.
 *
 * Twenty seconds is far longer than any call here takes — `getProgramAccounts`
 * is the slowest and this program's accounts are bounded — and comfortably under
 * `CHAIN_CONFIRM_TIMEOUT_MS`, so a stalled poll fails *inside* the confirm loop
 * rather than outliving it.
 */
const FETCH_TIMEOUT_MS = Number(process.env.SOLANA_FETCH_TIMEOUT_MS ?? 20_000);

/**
 * The caller's own abort signal, if it has one, and our deadline.
 *
 * Only 429 is retried above, and a timeout deliberately is not: the endpoint
 * accepted this one, so unlike a refusal it may well have reached the cluster,
 * and a transaction that may have landed must not be sent again.
 */
function withDeadline(init: Parameters<typeof fetch>[1]): Parameters<typeof fetch>[1] {
  const deadline = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const theirs = init?.signal;
  return {
    ...init,
    // `AbortSignal.any` is Node 20.3+. The fallback keeps the deadline rather
    // than the caller's signal, because nothing here passes one today and losing
    // the deadline is the failure this exists to prevent.
    signal:
      theirs && typeof AbortSignal.any === "function"
        ? AbortSignal.any([theirs, deadline])
        : deadline,
  };
}

async function rateLimitedFetch(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1]
): Promise<Response> {
  let wait = 250;
  for (let attempt = 0; ; attempt++) {
    await takeToken();
    // The deadline starts after the token, so time spent queued behind the pacer
    // is not charged against the request itself.
    const res = await fetch(input, withDeadline(init));
    if (res.status !== 429 || attempt >= RATE_LIMIT_RETRIES) return res;

    const header = Number(res.headers.get("retry-after"));
    const delay = Number.isFinite(header) && header > 0 ? header * 1000 : wait;
    await new Promise((r) => setTimeout(r, delay + Math.random() * 200));
    wait = Math.min(wait * 2, 4_000);
  }
}

/**
 * The connection, shared.
 *
 * One instance for the process, and it matters far more than it looks. This
 * built a **new `Connection` on every call** — and it is called on every desk
 * turn, every board read, every round read, several times per second between
 * them. Each `Connection` opens its own websocket for signature subscriptions,
 * so the process was opening and abandoning sockets continuously until the
 * provider started refusing them:
 *
 *     ws error: Unexpected server response: 429
 *     Error: 429 Too Many Requests
 *         at ClientBrowser.callServer
 *
 * That error arrives from a socket callback with nothing waiting on it, so it
 * reached the top as an uncaught exception and **killed the server** — which
 * looked from outside like images intermittently failing to load, because the
 * logo proxy died along with everything else.
 *
 * Sharing one also shares the blockhash and account caches, which is the
 * difference between the request budget being spent on questions and being spent
 * on connection setup.
 */
let shared: Connection | null = null;

export function connection(): Connection {
  if (shared) return shared;
  shared = new Connection(RPC_URL, {
    commitment: COMMITMENT,
    fetch: rateLimitedFetch as unknown as typeof fetch,
    // **web3.js must not retry a 429 as well.**
    //
    // It has its own backoff, and it runs *inside* the fetch above — so one
    // logical call could spend five tokens from a bucket sized for one, and the
    // two policies compounded into a burst neither of them had agreed to. The
    // symptom is a log full of "Retrying after 500ms" that never appears in this
    // file, from a layer that does not know a rate limit is already being kept.
    //
    // One retry policy, and it is the one that can see the whole process.
    disableRetryOnRateLimit: true,
  });
  return shared;
}

/** Read a keypair from a CLI-format JSON array of bytes. */
export function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}

/**
 * A keypair from the environment, falling back to a file.
 *
 * Deployment is the reason this exists. The authority and the relayer live in
 * `~/.config/solana/crown-devnet` on a laptop, which is fine for a laptop and
 * impossible on Railway — a container has no such directory and mounting one is
 * a worse secret store than the env already is. So the value may be either the
 * key itself or a path to it, and which one it is can be told by looking:
 * a JSON array is a key, anything else is a path.
 *
 * Accepts the CLI's JSON-array form and base58, because those are the two shapes
 * a key is ever copied in — `solana-keygen` emits the first and every wallet
 * exports the second, and a deploy that requires converting between them is a
 * deploy someone gets wrong at 2am.
 *
 * Throws with the variable's *name* and never its value. A stack trace carrying
 * a private key is a worse outcome than the failure it was reporting.
 */
export function keypairFrom(envName: string, fallbackPath?: string): Keypair {
  const raw = process.env[envName]?.trim();

  if (!raw) {
    if (!fallbackPath) {
      throw new Error(
        `${envName} is not set and no fallback path was given. Set it to the key ` +
          `itself (JSON array or base58) or to a path on disk.`
      );
    }
    try {
      return loadKeypair(fallbackPath);
    } catch (err) {
      throw new Error(
        `${envName} is not set and ${fallbackPath} could not be read ` +
          `(${err instanceof Error ? err.message : "unknown error"}).`
      );
    }
  }

  try {
    if (raw.startsWith("[")) {
      return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw) as number[]));
    }
    if (raw.startsWith("/") || raw.startsWith("~") || raw.startsWith(".")) {
      return loadKeypair(raw.replace(/^~/, process.env.HOME ?? "~"));
    }
    return Keypair.fromSecretKey(bs58.decode(raw));
  } catch (err) {
    throw new Error(
      `${envName} is set but is not a usable keypair ` +
        `(${err instanceof Error ? err.message : "unknown error"}). ` +
        `Expected a JSON byte array, a base58 secret key, or a path.`
    );
  }
}

export type CrownProgram = Program<Idl>;

/**
 * A program handle signing as `payer`.
 *
 * `skipPreflight` is off. It costs a round trip per send, and it is worth it
 * here: without it a refusal comes back as an opaque failed signature, and the
 * refusals in this program are ordinary — a desk that raced the lock, a leg that
 * closed, a book that moved past a slippage bound. Those need to be legible to
 * the caller that has to decide whether to retry.
 */
export function crownProgram(payer: Keypair, conn = connection()): CrownProgram {
  const provider = new AnchorProvider(conn, new Wallet(payer), {
    commitment: COMMITMENT,
    preflightCommitment: COMMITMENT,
  });
  return new Program(idl as Idl, provider);
}

export { BN };
