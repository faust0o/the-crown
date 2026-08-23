import { strict as assert } from "node:assert";
import { after, describe, it } from "node:test";

/**
 * The pool as it leaves the network boundary, and the one invariant everything
 * downstream of it depends on: a symbol names exactly one token.
 *
 * It is not an invariant the upstream holds to — a single page of Birdeye's
 * hourly-volume list returned NVDA twice and CALICO twice, on distinct mints,
 * because the tokenised equities share tickers across wrappers. The day it broke
 * under the previous source it broke the game outright rather than drawing a
 * duplicate row: a round's entries are keyed (roundId, symbol), so a field
 * carrying one twice cannot be written at all, and no round opened until the
 * pool changed on its own.
 *
 * The module reads its configuration once, at load, and refuses to call without
 * a key — so these are set before the import rather than depending on whatever a
 * developer happens to keep in .env.
 */
process.env.BIRDEYE_DATA_SECRET = "test-key";
process.env.BIRDEYE_VOLUME_FIELD = "volume_1h_usd";
// A real floor, so the test that claims to exercise it does. Every token
// built by `token()` sits above this unless it says otherwise.
process.env.BIRDEYE_MIN_LIQUIDITY = "1000000";
const { fetchTrending } = await import("./oracle/birdeye");

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
});

/** Stand in one `/defi/v3/token/list` response. */
function upstream(rows: unknown[]): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ success: true, data: { items: rows } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

const token = (
  symbol: string,
  volume: number,
  extra: Record<string, unknown> = {}
): Record<string, unknown> => ({
  address: `mint-${symbol}-${volume}`,
  symbol,
  name: `${symbol} token`,
  logo_uri: `https://example.test/${symbol}.png`,
  price: 1,
  liquidity: 10_000_000,
  volume_1h_usd: volume,
  volume_24h_usd: volume * 20,
  trade_1h_count: 10,
  last_trade_unix_time: 1_700_000_000,
  ...extra,
});

const symbolsOf = (pool: { symbol: string }[]) => pool.map((t) => t.symbol);

describe("the trending pool", () => {
  it("collapses a symbol carried by several assets down to the busiest", async () => {
    upstream([
      token("cbBTC", 900),
      token("NVDA", 800, { name: "NVIDIA xStock" }),
      token("NVDA", 400, { name: "NVIDIA, some other wrapper" }),
    ]);

    const pool = (await fetchTrending(10)).tokens;

    assert.deepEqual(symbolsOf(pool), ["cbBTC", "NVDA"]);
    // The busier of the two, which is the one whose volume the row would have
    // been drawn at either way.
    assert.equal(pool[1].name, "NVIDIA xStock");
  });

  it("backfills the pool with the rows behind a dropped duplicate", async () => {
    upstream([
      token("cbBTC", 900),
      token("NVDA", 800),
      token("NVDA", 700),
      token("HYPE", 600),
    ]);

    // Three asked for, three returned — the duplicate does not cost a slot.
    const pool = (await fetchTrending(3)).tokens;
    assert.deepEqual(symbolsOf(pool), ["cbBTC", "NVDA", "HYPE"]);
  });

  it("still ranks by volume, busiest first", async () => {
    upstream([token("cbBTC", 900), token("HYPE", 700), token("ZEC", 500)]);
    assert.deepEqual(symbolsOf((await fetchTrending(4)).tokens), ["cbBTC", "HYPE", "ZEC"]);
  });

  it("drops what cannot race: stablecoins and liquid-staking tokens", async () => {
    // Both sit wherever their volume puts them and never move rank for a reason
    // a player could read, so a board holding them is a board with dead rows.
    upstream([
      token("USDC", 5000),
      token("USD1", 4000),
      token("hSOL", 3000),
      token("jitoSOL", 2500),
      token("cbBTC", 900),
    ]);
    assert.deepEqual(symbolsOf((await fetchTrending(10)).tokens), ["cbBTC"]);
  });

  it("drops a book too thin to be worth racing, however busy it is", async () => {
    upstream([
      token("PUMPED", 9000, { liquidity: 50_000 }),
      token("cbBTC", 900, { liquidity: 30_000_000 }),
    ]);
    // The dropped one is the *busier* of the two, which is the point: fifty
    // thousand dollars of liquidity turning over nine thousand an hour puts its
    // place on the board within reach of a player's budget, and rank is what
    // this game takes bets on.
    assert.deepEqual(symbolsOf((await fetchTrending(10)).tokens), ["cbBTC"]);
  });

  it("reports the freshest trade as the measurement's time", async () => {
    upstream([
      token("cbBTC", 900, { last_trade_unix_time: 1_700_000_500 }),
      token("HYPE", 700, { last_trade_unix_time: 1_700_000_900 }),
    ]);
    const { asOf } = await fetchTrending(10);
    assert.equal(asOf, 1_700_000_900_000, "milliseconds, and the newest of them");
  });
});
