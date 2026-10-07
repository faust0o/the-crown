export type { TrendingSnapshot, TrendingToken } from "./tokens";
import type { TrendingSnapshot, TrendingToken } from "./tokens";

/**
 * The board's market data, from Jupiter's token index.
 *
 * Replaces Birdeye, which priced this endpoint in compute units against a
 * monthly allowance: the allowance ran out, and with it the only source the
 * board had. Jupiter's `tokens/v2` answers without a key at half a request a
 * second, and one row carries everything the board needs — price, liquidity,
 * volume and trade counts over four windows, unique traders, a logo, and tags.
 *
 * ## Verified is the universe
 *
 * Birdeye ranked everything and filtered by liquidity, which made the board
 * tokenised equities and nothing else: the crypto majors trade two orders of
 * magnitude less per hour and no floor could keep both. Jupiter's verified set
 * is the curated universe that comment asked for — majors, equities and the
 * busiest memes, each one a token somebody has vouched for. Verification is
 * therefore a question of *identity* (is this the token the ticker names?) and
 * drops a row outright; eligibility to race is asked separately, below.
 *
 * ## How fresh it can be
 *
 * Measured: Jupiter recomputes these rows about every fifteen seconds and
 * serves them from a cache that says so — `max-age=15`, with an `age` counting
 * up to it — on the keyed host and the keyless one alike. A key raises the rate
 * limit and buys nothing in freshness. `freshInMs` hands the cache's own
 * schedule to the caller, so it can ask again the moment a new reading exists
 * instead of guessing at an interval.
 */

const BASE = (process.env.JUPITER_BASE ?? "https://api.jup.ag").replace(/\/+$/, "");
/** Optional. Without one, `api.jup.ag` allows 0.5 requests a second; a free key, one. */
const KEY = process.env.JUPITER_API_KEY ?? "";

const WINDOWS = ["5m", "1h", "6h", "24h"] as const;
type Window = (typeof WINDOWS)[number];

/** Which volume window ranks the board. Jupiter's interval name, not ours. */
export const WINDOW: Window = (WINDOWS as readonly string[]).includes(process.env.ORACLE_WINDOW ?? "")
  ? (process.env.ORACLE_WINDOW as Window)
  : "1h";

/**
 * The least liquidity a coin may have and still be raced.
 *
 * Not tidiness — this is a betting game and rank is the thing being bet on. A
 * thin book turning over millions an hour is either wash trading or a token
 * whose place on the board a player with a modest budget could simply buy.
 * Verification does not answer that: a verified equity wrapper can hold sixty
 * thousand dollars of liquidity and still print a million an hour.
 *
 * It decides who enters a round. A coin already in one keeps its rank by volume
 * if its liquidity dips below this mid-round — see `rerank` in `index.ts`.
 */
const MIN_LIQUIDITY = Number(process.env.ORACLE_MIN_LIQUIDITY ?? 250_000);

/** Coins that cannot lose the race, so are not in it. */
const EXCLUDED = new Set(
  (process.env.ORACLE_EXCLUDE ?? "SOL,WSOL,DAI,INF")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
);

/**
 * Jupiter's own word for the two families that cannot race.
 *
 * A stablecoin sits wherever its volume puts it and never moves rank for a
 * reason a player could read, and a liquid-staking token's position is SOL's
 * position with extra steps. The tags catch the ones nobody has heard of yet;
 * the shapes below stay as a second net, because a missing tag is a quieter
 * failure than a missing pattern.
 */
const CANNOT_RACE_TAGS = new Set(["stable", "lst"]);
const CANNOT_RACE = [
  /USD/i, // USDC, USDT, USD1, USDG, PYUSD, USDe…
  /SOL$/i, // hSOL, jitoSOL, mSOL, bSOL, JupSOL…
  /^EUR|^GBP/i,
];

/** Jupiter's page size, and the most mints one search takes. */
const PAGE = 100;

/**
 * How many symbols may be looked up by name in one poll.
 *
 * Only a restart mid-round ever needs this — see `follow` — and each is a
 * request against a rate limit the board itself has to live inside.
 */
const SYMBOL_LOOKUPS_PER_POLL = 3;

interface JupStats {
  buyVolume?: number;
  sellVolume?: number;
  numBuys?: number;
  numSells?: number;
  numTraders?: number;
  priceChange?: number;
}

