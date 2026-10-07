import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { CAP, FEE, FLOOR, probabilities } from "./crypto-odds";

/**
 * What a line is worth before anybody has traded it.
 *
 * This is the model's entire remaining say in the game, and it is not a small
 * one: `openRound` turns each of these three numbers into an opening pool, and
 * from there the mark is that pool's share of the coin's. So a prior that is
 * wrong is not a chip that reads oddly for a moment — it is the price every
 * subsequent fill is a *dilution of*, and it stays in the book for the round.
 *
 * There is no vector file to check these against, because unlike `pricing.ts`
 * there is no second implementation they have to agree with. What can be checked
 * is the set of properties the rest of the server assumes and would not notice
 * losing: that the three outcomes are a distribution, that the one impossible
 * outcome is priced at zero rather than merely cheaply, and that the one that
 * *looks* impossible is not.
 */

const BOARD = 10;
const RANKS = Array.from({ length: 15 }, (_, i) => i + 1);
const legs = (p: { higher: number; draw: number; lower: number }) => [p.higher, p.draw, p.lower];

describe("the opening prior", () => {
  it("is a distribution at every rank on the board and past it", () => {
    // `openRound` stakes the opening pool in proportion to these and quotes the
    // marks as `round(p * 100)`, so anything that does not sum to one is a board
    // whose three prices do not sum to a hundred — the property `market.ts`
    // states outright and `remark` divides the target by.
    for (const rank of RANKS) {
      const p = probabilities("ANY", rank, BOARD);
      const total = p.higher + p.draw + p.lower;
      assert.ok(
        Math.abs(total - 1) < 1e-9,
        `rank ${rank} sums to ${total}, not one`
      );
      for (const leg of legs(p)) {
        assert.ok(leg >= 0 && leg <= 1, `rank ${rank} priced a leg at ${leg}`);
      }
    }
  });

  it("still sums to a hundred in whole cents", () => {
    // The rounding is where an almost-normalised prior actually shows up: the
    // board is quoted in integers, so a band that sums to 0.99 posts a coin
    // whose three chips add to ninety-nine and whose payouts are all slightly
    // too generous. Checked at the granularity the player is shown.
    for (const rank of RANKS) {
      const cents = legs(probabilities("ANY", rank, BOARD)).map((p) => Math.round(p * 100));
      assert.equal(
        cents.reduce((a, b) => a + b, 0),
        100,
        `rank ${rank} quotes ${cents.join("/")}`
      );
    }
  });

  it("prices HIGHER at exactly zero for the coin already in front", () => {
    // Not "cheaply" — exactly zero, and the distinction is load-bearing.
    // `openRound` decides whether a leg exists at all with `if (!(p > 0))`, so a
    // rank-1 HIGHER prior of even a tenth of a cent would open a line on an
    // outcome that cannot occur, take real money for it, and settle every one of
    // those bets as a loss.
    const p = probabilities("BTC", 1, BOARD);
    assert.equal(p.higher, 0);
    assert.ok(p.draw > 0 && p.lower > 0, "the freed mass has to land somewhere tradable");
  });

  it("hands the leader's freed mass to DRAW and LOWER rather than dropping it", () => {
    // Rank 1 is the only rank whose prior is not simply its band, so it is the
    // only one where the redistribution can go wrong quietly. Both legs have to
    // end up worth *more* than the band said, or the mass went nowhere.
    const band = probabilities("BTC", 2, BOARD); // same band, no redistribution
    const first = probabilities("BTC", 1, BOARD);
    assert.ok(first.draw > band.draw, "DRAW did not take its share");
    assert.ok(first.lower > band.lower, "LOWER did not take its share");
    assert.ok(
      first.draw - band.draw > first.lower - band.lower,
      "DRAW takes the larger share of a leader's impossible HIGHER"
    );
  });

  it("still prices LOWER for a coin that opened last", () => {
    // The regression named in the source. Last place was once treated like rank
    // 1 in reverse, which is a category error: a coin at the bottom *can* finish
    // LOWER — falling off the board is exactly that, and `recordCut` settles it
    // that way. It simply isn't offered as a bet, which is `openRound`'s
    // decision. Zeroing it here handed a third outcome's worth of probability to
    // the other two, so both of their lines were priced too high all round.
    const last = probabilities("SHIB", BOARD, BOARD);
    assert.ok(last.lower > 0, "a coin at the bottom of the board can still fall off it");
    assert.ok(last.higher > 0 && last.draw > 0);
  });

  it("does not read the coin's name — the board position is the whole signal", () => {
    // Documented as deliberate, and worth pinning: the field is whatever is
    // trending, so there are no stable per-token priors to lean on. A test that
    // fails here is a sign somebody has started fitting on symbols, which needs
    // the refit the module's header describes rather than a special case.
    assert.deepEqual(probabilities("BTC", 5, BOARD), probabilities("SHIB", 5, BOARD));
  });

  it("puts the band edges at 3, 6 and 10", () => {
    // The bands are measured, so their boundaries are data rather than taste —
    // but an off-by-one in `<=` would move a whole rank into the neighbouring
    // band and reprice its three lines, which no other test would notice.
    const at = (rank: number) => JSON.stringify(probabilities("ANY", rank, BOARD));
    for (const [lo, hi] of [[1, 3], [4, 6], [7, 10], [11, 14]] as const) {
      for (let r = lo + 1; r <= hi; r++) {
        if (lo === 1 && r === 1) continue;
        assert.equal(at(Math.max(lo, 2)), at(r), `ranks ${lo}..${hi} should share a prior`);
      }
    }
    assert.notEqual(at(3), at(4), "the first band edge moved");
    assert.notEqual(at(6), at(7), "the second band edge moved");
    assert.notEqual(at(10), at(11), "the third band edge moved");
  });

  it("mean-reverts upward outside the top ten", () => {
    // The one directional claim the priors make. Coins deep in the field were
    // measured to climb more often than they fall, where mid-board coins do the
    // opposite; if that inverted, longshots would be priced as favourites.
    const deep = probabilities("ANY", 12, BOARD);
    const mid = probabilities("ANY", 5, BOARD);
    assert.ok(deep.higher > deep.lower, "a coin outside the top ten should be priced to climb");
    assert.ok(mid.lower > mid.higher, "a mid-board coin should be priced to slip");
  });
});

