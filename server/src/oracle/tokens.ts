// The shape of a trending row, whichever upstream it came from.
//
// Nothing here talks to the network — see the note at the foot of the file.
// `jupiter.ts` produces these, and everything downstream of it is written
// against them, which is what lets the source change without the game noticing.

export interface TrendingToken {
  assetId: string;
  symbol: string;
  name: string;
  imageUrl: string | null;
  price: number;
  /** Volume over `jupiter.ts`'s `WINDOW`, in USD — the ranking metric. */
  volume: number;
  volume24h: number;
  liquidity: number;
  trades5m: number;
  trades1h: number;
  wallets1h: number;
  priceChange1hPercent: number;
  /**
   * May this coin be raced?
   *
   * A flag rather than a filter, and the distinction is the whole point. Whether
   * a coin is allowed on the board is a question about the *race* — is its book
   * deep enough that its rank can't simply be bought, is it a stablecoin that
   * cannot move against the field. Whether we know what it is trading at is a
   * question about *measurement*, and the answer to the second must not depend
   * on the first: a round names ten coins, and one of them failing an
   * eligibility test an hour later does not make it stop trading.
   *
   * Dropping the rows outright is what made it look like it had. A liquidity
   * reading of $5 on a coin turning over $8.7m an hour — a glitch, or an LP
   * pulled for a minute — erased it from the board and from every lookup at
   * once, so its row reported "$0 · —" and the field looked one coin short.
   */
  racing: boolean;
}

export interface TrendingSnapshot {
  /** The ranking universe: the busiest eligible tokens, board first. */
  tokens: TrendingToken[];
  /**
   * Every token the response carried, busiest first, one row per symbol —
   * whether or not it may race. `tokens` is the racing ones, cut to the pool.
   *
   * Two ways a coin used to fall out of every list at once, and both of them
   * happen to a coin in a live round. It can be relegated past the pool, which
   * is the outcome the round is scored on; or it can fail an eligibility test
   * for a poll or two, which is not an outcome at all. Either way the numbers
   * went missing and the row read "$0" — a dead market, for a coin that was
   * trading the whole time. The page is fetched several times deeper than the
   * pool already, so keeping all of it costs nothing but the array.
   */
  watched: TrendingToken[];
  /**
   * When the data was measured, not when we asked for it.
   *
   * The difference is what makes a frozen feed visible. Polling faster than the
   * source recomputes returns the same measurement again, and treating each poll
   * as a data point records our own impatience as market history — while
   * treating a prompt response as fresh data lets a board five hours old call
   * itself live, which is exactly what happened.
   */
  asOf: number;
  /**
   * The mainnet slot the pool's prices were read at, or null if the upstream
   * did not say.
   *
   * A second clock, and the one that cannot be mislabelled: `asOf` is the
   * upstream's word for when it computed, while a slot is a position on the
   * chain that anyone can check against the chain.
   */
  slot: number | null;
  /**
   * How long until the upstream has a newer copy than this one, from its own
   * cache headers — or null if it sent none. Asking before then returns this
   * same measurement again.
   */
  freshInMs: number | null;
}

/**
 * Two upstreams have come and gone behind these types.
 *
 * tokens.xyz served a snapshot twenty hours stale while labelling it
 * `"mode": "fresh"`, with their own site current throughout. Birdeye, the source
 * it was reselling, priced the board's one request in compute units against a
 * monthly allowance that ran out. `jupiter.ts` is the current source; these
 * types are what survives a change of source, because everything downstream is
 * written against them.
 */
