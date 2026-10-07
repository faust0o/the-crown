import { PublicKey } from "@solana/web3.js";

import { connection, entryPda, roundPda, PROGRAM_ID } from "./program";
import {
  CAP_CENTS,
  FLOOR_CENTS,
  SPREAD_CENTS,
  closeCents,
  type Book,
  type Direction,
} from "./pricing";

/**
 * The book, read from the chain.
 *
 * This replaces the `flow`/`opening`/`quoted`/`lastCents` maps in `market.ts`.
 * Those were process-local, which meant two servers quoted two different books
 * and a restart wiped the round's accumulated flow; now the book *is*
 * `RoundEntry.flow`, and every reader — this server, a second server, a player
 * with an explorer — is looking at the same account.
 *
 * What stays in `market.ts` is the half that was never book state: the opening
 * prior out of `crypto-odds.ts`. That is what a line is worth before anybody has
 * traded it, it is nobody's consensus state, and `pricing.rs` explains at length
 * why it does not belong on-chain.
 *
 * ## Reading is one RPC call, not thirty
 *
 * The board is ten coins with three legs each, and every one of those prices is a
 * function of the same ten accounts. `getMultipleAccounts` fetches all ten in one
 * request, so a full board quote costs one round trip rather than thirty — which
 * is the difference between a poll the client can do every two seconds and one it
 * cannot do at all.
 */

/** An entry as this module needs it: identity, the book, and where it stands. */
export interface EntryBook {
  index: number;
  symbol: string;
  ticker: string;
  startRank: number;
  cutRank: number | null;
  book: Book;
  /** The marks the chain last wrote, for cross-checking our own arithmetic. */
  lastCents: [number, number, number];
}

