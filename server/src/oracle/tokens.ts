// tokens.xyz client. The only network-facing part of the oracle.


/**
 * Which volume field ranks the board.
 *
 * `/assets/trending` carries volume over 5m / 15m / 1h / 6h / 24h. 24h would
 * freeze the board — measured on real data, a 24h-volume ranking is unchanged
 * 90% of the time hour over hour, which would make a 10-minute round almost
 * entirely draws. 1h moves while still carrying enough signal that the ordering
 * isn't noise. Override with ORACLE_VOLUME_FIELD if you want a livelier or
 * calmer board.
 */
export const VOLUME_FIELD = (process.env.ORACLE_VOLUME_FIELD ??
  "volume1hUSD") as VolumeField;

export type VolumeField =
  | "volume5mUSD"
  | "volume15mUSD"
  | "volume1hUSD"
  | "volume6hUSD"
  | "volume24hUSD";

/**
 * Optional category filter, empty by default.
 *
 * tokens.xyz's trending pool spans equity, crypto, commodity and etf, so
 * filtering to "crypto" silently dropped OPENAI, SPCX and the other tokenised
 * equities — which made our board disagree with the trending list on their own
 * site. Set TOKENS_XYZ_CATEGORY to narrow it again.
 */
export const CATEGORY = process.env.TOKENS_XYZ_CATEGORY ?? "";

export interface TrendingToken {
  assetId: string;
  symbol: string;
  name: string;
  imageUrl: string | null;
  price: number;
  /** Volume over VOLUME_FIELD's window, in USD — the ranking metric. */
  volume: number;
  volume24h: number;
  liquidity: number;
  trades5m: number;
  trades1h: number;
  wallets1h: number;
  priceChange1hPercent: number;
}

export interface TrendingSnapshot {
  tokens: TrendingToken[];
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
}

/**
 * The tokens.xyz client that used to live here is gone.
 *
 * It served a snapshot twenty hours stale while labelling it `"mode": "fresh"`,
 * on every endpoint and every parameter combination, and eventually regressed to
 * numbers older than ones it had already served — with their own site current
 * throughout. `birdeye.ts` reads the source they were reselling
 * (`scoringVersion: "birdeye-selected-fresh-v1"`); these types are all that
 * survives, because everything downstream is written against them.
 */
