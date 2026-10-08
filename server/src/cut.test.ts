import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { CUT_GRACE_MS, crownDecided, cutDecision } from "./rounds";

/**
 * What a cut is allowed to be made of.
 *
 * The cut used to take whatever the oracle held at the instant, with no
 * question asked of it. A feed frozen since before betting closed settled the
 * round on numbers a player could have read while betting, and an empty board
 * scored every coin as relegated. The rule now is a reading of the market at or
 * after the committed instant, or nothing — and nothing refunds.
 */
describe("the cut", () => {
  const cutAt = 1_000_000;
  const live = (describes: number) => ({ live: true, describes });

  it("is not made before its instant, whatever the feed holds", () => {
    assert.equal(cutDecision(cutAt - 1, cutAt, live(cutAt + 5_000)), "wait");
  });

  it("is made from the first live reading of the market at or after its instant", () => {
    assert.equal(cutDecision(cutAt + 20_000, cutAt, live(cutAt)), "record");
    assert.equal(cutDecision(cutAt + 20_000, cutAt, live(cutAt + 6_000)), "record");
  });

  it("waits out a reading from before its instant", () => {
    // The board in hand describes the market a few seconds before the cut —
    // the normal state for the first moments after it, since every reading
    // trails the chain a little.
    assert.equal(cutDecision(cutAt + 5_000, cutAt, live(cutAt - 9_000)), "wait");
  });

  it("does not take a reading the oracle itself will not call live", () => {
    assert.equal(cutDecision(cutAt + 5_000, cutAt, { live: false, describes: cutAt + 1_000 }), "wait");
  });

  it("refunds the round once the grace has run out without one", () => {
    const frozen = live(cutAt - 3_600_000);
    assert.equal(cutDecision(cutAt + CUT_GRACE_MS - 1, cutAt, frozen), "wait");
    assert.equal(cutDecision(cutAt + CUT_GRACE_MS, cutAt, frozen), "void");
    assert.equal(cutDecision(cutAt + CUT_GRACE_MS, cutAt, { live: false, describes: 0 }), "void");
  });

  it("still records a good reading that arrives late, rather than refunding it", () => {
    // Late is not stale: a reading taken after the instant is the cut, whenever
    // the tick that notices it happens to run.
    assert.equal(cutDecision(cutAt + CUT_GRACE_MS * 3, cutAt, live(cutAt + 1_000)), "record");
  });
});

/**
 * When the next round may open: not before the cut that crowns it.
 *
 * A cut late in the round is recorded after the boundary, and the round that
 * opened on that boundary took its crown from the round before last. In
 * production SPX finished first and PUMP, which it had just beaten, went on
 * wearing the crown.
 */
describe("the next round's crown", () => {
  it("is not decided while the round before it is still waiting on its cut", () => {
    assert.equal(crownDecided({ status: "LOCKED", seed: "s" }), false);
    // An OPEN round past its end is one the loop has not flipped yet — same wait.
    assert.equal(crownDecided({ status: "OPEN", seed: "s" }), false);
  });

  it("is decided once that cut is recorded, refunded or not", () => {
    assert.equal(crownDecided({ status: "CUT", seed: "s" }), true);
    assert.equal(crownDecided({ status: "SETTLED", seed: "s" }), true);
  });

  it("does not wait on a round that can never be cut", () => {
    assert.equal(crownDecided({ status: "LOCKED", seed: null }), true);
  });

  it("is decided for the very first round", () => {
    assert.equal(crownDecided(null), true);
  });
});