describe("the bounds every quote is clamped to", () => {
  it("never lets a leg reach certainty in either direction", () => {
    // A leg at 0 pays infinitely and a leg at 100 pays nothing, and both are
    // states the book must not be able to reach however hard one line is bought.
    assert.ok(FLOOR > 0, "a free leg pays an unbounded multiple");
    assert.ok(CAP < 1, "a certain leg is not a bet");
    assert.ok(FLOOR < CAP);
  });

  it("sets the cap at exactly what a two-legged coin can print", () => {
    // The bounds are not independent knobs. A coin's outcomes sum to one, so
    // the most any leg can be worth is one less whatever the other open legs are
    // pinned at — and the cap is what makes that reachable rather than
    // theoretical. `crypto-odds` states the arithmetic: a coin whose starting
    // rank closes a leg has two lines, the other is held at the floor, and the
    // survivor tops out at 99c. That is the cap, to the cent.
    assert.equal(CAP, 1 - FLOOR, "the cap is no longer what a two-legged coin can reach");
  });

  it("leaves a three-legged coin short of the cap, as documented", () => {
    // With all three lines open, two floors stand between a leg and certainty,
    // so it tops out at 98c and the cap never binds. Worth pinning because the
    // payout it implies is the one a player sees on a favourite: widening the
    // floor moves this, and the note in `crypto-odds` about 1.01x versus 1.06x
    // is the trade being made here.
    assert.ok(1 - 2 * FLOOR < CAP, "a three-legged coin should not be able to reach the cap");
  });

  it("keeps the house margin small enough to be a margin", () => {
    // FEE is spread across the three legs. Large enough to matter and small
    // enough that it cannot flip which side of a line is worth taking.
    assert.ok(FEE > 0 && FEE < 0.1, `FEE of ${FEE} is not a spread`);
  });
});
