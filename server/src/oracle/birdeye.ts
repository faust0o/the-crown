export type { TrendingSnapshot, TrendingToken } from "./tokens";
import type { TrendingSnapshot, TrendingToken } from "./tokens";

/**
 * The board's market data, from Birdeye.
 *
 * Replaces tokens.xyz, which began serving a snapshot twenty hours old while
 * still labelling it `"mode": "fresh"` — freshly generated responses
 * (`x-vercel-cache: MISS`) carrying frozen numbers, on every endpoint and every
 * parameter combination, and eventually regressing to a snapshot older than one
 * it had served the evening before. Their own site showed current prices
 * throughout, so this was never something a caller could work around.
 *
 * Birdeye was the underlying source anyway: tokens.xyz stamped its responses
 * `scoringVersion: "birdeye-selected-fresh-v1"`. This removes the reseller.
 *
 * ## One request
 *
 * `/defi/v3/token/list` sorted by `volume_1h_usd` carries everything the board
 * needs in a single response — price, the volume windows, trade counts,
 * liquidity and a logo — where the previous source needed a list call and the
 * newer per-asset endpoint for anything recent. That matters because the poll
 * runs every ten seconds and Birdeye's rate limits are tight.
 */

const BASE = process.env.BIRDEYE_BASE ?? "https://public-api.birdeye.so";
const KEY = process.env.BIRDEYE_DATA_SECRET ?? "";
const CHAIN = process.env.BIRDEYE_CHAIN ?? "solana";

/** Which volume window ranks the board. Birdeye's field name, not ours. */
export const VOLUME_FIELD = process.env.BIRDEYE_VOLUME_FIELD ?? "volume_1h_usd";

/**
 * The least liquidity a coin may have and still be raced.
 *
 * Not tidiness — this is a betting game and rank is the thing being bet on. A
 * quarter-million-dollar book turning over twenty million an hour is a
 * seventy-times ratio: either wash trading or a token whose place on the board a
 * player with a modest budget could simply buy. At that floor the whole board
 * was such tokens, at fourteen to seventy-five times turnover.
 *
 * A quarter of a million is where the field actually is, and the number was
 * measured rather than chosen. Against the top hundred by hourly volume it
 * leaves twenty-five eligible tokens — enough to fill a board of ten twice over
 * — while a one-million floor leaves nine and a five-million floor leaves three,
 * which is not a field.
 *
 * It also decides what game this is, and that is worth saying plainly. The old
 * source curated a universe and then ranked inside it, so the board mixed
 * tokenised equities near the top of hourly volume (TSLA at #5, SPCX at #8) with
 * crypto majors far below it (cbBTC at #50, HYPE at #60). Ranking by volume with
 * only a floor keeps the first group and loses the second: the board becomes
 * tokenised equities and company exposure rather than a blend. Raising the floor
 * to reach the majors empties the board instead, because their hourly volume is
 * two orders of magnitude smaller.
 *
 * Curating a universe — a list of assets that are allowed to race, ranked by
 * volume within it — is the way to have both, and is a product decision rather
 * than a threshold.
 */
const MIN_LIQUIDITY = Number(process.env.BIRDEYE_MIN_LIQUIDITY ?? 250_000);

/**
 * Coins that cannot lose the race, so are not in it.
 *
 * A stablecoin sits wherever its volume puts it and never moves rank against
 * the field for any reason a player could read — betting HIGHER or LOWER on
 * USDC is a coin flip weighted by other coins' news. They ranked high on raw
 * volume, so without this they would occupy a third of the board.
 */
const EXCLUDED = new Set(
  (process.env.BIRDEYE_EXCLUDE ?? "SOL,WSOL,DAI,INF")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
);

/**
 * Two families that cannot race, matched by shape rather than by name.
 *
 * A hand-written list of stablecoins was already out of date the first time it
 * ran: the board came back holding USD1 and USDG, neither of which was on it,
 * and both of which sit wherever their volume puts them and never move rank for
 * a reason a player could read. Liquid-staking tokens are the same story against
 * SOL — hSOL tracks it, so its position is SOL's position with extra steps.
 *
 * Matching the shape catches the next one nobody has heard of yet, which a list
 * cannot. The cost is a real token with an unlucky ticker, and `BIRDEYE_EXCLUDE`
 * exists for when that happens.
 */
const CANNOT_RACE = [
  /USD/i, // USDC, USDT, USD1, USDG, PYUSD, USDe…
  /SOL$/i, // hSOL, jitoSOL, mSOL, bSOL, JupSOL…
  /^EUR|^GBP/i,
];

