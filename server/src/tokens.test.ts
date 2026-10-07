import { strict as assert } from "node:assert";
import { after, beforeEach, describe, it } from "node:test";

/**
 * The pool as it leaves the network boundary, and the one invariant everything
 * downstream of it depends on: a symbol names exactly one token.
 *
 * It is not an invariant any upstream has held to — a single page of hourly
 * volume returned NVDA twice and CALICO twice, on distinct mints, because the
 * tokenised equities share tickers across wrappers. The day it broke it broke
 * the game outright rather than drawing a duplicate row: a round's entries are
 * keyed (roundId, symbol), so a field carrying one twice cannot be written at
 * all, and no round opened until the pool changed on its own.
 *
 * The module reads its configuration once, at load, so these are set before the
 * import rather than depending on whatever a developer keeps in .env.
 */
process.env.JUPITER_BASE = "https://jup.test";
process.env.JUPITER_API_KEY = "";
process.env.ORACLE_WINDOW = "1h";
// A real floor, so the test that claims to exercise it does. Every token
// built by `token()` sits above this unless it says otherwise.
process.env.ORACLE_MIN_LIQUIDITY = "1000000";
const { fetchTrending, forgetMintsForTest, UpstreamError } = await import("./oracle/jupiter");

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
});

/** Every URL the module asked for, in order. */
let asked: string[] = [];

const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });

/**
 * Stand in Jupiter: `top` is the `toptraded` page, and `search` answers a
 * search by whatever its query names — a mint, a list of them, or a symbol.
 */
