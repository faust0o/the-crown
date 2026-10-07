import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { closeFor, quoteFor, type EntryBook } from "./book";
import { CAP_CENTS, FLOOR_CENTS, SPREAD_CENTS, remark } from "./pricing";

/**
 * The two numbers the board and the portfolio are drawn from.
 *
 * `pricing.test.ts` already holds the curve itself against vectors generated
 * from the Rust, so nothing here re-checks the arithmetic. What is not covered
 * there is the layer on top: which legs get a quote at all, what the spread does
 * at the edges of the range, and the distinction between the two bids — the
 * resting one a chip shows and the size-aware one a position is actually worth.
 *
 * That distinction is the expensive one. `crypto-views` valued open positions at
 * the resting bid while `cashOutCryptoBet` paid `closeFor`, so the number on the
 * screen was always at least as good as the number in the wallet and the gap
 * grew with position size — a player who closed a big position got less than the
 * app had been telling them all round.
 */

/** An entry with a book on it, built without a cluster to read one from. */
function entry(over: {
  staked: [bigint, bigint, bigint];
  quoted?: [boolean, boolean, boolean];
  target?: number;
  lastCents?: [number, number, number];
}): EntryBook {
  const quoted = over.quoted ?? ([true, true, true] as [boolean, boolean, boolean]);
  const target = over.target ?? 100;
  const book = { staked: over.staked, quoted, target };
  return {
    index: 0,
    symbol: "SOL",
    ticker: "SOL",
    startRank: 4,
    cutRank: null,
    book,
    // The marks the chain last wrote. Defaulted to what the book implies, which
    // is what `record_cut` and `place_bet` leave behind.
    lastCents: over.lastCents ?? remark(book),
  };
}

const HIGHER = 0;
const DRAW = 1;
const LOWER = 2;

describe("quoting a line off the chain's book", () => {
  it("puts the ask above the mark and the bid below it, by the spread", () => {
    const q = quoteFor(entry({ staked: [1_000n, 1_000n, 1_000n] }), HIGHER);
    assert.ok(q);
    assert.equal(q.ask, q.mark + SPREAD_CENTS);
    assert.equal(q.bid, q.mark - SPREAD_CENTS);
  });

  it("does not quote a leg that is not on the book", () => {
    // Real but not offered — the crown, or a leg the round's starting ranks
    // close. Null is "there is nothing to trade here", and it has to be null
    // rather than a price nobody may take: `BetPanel` renders whatever comes
    // back as a line a player can click.
    const e = entry({ staked: [1_000n, 1_000n, 1_000n], quoted: [true, true, false] });
    assert.equal(quoteFor(e, LOWER), null);
    assert.ok(quoteFor(e, HIGHER));
  });

  it("does not quote a leg the chain has not marked yet", () => {
    // 0 is what an entry account carries between `add_entry` and its first
    // print. Quoting it would post a leg at zero cents — a free option on an
    // outcome, and an unbounded payout if anybody took it.
    const e = entry({ staked: [1_000n, 1_000n, 1_000n], lastCents: [0, 50, 50] });
    assert.equal(quoteFor(e, HIGHER), null);
    assert.ok(quoteFor(e, DRAW));
  });

  it("never lets the ask past the cap however far a line has been bought", () => {
    // A leg the room has bought all round marks near certainty, and adding the
    // spread to it is what would tip it over. Past the cap the payout goes to
    // 1.00x or below, which is a line that cannot win.
    const e = entry({
      staked: [1n, 1n, 1n],
      lastCents: [CAP_CENTS, FLOOR_CENTS, FLOOR_CENTS],
    });
    const q = quoteFor(e, HIGHER);
    assert.ok(q);
    assert.equal(q.mark, CAP_CENTS);
    assert.equal(q.ask, CAP_CENTS, "the ask ran past the cap");
  });

  it("never lets the bid fall to nothing on a line nobody wants", () => {
    // The mirror, and the one that costs a *holder*. A leg marked at the floor
    // less the spread is zero or negative; a position quoted there is worth
    // nothing to close, so the panel would offer to buy it back for free.
    const e = entry({
      staked: [1n, 1n, 1n],
      lastCents: [FLOOR_CENTS, CAP_CENTS, FLOOR_CENTS],
    });
    const q = quoteFor(e, HIGHER);
    assert.ok(q);
    assert.equal(q.bid, FLOOR_CENTS, "the bid fell through the floor");
    assert.ok(q.bid > 0);
  });

  it("keeps the ask above the bid at both edges of the range", () => {
    // Crossed quotes are a free round trip. Both clamps pull toward the middle,
    // so the edges are exactly where the two could meet.
    for (const mark of [FLOOR_CENTS, FLOOR_CENTS + 1, 50, CAP_CENTS - 1, CAP_CENTS]) {
      const e = entry({ staked: [1n, 1n, 1n], lastCents: [mark, mark, mark] });
      const q = quoteFor(e, HIGHER);
      assert.ok(q, `no quote at ${mark}c`);
      assert.ok(q.ask >= q.bid, `crossed at ${mark}c: ask ${q.ask} under bid ${q.bid}`);
      assert.ok(q.ask <= CAP_CENTS && q.bid >= FLOOR_CENTS, `out of bounds at ${mark}c`);
    }
  });
});

