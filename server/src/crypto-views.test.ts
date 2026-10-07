import { strict as assert } from "node:assert";
import { beforeEach, describe, it } from "node:test";
import { liveRankOf, toCryptoBetView, toRoundView } from "./crypto-views";
import {
  closeCents,
  closeValue,
  openRound,
  quoteCents,
  record,
  resetMarket,
  type Direction,
  type RoundBook,
} from "./market";
import { BOARD_SIZE, POOL, oracle, type Standing } from "./oracle/index";
import type { CryptoBet, Round, RoundEntry } from "./generated/prisma";

/**
 * A position on a coin that dropped off the board is the case the views used to
 * get wrong, and it is not an edge case: the coin is *below* every visible slot,
 * so LOWER on it has already won. These pin the position down at the same rank
 * `recordCut` will score it at.
 */

const ROUND: RoundBook = {
  id: "round-under-test",
  startsAt: new Date(Date.now() - 20 * 60_000),
  endsAt: new Date(Date.now() + 10 * 60_000),
  crownSymbol: null,
  entries: Array.from({ length: BOARD_SIZE }, (_, i) => ({
    symbol: `C${i + 1}`,
    ticker: `C${i + 1}`,
    startRank: i + 1,
  })),
};

/** 100 credits on C5 LOWER at 2.5 — 250 shares. C5 opened 5th. */
function position(overrides: Partial<CryptoBet> = {}): CryptoBet {
  return {
    id: "bet-1",
    userId: "user-1",
    roundId: ROUND.id,
    // A Postgres-path position: the money is in the row, not in a program.
    chainAddress: null,
    // A lot somebody placed, rather than a slice left by a partial sale.
    parentId: null,
    symbol: "C5",
    ticker: "C5",
    direction: "LOWER",
    stake: 100,
    odds: 2.5,
    startRank: 5,
    status: "OPEN",
    cutRank: null,
    payout: 0,
    openedAt: new Date(),
    resolvedAt: null,
    ...overrides,
  };
}

/** The same round as it comes back out of Prisma, ending at `endsAt`. */
function persisted(endsAt: Date): Round & { entries: RoundEntry[] } {
  return {
    id: ROUND.id,
    startsAt: ROUND.startsAt,
    lockAt: new Date(endsAt.getTime() - 60_000),
    endsAt,
    commitHash: "hash",
    seed: null,
    cutAt: null,
    crownSymbol: null,
    cutWindowSeconds: 60,
    status: "OPEN",
    createdAt: ROUND.startsAt,
    entries: ROUND.entries.map((e, i) => ({
      id: `entry-${i}`,
      roundId: ROUND.id,
      symbol: e.symbol,
      ticker: e.ticker,
      startRank: e.startRank,
      startVolume: 1_000 - i * 50,
      cutRank: null,
      cutVolume: null,
    })),
  };
}

function standing(symbol: string, rank: number): Standing {
  return {
    symbol,
    ticker: symbol,
    name: symbol,
    imageUrl: null,
    rank,
    previousRank: null,
    quoteVolume: 100,
    price: 1,
    trades1h: 0,
    wallets1h: 0,
    priceChange1hPercent: 0,
  };
}

const print = (symbol: string, direction: Direction) =>
  record({ at: Date.now(), symbol, direction, size: 5_000 });

beforeEach(() => {
  resetMarket();
  // A cold oracle by default, which is what most of these assume — and set
  // explicitly so that the one test which stands a board up cannot leak it into
  // whatever runs next. Untracked for the same reason.
  oracle.track([]);
  oracle.seedForTest([]);
  openRound(ROUND);
});

