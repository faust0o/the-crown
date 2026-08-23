import { strict as assert } from "node:assert";
import { beforeEach, describe, it } from "node:test";
import { BOARD_SIZE, oracle } from "./oracle/index";

/**
 * What the chart is a picture of.
 *
 * A round's field is fixed when it opens and does not change for its duration,
 * while the live board changes the moment anything moves. Those two sets come
 * apart in both directions at once, and the chart used to draw the wrong one:
 * a coin that opened in the field and was later pushed off the board vanished
 * from the chart while still being bettable and still holding positions, and a
 * coin that trended into the top ten mid-round appeared on it despite not being
 * in the race.
 */

/** A board, busiest first, from an ordering of symbols. */
const board = (order: string[]) =>
  order.map((symbol, i) => ({ symbol, volume: 1000 - i * 50 }));

/** Twelve coins: a pool wider than the board, so some sit below the cut. */
const AT_OPEN = board(Array.from({ length: 12 }, (_, i) => `C${i + 1}`));
/** The field is the ten the round opened on — C11 and C12 were never in it. */
const FIELD = AT_OPEN.slice(0, BOARD_SIZE).map((c) => c.symbol);

/**
 * The board mid-round: C3 has collapsed out of the visible ten and C11 has
 * trended into it. Both halves of the bug in one board.
 */
const AFTER_SHUFFLE = board([
  "C1", "C2", "C4", "C11", "C5", "C6", "C7", "C8", "C9", "C10", "C12", "C3",
]);

const symbolsIn = (points: { symbol: string }[]) => [...new Set(points.map((p) => p.symbol))].sort();

beforeEach(() => oracle.seedForTest(AT_OPEN));

describe("the chart draws the round's field", () => {
  it("keeps a coin that has been pushed off the board", () => {
    // C3 opened third and has collapsed to twelfth — below every visible slot.
    // It is still in the round, still bettable, and its LOWER line has in fact
    // already won, so it is precisely the line a player needs to see.
    oracle.seedForTest(AFTER_SHUFFLE);
    assert.ok(
      !oracle.standings(BOARD_SIZE).some((s) => s.symbol === "C3"),
      "precondition: C3 has dropped off the visible board"
    );

    const drawn = symbolsIn(oracle.rankHistory(90, FIELD));

    assert.ok(drawn.includes("C3"), `a dropped coin must stay on the chart: ${drawn.join(",")}`);
    assert.deepEqual(drawn, [...FIELD].sort(), "and the field is drawn entire");
  });

  it("leaves out a coin that trended in after the round opened", () => {
    // C11 was outside the field when the round opened. It is now inside the
    // visible ten, but it is not in this race and must not be drawn in it.
    oracle.seedForTest(AFTER_SHUFFLE);
    assert.ok(
      oracle.standings(BOARD_SIZE).some((s) => s.symbol === "C11"),
      "precondition: C11 is on the live board"
    );

    const drawn = symbolsIn(oracle.rankHistory(90, FIELD));

    assert.ok(!drawn.includes("C11"), `a newcomer must not appear: ${drawn.join(",")}`);
  });

  it("falls back to the live board when no round is open", () => {
    // Between rounds there is no field, and the board is all there is to draw.
    const drawn = symbolsIn(oracle.rankHistory(90));
    assert.deepEqual(drawn, oracle.standings(BOARD_SIZE).map((s) => s.symbol).sort());
  });

  it("reports a dropped coin's real rank, not a missing one", () => {
    // The line has to go somewhere. `recordCut` and the market both score a coin
    // that fell out of the board below the last visible slot, and the chart has
    // to agree with them or the picture contradicts the settlement.
    oracle.seedForTest(AFTER_SHUFFLE);

    const c3 = oracle.rankHistory(90, ["C3"]);
    assert.ok(c3.length > 0, "the dropped coin must still have points");
    assert.ok(
      c3.every((p) => p.rank > BOARD_SIZE),
      `and they must sit below the board: ${c3.map((p) => p.rank).join(",")}`
    );
  });
});