interface BirdeyeToken {
  address?: string;
  symbol?: string;
  name?: string;
  logo_uri?: string;
  price?: number;
  liquidity?: number;
  last_trade_unix_time?: number;
  volume_1h_usd?: number;
  volume_24h_usd?: number;
  trade_5m_count?: number;
  trade_1h_count?: number;
  price_change_1h_percent?: number;
  [key: string]: unknown;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function hasKey(): boolean {
  return KEY.length > 0;
}

/**
 * Top tokens by the configured volume window, richest first.
 *
 * Over-fetches, because the filters below remove rows and the caller asked for a
 * full board. Birdeye caps a page at 100.
 */
export async function fetchTrending(limit: number): Promise<TrendingSnapshot> {
  if (!KEY) throw new Error("BIRDEYE_DATA_SECRET is not set");

  const want = Math.min(100, Math.max(limit * 6, 50));
  const url =
    `${BASE}/defi/v3/token/list` +
    `?sort_by=${encodeURIComponent(VOLUME_FIELD)}&sort_type=desc&limit=${want}`;

  const res = await fetch(url, {
    headers: { "X-API-KEY": KEY, "x-chain": CHAIN, accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    // Birdeye reports both of its limits as a status code with the reason in the
    // body, and the two need different responses from whoever reads the log: a
    // rate limit passes on its own, an exhausted allowance does not pass until
    // the month turns or the plan changes. "400 Bad Request" describes neither
    // and sends people to look at the request.
    const detail = await res.text().catch(() => "");
    const message = /compute units?/i.test(detail)
      ? "the plan's compute-unit allowance is used up — it will not recover until the quota resets"
      : /too many requests/i.test(detail) || res.status === 429
        ? "rate limited"
        : `${res.status} ${res.statusText}`;
    throw new Error(`birdeye token list: ${message}`);
  }

  const body = (await res.json()) as { success?: boolean; data?: { items?: BirdeyeToken[] } };
  if (!body.success) throw new Error("birdeye token list: unsuccessful response");
  const rows = body.data?.items ?? [];

  const tokens: TrendingToken[] = [];
  for (const r of rows) {
    const symbol = String(r.symbol ?? "").trim();
    if (!symbol) continue;
    if (EXCLUDED.has(symbol.toUpperCase())) continue;
    if (CANNOT_RACE.some((re) => re.test(symbol))) continue;

    const volume = num(r[VOLUME_FIELD]);
    if (!(volume > 0)) continue; // no activity in the window — not a competitor
    if (num(r.liquidity) < MIN_LIQUIDITY) continue;

    tokens.push({
      // The mint, which is the only genuinely unique identifier here.
      assetId: String(r.address ?? symbol),
      symbol,
      name: String(r.name ?? symbol),
      imageUrl: typeof r.logo_uri === "string" && r.logo_uri ? r.logo_uri : null,
      price: num(r.price),
      volume,
      volume24h: num(r.volume_24h_usd),
      liquidity: num(r.liquidity),
      trades5m: num(r.trade_5m_count),
      trades1h: num(r.trade_1h_count),
      // Birdeye's list carries unique wallets over 24h only, and an hour's
      // figure is not derivable from a day's. Reported as zero rather than
      // approximated: the board displays it and nothing computes with it, so a
      // made-up number would be worse than an absent one.
      wallets1h: 0,
      priceChange1hPercent: num(r.price_change_1h_percent),
    });
  }

  // **One row per symbol, keeping the busiest.**
  //
  // Carried over from the previous source and just as necessary here: the
  // tokenised equities share tickers across wrappers, and a single page of this
  // endpoint returned NVDA twice and CALICO twice. Everything downstream treats
  // the symbol as identity — it is `Token`'s primary key, half of `RankSample`'s
  // and `RoundEntry`'s unique keys, and the only thing a bet names. A duplicate
  // does not draw two rows under one name; it collides a round's entries on
  // (roundId, symbol), the round fails to open, and the board sits there with no
  // book on it.
  //
  // Rows arrive volume-descending, so the first of a symbol is the busiest.
  const bySymbol = new Map<string, TrendingToken>();
  for (const t of tokens) if (!bySymbol.has(t.symbol)) bySymbol.set(t.symbol, t);

  // The freshest trade in the snapshot, as the measurement's timestamp. Birdeye
  // stamps no response-level time, and this is the honest stand-in: it advances
  // while the market moves and freezes if the feed does, which is exactly what
  // the staleness check needs to be able to see.
  const asOf = Math.max(0, ...rows.map((r) => num(r.last_trade_unix_time))) * 1000;

  return {
    tokens: [...bySymbol.values()].slice(0, limit),
    asOf: asOf || Date.now(),
  };
}
