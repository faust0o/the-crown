import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { CUT_WINDOW_SECONDS, POST_ROUND_SECONDS, crownDecided, cutDecision, roundTimes } from "./rounds";

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
  const endsAt = cutAt + 30_000;
  const live = (describes: number) => ({ live: true, describes });

  it("is not made before its instant, whatever the feed holds", () => {
    assert.equal(cutDecision(cutAt - 1, cutAt, endsAt, live(cutAt + 5_000)), "wait");
  });

  it("is made from the first live reading of the market at or after its instant", () => {
    assert.equal(cutDecision(cutAt + 20_000, cutAt, endsAt, live(cutAt)), "record");
    assert.equal(cutDecision(cutAt + 20_000, cutAt, endsAt, live(cutAt + 6_000)), "record");
  });

  it("waits out a reading from before its instant", () => {
    // The board in hand describes the market a few seconds before the cut —
    // the normal state for the first moments after it, since every reading
    // trails the chain a little.
    assert.equal(cutDecision(cutAt + 5_000, cutAt, endsAt, live(cutAt - 9_000)), "wait");
  });

  it("does not take a reading the oracle itself will not call live", () => {
    assert.equal(cutDecision(cutAt + 5_000, cutAt, endsAt, { live: false, describes: cutAt + 1_000 }), "wait");
  });

  it("refunds the round once it has ended without one", () => {
    // The deadline is the round's end, not a grace counted from the cut: the
    // next round opens then, and takes its crown from this result.
    const frozen = live(cutAt - 3_600_000);
    assert.equal(cutDecision(endsAt - 1, cutAt, endsAt, frozen), "wait");
    assert.equal(cutDecision(endsAt, cutAt, endsAt, frozen), "void");
    assert.equal(cutDecision(endsAt, cutAt, endsAt, { live: false, describes: 0 }), "void");
  });

  it("gives a cut at the very end of an older round half a minute anyway", () => {
    // A round opened before the window was held back can be cut on its last
    // second; refunding it on the spot would refund it for being on time.
    const lastSecond = live(endsAt - 1_000 - 9_000);
    const post = POST_ROUND_SECONDS * 1_000;
    assert.equal(cutDecision(endsAt + post - 1_001, endsAt - 1_000, endsAt, lastSecond), "wait");
    assert.equal(cutDecision(endsAt + post - 1_000, endsAt - 1_000, endsAt, lastSecond), "void");
  });

  it("still records a good reading that arrives late, rather than refunding it", () => {
    // Late is not stale: a reading taken after the instant is the cut, whenever
    // the tick that notices it happens to run.
    assert.equal(cutDecision(endsAt + 90_000, cutAt, endsAt, live(cutAt + 1_000)), "record");
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
/**
 * A round runs from one half-hour mark to the next, and the cut has to be in
 * before it ends: the cut window closes `POST_ROUND_SECONDS` early, so the
 * playable round with its cut is 29:30 and the last half minute is processing.
 */
describe("a round's schedule", () => {
  const startsAt = new Date("2026-10-08T00:30:00Z");
  const { lockAt, endsAt } = roundTimes(startsAt);
  // The defaults are the schedule being pinned; a demo run with short rounds
  // has asked for a different one.
  const overridden = ["ROUND_MINUTES", "CUT_WINDOW_SECONDS", "POST_ROUND_SECONDS"].some(
    (name) => process.env[name]
  );

  it("ends exactly on the next half-hour mark", (t) => {
    if (overridden) return t.skip("round schedule overridden by env");
    assert.equal(endsAt.toISOString(), "2026-10-08T01:00:00.000Z");
  });

  it("closes the cut window half a minute before it ends", (t) => {
    if (overridden) return t.skip("round schedule overridden by env");
    assert.equal(CUT_WINDOW_SECONDS, 60);
    assert.equal(POST_ROUND_SECONDS, 30);
    assert.equal(lockAt.toISOString(), "2026-10-08T00:58:30.000Z");
    // The latest instant the cut can be committed to, and it is still inside
    // the 29:30 of play.
    const lastCut = lockAt.getTime() + CUT_WINDOW_SECONDS * 1_000 - 1;
    assert.ok(lastCut < Date.parse("2026-10-08T00:59:30.000Z"));
  });
});

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