export interface Quote {
  /** Last traded price. */
  mark: number;
  /** What a taker pays to open. */
  ask: number;
  /** What a holder gets to close *at zero size* — see `closeFor` for the real one. */
  bid: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Trim a fixed-width, zero-padded on-chain string.
 *
 * `symbol` and `ticker` are `[u8; N]` in the account because variable-length
 * strings would make `RoundEntry` a different size per coin.
 */
const unpad = (bytes: number[] | Uint8Array): string =>
  Buffer.from(bytes).toString("utf8").replace(/\0+$/, "");

/**
 * How long a read of the board is good for.
 *
 * The client polls every couple of seconds, so a two-second cache turns a board
 * render into at most one RPC call regardless of how many readers arrive — while
 * never showing a price a fill could have moved more than a poll ago. Anything that must not be stale (the price
 * a bet is about to be written at) does not come from here: `place_bet` re-reads
 * the account inside the transaction and prices against that.
 */
const TTL_MS = Number(process.env.CHAIN_BOOK_TTL_MS ?? 2_000);

/**
 * How many entry slots to probe regardless of what `entry_count` says.
 *
 * `BOARD_SIZE` in the oracle is ten and a round never holds more, so this covers
 * every index any round can have used.
 */
const MAX_BOARD_SCAN = 10;

/**
 * Cached and in-flight reads, **keyed by round**.
 *
 * Both were a single slot, and the in-flight one did not check which round it
 * held. That is fine while only the newest round is ever read, and it stopped
 * being true the moment settlement began working a window of them: a read of
 * round 5 arriving while round 7 was in flight was handed round 7's entries.
 *
 * Silent, and not harmless. `cutAndReveal` takes the symbols and indices from
 * whatever comes back and writes `record_cut` against the round it *meant* to
 * read — so the wrong coins' ranks get recorded onto the right round, and the
 * damage is permanent because a cut cannot be re-recorded.
 *
 * Keyed by index, both problems go away and concurrent reads of different rounds
 * still share one request each.
 */
const cache = new Map<string, { until: number; entries: EntryBook[] }>();
const inflight = new Map<string, Promise<EntryBook[]>>();

/** Decoded straight from the account rather than through Anchor's client.
 *
 * Exported for `layout.test.ts`, which is the only thing that can check a
 * hand-rolled offset table: every field here is a byte count copied from
 * `RoundEntry` in `state.rs`, and a field inserted there moves all of them at
 * once with nothing failing to compile.
 *
 * The layout is fixed and known — see `RoundEntry` in `state.rs` — and decoding
 * it here keeps this module free of a `Program` handle, which would drag a
 * signing wallet into what is a read.
 */
export function decodeEntry(data: Buffer): EntryBook {
  let o = 8; // account discriminator
  o += 32; // round
  const index = data.readUInt8(o); o += 1;
  const symbol = unpad(data.subarray(o, o + 16)); o += 16;
  const ticker = unpad(data.subarray(o, o + 12)); o += 12;
  const startRank = data.readUInt16LE(o); o += 2;
  const cutRank = data.readUInt16LE(o); o += 2;

  const opening: bigint[] = [];
  for (let i = 0; i < 3; i++) { opening.push(data.readBigUInt64LE(o)); o += 8; }
  const flow: bigint[] = [];
  for (let i = 0; i < 3; i++) { flow.push(data.readBigUInt64LE(o)); o += 8; }
  const quoted: boolean[] = [];
  for (let i = 0; i < 3; i++) { quoted.push(data.readUInt8(o) === 1); o += 1; }
  const target = data.readUInt16LE(o); o += 2;
  const lastCents: number[] = [];
  for (let i = 0; i < 3; i++) { lastCents.push(data.readUInt16LE(o)); o += 2; }

  return {
    index,
    symbol,
    ticker,
    startRank,
    // 0 is how an unrecorded cut is spelled; ranks are 1-based so it is
    // unambiguous, but it must not reach a caller as a rank of zero.
    cutRank: cutRank === 0 ? null : cutRank,
    book: {
      staked: [0, 1, 2].map((d) => opening[d] + flow[d]) as [bigint, bigint, bigint],
      quoted: quoted as [boolean, boolean, boolean],
      target,
    },
    lastCents: lastCents as [number, number, number],
  };
}

/**
 * Every entry on a round, in one request.
 *
 * Concurrent callers share one flight. Without that, every reader arriving on a
 * cold cache opens its own request, and the cost of a cache miss scales with how
 * many of them happened to miss together — which is exactly when the RPC is
 * least able to absorb it.
 */
export async function readBoard(roundIndex: bigint, entryCount: number): Promise<EntryBook[]> {
  // Scanned a little wider than the count claims. Indices are dense for rounds
  // opened by `openChainRound`, but a round opened before that was true has a
  // hole where the crown sat, and reading `0..count-1` there silently drops its
  // last entry — a coin missing from the board with nothing anywhere saying so.
  // Absent accounts are skipped below, so over-scanning costs one key in a
  // batched call and buys immunity to the whole class.
  const scan = Math.max(entryCount, MAX_BOARD_SCAN);
  const key = roundIndex.toString();

  const hit = cache.get(key);
  if (hit && Date.now() < hit.until) return hit.entries;

  const pending = inflight.get(key);
  if (pending) return pending;

  const flight = (async () => {
    const round = roundPda(roundIndex);
    const keys = Array.from({ length: scan }, (_, i) => entryPda(round, i));
    const infos = await connection().getMultipleAccountsInfo(keys);

    const entries: EntryBook[] = [];
    for (const info of infos) {
      // A gap means the round is still being seeded — the entries are written one
      // instruction at a time. Skipping is right; inventing a placeholder would
      // put a coin on the board with no book behind it.
      if (!info?.data?.length) continue;
      if (!info.owner.equals(PROGRAM_ID)) continue;
      entries.push(decodeEntry(info.data as Buffer));
    }
    entries.sort((a, b) => a.index - b.index);
    cache.set(key, { until: Date.now() + TTL_MS, entries });
    return entries;
  })();

  inflight.set(key, flight);
  try {
    return await flight;
  } finally {
    inflight.delete(key);
  }
}

/**
 * Forget cached boards. Used when a fill has just moved one.
 *
 * Clears every round rather than one, because the callers that invalidate have
 * just written to whichever round is live and the cost of dropping a few stale
 * entries is one batched read.
 */
export function invalidateBoard(): void {
  cache.clear();
}

/**
 * The two-sided quote for a line, or null if it is not on the book.
 *
 * `bid` here is the *resting* bid — the mark less the spread, at no size. It is
 * the right number for a board chip, which is a statement about the line rather
 * than about anybody's position. It is the wrong number for "what would I get for
 * closing", which depends on how much of the pool the position has to walk back
 * down: use `closeFor`.
 */
export function quoteFor(entry: EntryBook, direction: Direction): Quote | null {
  if (!entry.book.quoted[direction]) return null;
  const mark = entry.lastCents[direction];
  if (!mark) return null;
  return {
    mark,
    ask: clamp(mark + SPREAD_CENTS, FLOOR_CENTS, CAP_CENTS),
    bid: clamp(mark - SPREAD_CENTS, FLOOR_CENTS, CAP_CENTS),
  };
}

/**
 * What closing a position of `stake` would actually pay per share, in cents.
 *
 * **Size-aware, and that is the whole point.** The bid a position of this size can
 * actually get is not the resting bid: closing walks the pool back down exactly
 * as opening walked it up, so a large position sells into progressively worse
 * prices, and the resting bid is only what the *first* credit out would fetch.
 *
 * The two were confused, and it mattered in the direction that annoys players:
 * `crypto-views.ts` valued open positions at the resting bid while
 * `cashOutCryptoBet` paid this, so the number on the screen was always at least
 * as good as the number in the wallet and the gap grew with position size. A
 * player who closed a big position got less than the app had been telling them
 * all round. Whatever is shown as "what you would get" has to come from here.
 */
export function closeFor(entry: EntryBook, direction: Direction, stake: bigint): number | null {
  return closeCents(entry.book, direction, stake);
}

export type { Direction };
export { PublicKey };