interface JupToken {
  id?: string;
  symbol?: string;
  name?: string;
  icon?: string;
  usdPrice?: number;
  liquidity?: number;
  isVerified?: boolean;
  tags?: string[];
  /** The mainnet slot the price was read at. */
  priceBlockId?: number;
  /** When Jupiter computed this row. */
  updatedAt?: string;
  stats5m?: JupStats;
  stats1h?: JupStats;
  stats6h?: JupStats;
  stats24h?: JupStats;
}

/** A failed call, carrying how long the upstream asked us to wait when it said. */
export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly retryInMs?: number
  ) {
    super(message);
  }
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

const volumeOf = (s: JupStats | undefined) => num(s?.buyVolume) + num(s?.sellVolume);
const tradesOf = (s: JupStats | undefined) => num(s?.numBuys) + num(s?.numSells);

/**
 * Mints learned from earlier responses, by symbol.
 *
 * A coin that leaves the top hundred is still owed a measurement if a round
 * named it, and the mint is the one identifier a search cannot answer
 * ambiguously — a symbol search for HYPE returns twenty tokens.
 */
const mintOf = new Map<string, string>();

/** How long the copy we were handed stays the upstream's current one. */
function freshFor(res: Response): number | null {
  const maxAge = /max-age=(\d+)/i.exec(res.headers.get("cache-control") ?? "")?.[1];
  if (maxAge == null) return null;
  const age = Number(res.headers.get("age") ?? 0) || 0;
  return Math.max(0, (Number(maxAge) - age) * 1000);
}

function retryInMs(res: Response): number | undefined {
  const after = Number(res.headers.get("retry-after"));
  if (after > 0) return after * 1000;
  // Seen as an absolute Unix time in seconds; a small number can only be a delta.
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  if (!(reset > 0)) return undefined;
  return reset > 1e9 ? Math.max(1000, reset * 1000 - Date.now()) : reset * 1000;
}