describe("a coin that has fallen off the board", () => {
  it("stands one below the last visible slot, not nowhere", () => {
    assert.equal(liveRankOf("C5", []), BOARD_SIZE + 1, "delisted");
    assert.equal(liveRankOf("C5", [standing("C5", 4)]), 4, "still on the board");
  });

  it("values the position off the book instead of showing nothing", () => {
    print("C5", "LOWER");
    // The position's *own* bid, not the resting one. Closing walks the pool back
    // down, so what a hundred credits fetch is a shade under the mark the board
    // is showing — and the view has to quote the number the cash-out will
    // actually pay, or it advertises a price nobody can get.
    const bid = closeCents("C5", "LOWER", 100)!;

    const view = toCryptoBetView(position(), { rank: liveRankOf("C5", []) });

    assert.equal(view.liveRank, BOARD_SIZE + 1);
    assert.equal(view.liveValue, closeValue(100, 2.5, bid));
    assert.ok(
      view.liveValue! > position().stake,
      `a winning position must be worth more than its stake: ${view.liveValue}`
    );
  });

  it("can be closed — both of the cash-out's preconditions hold", () => {
    print("C5", "LOWER");
    // `cashOutCryptoBet` bails on a null standing or a line that isn't on the
    // book, then pays `closeValue` off `closeCents` at the position's own size.
    // Neither can come back null for a delisted coin now, and both sides agree.
    const rank = liveRankOf("C5", []);
    const quote = quoteCents("C5", "LOWER");

    assert.equal(rank, BOARD_SIZE + 1);
    assert.ok(quote, "the line is still on the book");
    assert.equal(
      closeValue(100, 2.5, closeCents("C5", "LOWER", 100)!),
      toCryptoBetView(position(), { rank }).liveValue,
      "the cash-out must pay exactly what the position was showing"
    );
  });

  it("quotes a large position at its own size, not at the resting bid", () => {
    // The regression this exists for. `liveValue` used the zero-size bid while
    // `cashOutCryptoBet` has always paid `closeCents` at the real stake, so a
    // player read a number nobody could be paid — and it erred *high*, which is
    // the direction that gets someone to click.
    //
    // It survived because the two agree at small size: every position in the
    // tests above is 100 credits, which rounds to the same cent either way. Only
    // a position big enough to move the pool it is closing into shows it.
    print("C5", "LOWER");
    const rank = liveRankOf("C5", []);
    const big = { ...position(), stake: 50_000 };

    const resting = quoteCents("C5", "LOWER")!.bid;
    const atSize = closeCents("C5", "LOWER", big.stake)!;

    assert.ok(
      atSize < resting,
      `closing 50k must realise less than the resting bid (${atSize} vs ${resting})`
    );
    assert.equal(
      toCryptoBetView(big, { rank }).liveValue,
      closeValue(big.stake, 2.5, atSize),
      "the view must quote the size-aware close"
    );
    assert.notEqual(
      toCryptoBetView(big, { rank }).liveValue,
      closeValue(big.stake, 2.5, resting),
      "and must not quote the resting bid"
    );
  });

  it("stands the same way in the board rows as in the position", () => {
    // The oracle is cold here, so every entry reads as off the board — which is
    // the case the row used to report as `null` while a position on the very
    // same coin reported 11.
    const rows = toRoundView(persisted(ROUND.endsAt)).entries;
    assert.ok(
      rows.every((e) => e.liveRank === BOARD_SIZE + 1),
      `board rows: ${rows.map((e) => e.liveRank).join(",")}`
    );
  });

  it("still reports what it is trading at", () => {
    // Pushed out of the visible ten but very much alive: the oracle watches a
    // wider pool than it ranks, and the row is sourced from that. Reading it off
    // the board instead printed "$0 · —" the moment a coin dropped, which reads
    // as a dead market when what happened is the thing the round is about — and
    // the volume is also the number that says whether it is coming back.
    oracle.seedForTest([
      ...Array.from({ length: BOARD_SIZE }, (_, i) => ({
        symbol: `X${i + 1}`,
        volume: 5_000 - i * 100,
      })),
      { symbol: "C5", volume: 1_234 },
    ]);

    const row = toRoundView(persisted(ROUND.endsAt)).entries.find((e) => e.symbol === "C5")!;

    assert.equal(row.liveRank, BOARD_SIZE + 1, "it is off the board");
    assert.equal(row.liveVolume, 1_234, "and still trading, with real volume");
    assert.ok(row.livePrice > 0, `and a real price: ${row.livePrice}`);
  });

  it("still reports it after it has fallen past the pool as well", () => {
    // The board is ten and the ranking pool is a couple of dozen, and a coin
    // that collapses out of the first usually keeps going. The pool was where
    // the numbers came from, so this is where the row went back to reading
    // "$0 · —" — on a coin the round is still scoring, still quoting a book on,
    // and still holding positions in. The oracle watches the whole page the
    // upstream sends, which is several times deeper than it ranks.
    oracle.seedForTest([
      ...Array.from({ length: POOL + 4 }, (_, i) => ({
        symbol: `X${i + 1}`,
        volume: 50_000 - i * 100,
      })),
      { symbol: "C5", volume: 900 },
    ]);

    const row = toRoundView(persisted(ROUND.endsAt)).entries.find((e) => e.symbol === "C5")!;

    assert.ok(
      !oracle.standings(POOL).some((s) => s.symbol === "C5"),
      "precondition: it is past the pool, not merely off the board"
    );
    assert.equal(row.liveVolume, 900, "the volume that is the reason it fell");
    assert.ok(row.livePrice > 0, `and a real price: ${row.livePrice}`);
  });

  it("ranks it by its volume when it has stopped qualifying to race", () => {
    // The case that was actually happening. A coin does not have to be relegated
    // to leave the board: failing an eligibility test did it too, and that is not
    // an outcome the round is scored on — it is a liquidity reading that blinked.
    // Measured on the live feed, a coin turning over $8.7m an hour reported $5
    // of liquidity; later RDDT, second on the board by volume, read $240k
    // against a $250k floor. Each was drawn last with the volume of a leader,
    // and would have been scored last at the cut.
    oracle.track(ROUND.entries.map((e) => e.symbol));
    oracle.seedForTest([
      // Busier than the whole board — and the seam takes rows busiest first.
      { symbol: "C5", volume: 8_696_085, racing: false },
      ...Array.from({ length: BOARD_SIZE }, (_, i) => ({
        symbol: `X${i + 1}`,
        volume: 5_000 - i * 100,
      })),
    ]);

    const row = toRoundView(persisted(ROUND.endsAt)).entries.find((e) => e.symbol === "C5")!;

    assert.equal(row.liveRank, 1, "it stands where its volume puts it");
    assert.equal(row.liveVolume, 8_696_085, "and reports the volume that put it there");
    assert.ok(row.livePrice > 0, `and priced: ${row.livePrice}`);
  });

  it("reports no live rank once the round is over", () => {
    // A settled round in the results panel is a finished race. Reporting a
    // coin's standing in today's board as its rank in that one is worse than
    // reporting nothing, which is what `cutRank` is for.
    const rows = toRoundView(persisted(new Date(Date.now() - 60_000))).entries;
    assert.ok(rows.every((e) => e.liveRank === null));
  });

  it("leaves a resolved position alone", () => {
    print("C5", "LOWER");
    const settled = toCryptoBetView(position({ status: "WON", payout: 250 }), {
      rank: liveRankOf("C5", []),
    });
    assert.equal(settled.liveRank, null);
    assert.equal(settled.liveValue, null, "there is nothing left to close");
  });
});
