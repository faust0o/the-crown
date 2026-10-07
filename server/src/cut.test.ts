import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { CUT_GRACE_MS, cutDecision } from "./rounds";

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