describe("what closing a position would actually pay", () => {
  const book = entry({ staked: [40_000n, 30_000n, 30_000n] });

  it("charges a big position a worse price than a small one", () => {
    // The whole reason `closeFor` exists rather than reusing the chip's bid.
    // Closing walks the pool back down exactly as opening walked it up, so a
    // position large against the pool sells into progressively worse prices.
    const small = closeFor(book, HIGHER, 10n);
    const large = closeFor(book, HIGHER, 20_000n);
    assert.ok(small != null && large != null);
    assert.ok(large < small, `size bought no discount: ${large} vs ${small}`);
  });

  it("never pays a position more than the chip advertises", () => {
    // The invariant the portfolio depends on. The resting bid is what the *first*
    // credit out would fetch, so it is an upper bound on every size — and a
    // position valued above what closing it pays is the gap that had players
    // watching a number they could not realise.
    const chip = quoteFor(book, HIGHER);
    assert.ok(chip);
    for (const size of [1n, 100n, 1_000n, 10_000n, 39_999n]) {
      const got = closeFor(book, HIGHER, size);
      assert.ok(got != null, `no close price at ${size}`);
      assert.ok(got <= chip.bid, `closing ${size} paid ${got}, above the resting bid of ${chip.bid}`);
    }
  });

  it("gets worse monotonically as the position grows", () => {
    // Not merely worse at the extremes: a non-monotonic curve means some size
    // sells better than a smaller one, which is an arbitrage against the book.
    let previous = Infinity;
    for (const size of [1n, 10n, 100n, 1_000n, 5_000n, 10_000n, 20_000n, 39_999n]) {
      const got = closeFor(book, HIGHER, size);
      assert.ok(got != null);
      assert.ok(got <= previous, `closing ${size} paid ${got}, more than a smaller clip got`);
      previous = got;
    }
  });

  it("stays inside the bounds even for a position that is most of its leg", () => {
    // Selling nearly the whole leg drains the pool it is priced against, which
    // is where an unclamped curve goes to zero or negative.
    const got = closeFor(book, HIGHER, 39_999n);
    assert.ok(got != null);
    assert.ok(got >= FLOOR_CENTS && got <= CAP_CENTS, `out of bounds at ${got}c`);
  });

  it("does not price a close on a leg that is not on the book", () => {
    const e = entry({ staked: [40_000n, 30_000n, 30_000n], quoted: [true, true, false] });
    assert.equal(closeFor(e, LOWER, 100n), null);
  });

  it("does not price a close against an empty pool", () => {
    // A round mid-seed: the entry exists, its legs are quoted, nothing is staked.
    // Dividing by that pool is what a null is standing in for.
    const empty = entry({ staked: [0n, 0n, 0n], lastCents: [33, 33, 34] });
    assert.equal(closeFor(empty, HIGHER, 100n), null);
    assert.equal(quoteFor(empty, HIGHER)?.mark, 33, "a mark the chain wrote survives an empty pool");
  });
});