function upstream(
  top: unknown[],
  opts: { headers?: Record<string, string>; search?: Record<string, unknown>[] } = {}
): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    asked.push(url.pathname + url.search);
    if (url.pathname.startsWith("/tokens/v2/toptraded/")) return json(top, opts.headers);
    if (url.pathname === "/tokens/v2/search") {
      // Loose, the way the real search is: a mint matches itself, and a term
      // matches every symbol containing it.
      const terms = (url.searchParams.get("query") ?? "").split(",");
      return json(
        (opts.search ?? []).filter((r) =>
          terms.some((t) => String(r.id) === t || String(r.symbol).includes(t))
        )
      );
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

let mints = 0;
const token = (
  symbol: string,
  volume: number,
  extra: Record<string, unknown> = {}
): Record<string, unknown> => ({
  id: `mint-${symbol}-${mints++}`,
  symbol,
  name: `${symbol} token`,
  icon: `https://example.test/${symbol}.png`,
  usdPrice: 1,
  liquidity: 10_000_000,
  isVerified: true,
  tags: ["verified"],
  priceBlockId: 1_000,
  updatedAt: "2026-10-07T12:00:00.000Z",
  // Split across both sides, so a reader that took only one would be caught.
  stats1h: { buyVolume: volume / 2, sellVolume: volume / 2, numBuys: 6, numSells: 4, numTraders: 7 },
  stats24h: { buyVolume: volume * 10, sellVolume: volume * 10 },
  ...extra,
});

const symbolsOf = (pool: { symbol: string }[]) => pool.map((t) => t.symbol);

beforeEach(() => {
  asked = [];
  forgetMintsForTest();
});

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
    upstream([token("cbBTC", 900), token("NVDA", 800), token("NVDA", 700), token("HYPE", 600)]);

    // Three asked for, three returned — the duplicate does not cost a slot.
    const pool = (await fetchTrending(3)).tokens;
    assert.deepEqual(symbolsOf(pool), ["cbBTC", "NVDA", "HYPE"]);
  });

  it("ranks by the window's volume, both sides of it, busiest first", async () => {
    // Out of order on purpose: the page's own order is Jupiter's, and the
    // ranking is this game's.
    upstream([token("ZEC", 500), token("cbBTC", 900), token("HYPE", 700)]);
    const { tokens } = await fetchTrending(4);
    assert.deepEqual(symbolsOf(tokens), ["cbBTC", "HYPE", "ZEC"]);
    assert.equal(tokens[0].volume, 900, "buy and sell volume together");
    assert.equal(tokens[0].trades1h, 10);
    assert.equal(tokens[0].wallets1h, 7);
  });

  it("knows nothing of a token Jupiter has not verified, however busy", async () => {
    // A ticker is not an identity. An unverified HYPE is somebody else's token
    // under the same name, and letting it in would hand its numbers to the
    // real one's row — or its place on the board.
    upstream([
      token("HYPE", 9000, { isVerified: false, tags: [] }),
      token("HYPE", 700),
      token("SCAM", 8000, { isVerified: false, tags: [] }),
      token("cbBTC", 900),
    ]);
    const { tokens, watched } = await fetchTrending(10);
    assert.deepEqual(symbolsOf(tokens), ["cbBTC", "HYPE"]);
    assert.equal(tokens[1].volume, 700, "the verified HYPE, not the busier impostor");
    assert.ok(!watched.some((t) => t.symbol === "SCAM"), "and not even watched");
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

  it("takes Jupiter's word for a stablecoin or LST whose name gives nothing away", async () => {
    // The shapes only catch the names somebody thought of. The tags catch the
    // next one.
    upstream([
      token("BOLD", 5000, { tags: ["verified", "stable"] }),
      token("PICO", 4000, { tags: ["verified", "lst"] }),
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

  it("keeps measuring a token too thin to race", async () => {
    // The floor decides what may be *raced*, not what may be *known*. A
    // liquidity reading can blink mid-round — a coin turning over $8.7m an hour
    // once reported $5 for one poll — and dropping the row read as a dead
    // market for a coin that never stopped trading.
    upstream([token("cbBTC", 900), token("HOOD", 800, { liquidity: 5 }), token("HYPE", 700)]);

    const { tokens, watched } = await fetchTrending(10);

    assert.deepEqual(symbolsOf(tokens), ["cbBTC", "HYPE"], "it cannot race");
    const hood = watched.find((t) => t.symbol === "HOOD");
    assert.ok(hood, "but it is still watched");
    assert.equal(hood!.racing, false, "and says plainly that it is not racing");
    assert.equal(hood!.volume, 800, "with the volume it is actually trading");
  });

  it("gives a symbol's place to the row that can race, not the busiest", async () => {
    upstream([
      token("NVDA", 900, { liquidity: 5, name: "NVIDIA, a thin wrapper" }),
      token("NVDA", 400, { name: "NVIDIA xStock" }),
      token("cbBTC", 800),
    ]);

    const { tokens } = await fetchTrending(10);

    assert.deepEqual(symbolsOf(tokens), ["cbBTC", "NVDA"], "and it ranks where its own volume puts it");
    assert.equal(tokens[1].name, "NVIDIA xStock");
  });
});

describe("what the pool says about its own freshness", () => {
  it("reports when Jupiter computed it, as the newest row it stamped", async () => {
    upstream([
      token("cbBTC", 900, { updatedAt: "2026-10-07T12:00:05.000Z" }),
      token("HYPE", 700, { updatedAt: "2026-10-07T12:00:09.000Z" }),
    ]);
    const { asOf } = await fetchTrending(10);
    assert.equal(asOf, Date.parse("2026-10-07T12:00:09.000Z"));
  });

  it("reports the slot the pool's prices were read at, as their median", async () => {
    // A median, because one busy coin's price is fresh whatever the feed is
    // doing and one quiet coin's is old however healthy it is.
    upstream([
      token("A", 900, { priceBlockId: 100 }),
      token("B", 800, { priceBlockId: 5_000 }),
      token("C", 700, { priceBlockId: 5_010 }),
      token("D", 600, { priceBlockId: 5_020 }),
      token("E", 500, { priceBlockId: 9_999_999 }),
    ]);
    assert.equal((await fetchTrending(10)).slot, 5_010);
  });

  it("says when the upstream will next have something new, from its cache headers", async () => {
    upstream([token("cbBTC", 900)], { headers: { "cache-control": "public, max-age=15", age: "11" } });
    assert.equal((await fetchTrending(10)).freshInMs, 4_000);

    upstream([token("cbBTC", 900)], { headers: { "cache-control": "public, max-age=15" } });
    assert.equal((await fetchTrending(10)).freshInMs, 15_000, "no age is a copy straight from origin");

    upstream([token("cbBTC", 900)]);
    assert.equal((await fetchTrending(10)).freshInMs, null, "and no header is no promise");
  });

  it("carries how long a rate limit asked us to wait", async () => {
    globalThis.fetch = (async () =>
      new Response("slow down", {
        status: 429,
        headers: { "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 8) },
      })) as typeof fetch;
    await assert.rejects(fetchTrending(10), (err: unknown) => {
      assert.ok(err instanceof UpstreamError);
      assert.ok(err.retryInMs! > 5_000 && err.retryInMs! <= 8_000, `waits ~8s: ${err.retryInMs}`);
      return true;
    });
  });
});

/**
 * A round is a promise to follow ten coins until it ends, and the top hundred
 * by volume is not that promise: the coin that collapsed out of it is the one
 * the round is about.
 */
describe("following a round's coins off the top of the market", () => {
  it("asks for them by mint once it has seen them", async () => {
    const hype = token("HYPE", 700);
    upstream([token("cbBTC", 900), hype]);
    await fetchTrending(10, ["HYPE"]);
    assert.ok(!asked.some((u) => u.startsWith("/tokens/v2/search")), "nothing to look up while it is on the page");

    // HYPE has fallen off the page.
    asked = [];
    upstream([token("cbBTC", 900)], { search: [{ ...hype, stats1h: { buyVolume: 20, sellVolume: 20 } }] });
    const { watched } = await fetchTrending(10, ["HYPE"]);

    assert.deepEqual(
      asked.filter((u) => u.startsWith("/tokens/v2/search")),
      [`/tokens/v2/search?query=${hype.id}`],
      "one request, by the mint it already knew"
    );
    assert.equal(watched.find((t) => t.symbol === "HYPE")?.volume, 40, "and it is still measured");
  });

  it("finds them by symbol after a restart, taking the verified one", async () => {
    // A process that has never seen HYPE has no mint for it, and a symbol
    // search is crowded with namesakes.
    upstream([token("cbBTC", 900)], {
      search: [
        token("HYPE", 5_000, { isVerified: false, tags: [] }),
        token("HYPEPAD", 4_000),
        token("HYPE", 300),
      ],
    });
    const { watched, tokens } = await fetchTrending(10, ["HYPE"]);

    const hype = watched.find((t) => t.symbol === "HYPE");
    assert.equal(hype?.volume, 300, "the verified HYPE, not the namesake");
    assert.ok(!watched.some((t) => t.symbol === "HYPEPAD"), "and nothing the search dragged in");
    assert.deepEqual(symbolsOf(tokens), ["cbBTC", "HYPE"]);
  });

  it("keeps the board when a lookup fails", async () => {
    const top = [token("cbBTC", 900)];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.startsWith("/tokens/v2/toptraded/")) return json(top);
      return new Response("boom", { status: 500 });
    }) as typeof fetch;
    const { tokens } = await fetchTrending(10, ["HYPE"]);
    assert.deepEqual(symbolsOf(tokens), ["cbBTC"]);
  });
});