async function get(path: string): Promise<{ rows: JupToken[]; freshInMs: number | null }> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (KEY) headers["x-api-key"] = KEY;
  const res = await fetch(`${BASE}${path}`, { headers, signal: AbortSignal.timeout(10_000) });
  const where = path.split("?")[0];
  if (!res.ok) {
    if (res.status === 429) throw new UpstreamError(`jupiter ${where}: rate limited`, retryInMs(res));
    const detail = await res.text().catch(() => "");
    throw new UpstreamError(
      `jupiter ${where}: ${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 160)}` : ""}`
    );
  }
  const body: unknown = await res.json();
  if (!Array.isArray(body)) throw new UpstreamError(`jupiter ${where}: expected a list of tokens`);
  return { rows: body as JupToken[], freshInMs: freshFor(res) };
}

/** One row as the board reads it, or null if it is not a token this game knows. */
function toToken(r: JupToken): TrendingToken | null {
  const symbol = String(r.symbol ?? "").trim();
  const mint = String(r.id ?? "").trim();
  if (!symbol || !mint) return null;
  // Identity, not eligibility — see the note at the top of the file. An
  // unverified row sharing a ticker with a real token is a different token,
  // and letting it into the lookup is how its numbers would end up on the
  // real one's row.
  if (r.isVerified !== true) return null;

  const volume = volumeOf(r[`stats${WINDOW}` as const]);
  // Nothing traded in the window: neither a competitor nor a measurement.
  if (!(volume > 0)) return null;

  const tags = r.tags ?? [];
  const racing =
    !EXCLUDED.has(symbol.toUpperCase()) &&
    !tags.some((t) => CANNOT_RACE_TAGS.has(t)) &&
    !CANNOT_RACE.some((re) => re.test(symbol)) &&
    num(r.liquidity) >= MIN_LIQUIDITY;

  return {
    racing,
    assetId: mint,
    symbol,
    name: String(r.name ?? symbol),
    imageUrl: typeof r.icon === "string" && r.icon ? r.icon : null,
    price: num(r.usdPrice),
    volume,
    volume24h: volumeOf(r.stats24h),
    liquidity: num(r.liquidity),
    trades5m: tradesOf(r.stats5m),
    trades1h: tradesOf(r.stats1h),
    // Birdeye only had this over a day and it was reported as zero. Jupiter
    // counts it per window.
    wallets1h: num(r.stats1h?.numTraders),
    priceChange1hPercent: num(r.stats1h?.priceChange),
  };
}

/**
 * Rows for round coins the main list no longer carries.
 *
 * By mint wherever one is known, in a single request. By symbol only for a coin
 * this process has never seen — after a restart, with a round's coin already
 * outside the top hundred — taking the exact ticker and leaving the choice
 * between same-named tokens to the same rule the board uses.
 *
 * Never throws: the board is already in hand, and a coin the round is following
 * reading as missing for one poll is the state this replaces, not a new one.
 */
async function follow(symbols: string[]): Promise<JupToken[]> {
  if (!symbols.length) return [];
  const mints = symbols.flatMap((s) => mintOf.get(s) ?? []);
  const unknown = symbols.filter((s) => !mintOf.has(s)).slice(0, SYMBOL_LOOKUPS_PER_POLL);

  const calls: Promise<JupToken[]>[] = [];
  for (let i = 0; i < mints.length; i += PAGE) {
    const batch = mints.slice(i, i + PAGE).join(",");
    calls.push(get(`/tokens/v2/search?query=${batch}`).then((r) => r.rows));
  }
  for (const symbol of unknown) {
    calls.push(
      get(`/tokens/v2/search?query=${encodeURIComponent(symbol)}`).then((r) =>
        r.rows.filter((row) => String(row.symbol ?? "").trim() === symbol)
      )
    );
  }

  const out: JupToken[] = [];
  for (const result of await Promise.allSettled(calls)) {
    if (result.status === "fulfilled") out.push(...result.value);
    else console.warn("⚠  oracle follow:", result.reason instanceof Error ? result.reason.message : result.reason);
  }
  return out;
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

/**
 * The busiest verified tokens by the configured window, plus whichever of
 * `following` the list has lost.
 *
 * `following` is the live round's field. A round is a promise to measure ten
 * named coins until it ends, and the top of the market is not that promise —
 * the coin that has collapsed out of it is exactly the one the round is about.
 */
export async function fetchTrending(
  limit: number,
  following: Iterable<string> = []
): Promise<TrendingSnapshot> {
  const main = await get(`/tokens/v2/toptraded/${WINDOW}?limit=${PAGE}`);

  const parsed = main.rows.map((r) => ({ raw: r, token: toToken(r) }));
  const have = new Set(parsed.flatMap((p) => (p.token ? [p.token.symbol] : [])));
  const missing = [...new Set(following)].filter((s) => !have.has(s));
  for (const r of await follow(missing)) parsed.push({ raw: r, token: toToken(r) });

  // **One row per symbol, keeping the busiest that can race.**
  //
  // Everything downstream treats the symbol as identity — it is `Token`'s
  // primary key, half of `RankSample`'s and `RoundEntry`'s unique keys, and the
  // only thing a bet names — and the tokenised equities share tickers across
  // wrappers. A duplicate does not draw two rows under one name; it collides a
  // round's entries on (roundId, symbol) and the round fails to open.
  //
  // Busiest first, so the first of a symbol wins — except that a racing row
  // takes precedence over a busier one that cannot race, or a token would lose
  // its place on the board to a thin wrapper of itself.
  const candidates = parsed
    .flatMap((p) => (p.token ? [{ ...p, token: p.token }] : []))
    .sort((a, b) => b.token.volume - a.token.volume);
  const bySymbol = new Map<string, (typeof candidates)[number]>();
  for (const c of candidates) {
    const held = bySymbol.get(c.token.symbol);
    if (!held || (c.token.racing && !held.token.racing)) bySymbol.set(c.token.symbol, c);
  }

  const kept = [...bySymbol.values()].sort((a, b) => b.token.volume - a.token.volume);
  for (const { token } of kept) mintOf.set(token.symbol, token.assetId);

  const watched = kept.map((k) => k.token);
  const pool = kept.filter((k) => k.token.racing).slice(0, limit);

  // When Jupiter computed the response: the newest row it stamped.
  const stamps = main.rows.map((r) => Date.parse(r.updatedAt ?? "")).filter(Number.isFinite);
  const asOf = stamps.length ? Math.max(...stamps) : Date.now();

  // The slot the pool's prices were read at — the median, because a quiet
  // coin's last price is legitimately old and a single busy one says nothing
  // about the rest. Compared against mainnet by the caller.
  const slot = median(pool.flatMap((k) => (num(k.raw.priceBlockId) > 0 ? [num(k.raw.priceBlockId)] : [])));

  return {
    tokens: pool.map((k) => k.token),
    watched,
    asOf,
    slot,
    freshInMs: main.freshInMs,
  };
}

/** Test seam — forget every mint learned so far, as a restart would. */
export function forgetMintsForTest(): void {
  mintOf.clear();
}
