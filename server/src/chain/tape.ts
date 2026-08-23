import type { Direction } from "../market";
import { oracle } from "../oracle/index";

/**
 * The tape, when the desks are trading on chain.
 *
 * `botTape` in `bots.ts` builds this by grouping `CryptoBet` rows for the
 * in-memory desk accounts. That is exactly right while the desks bet through
 * Postgres, and returns nothing at all once they bet through the program:
 * there are no rows, the account registry is empty, and the query short-circuits
 * on `ids.length`. The panel went blank in production and the desks were
 * demonstrably trading — the log was full of fills and rounds were paying out.
 *
 * Rather than read the fills back off the chain, which is a `getProgramAccounts`
 * per refresh on a budget that has none to spare, the runner records each one as
 * it makes it. It already has everything the row needs.
 *
 * In memory and never persisted, which is what the schema already promises. A
 * restart empties it and the next arrival starts filling it again; the money is
 * on chain, and this is a view of the last few minutes of it.
 */

export interface ChainTrade {
  id: string;
  at: number;
  bot: string;
  symbol: string;
  ticker: string;
  imageUrl: string | null;
  direction: Direction;
  size: number;
  cents: number;
}

/**
 * How many fills to keep.
 *
 * The panel shows a few dozen and the flow feed reads the same buffer, so this
 * is a couple of rounds' worth at the current arrival rate — enough that a
 * player arriving mid-round sees a market rather than an empty box.
 */
const CAPACITY = Number(process.env.CHAIN_TAPE_SIZE ?? 400);

const ring: ChainTrade[] = [];
let sequence = 0;

/** Record a fill the chain desks just made. Newest last. */
export function recordChainTrade(t: {
  bot: string;
  symbol: string;
  ticker: string;
  direction: Direction;
  size: number;
  cents: number;
}): void {
  ring.push({
    id: `${sequence++}-${t.symbol}-${t.direction}`,
    at: Date.now(),
    bot: t.bot,
    symbol: t.symbol,
    ticker: t.ticker,
    // Resolved here rather than carried in: the caller has an entry account,
    // which knows a symbol and a ticker and nothing about logos.
    imageUrl: oracle.metaFor(t.symbol)?.imageUrl ?? null,
    direction: t.direction,
    size: t.size,
    cents: t.cents,
  });
  if (ring.length > CAPACITY) ring.splice(0, ring.length - CAPACITY);
}

/** The most recent fills, newest first. */
export function chainTape(limit = 40): ChainTrade[] {
  return ring.slice(-limit).reverse();
}

/** Test seam. */
export function resetChainTape(): void {
  ring.length = 0;
  sequence = 0;
}
