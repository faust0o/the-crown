import { strict as assert } from "node:assert";
import { beforeEach, describe, it } from "node:test";
import { BOARD_SIZE, POOL, oracle } from "./oracle/index";

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

beforeEach(() => {
  // Nothing is owed a trail until a round says so, and the oracle is a
  // singleton — a field left tracked by one case would follow the next one.
  oracle.track([]);
  oracle.seedForTest(AT_OPEN);
});

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

/**
 * A round is a promise to follow ten named coins until it ends.
 *
 * Relegation is the outcome the round is scored on, not a reason to stop
 * measuring: a coin can be pushed off the board, and then out of the ranking
 * pool altogether, while trading the whole time. Every list the oracle kept
 * ended at one of those two steps, so the coin's numbers came back as zero —
 * a live market reported as a dead one, for exactly the coins a player is
 * watching hardest.
 */
describe("the round's field is measured to the end", () => {
  /** Busiest first, with enough room above zero for a universe this deep. */
  const deep = (order: string[]) =>
    order.map((symbol, i) => ({ symbol, volume: 10_000 - i * 100 }));

  /** A universe deeper than the pool, so the last coins in it are unranked. */
  const DEEP = deep(Array.from({ length: POOL + 6 }, (_, i) => `D${i + 1}`));
  /** The field opened on the board; D2 has since collapsed to the very bottom. */
  const RELEGATED = "D2";
  const AFTER_COLLAPSE = deep([
    ...DEEP.map((c) => c.symbol).filter((s) => s !== RELEGATED),
    RELEGATED,
  ]);
  const FIELD_OF = DEEP.slice(0, BOARD_SIZE).map((c) => c.symbol);

  beforeEach(() => {
    oracle.track(FIELD_OF);
    oracle.seedForTest(AFTER_COLLAPSE);
  });

  it("still holds its numbers once it is past the pool", () => {
    assert.ok(
      !oracle.standings(POOL).some((s) => s.symbol === RELEGATED),
      "precondition: it has fallen out of the ranking pool, not just the board"
    );

    const token = oracle.tokenFor(RELEGATED);
    assert.ok(token, "a coin nobody ranks is still a coin somebody bet on");
    assert.ok(token!.volume > 0, `and it is still trading: ${token!.volume}`);
  });

  it("keeps recording it, at the rank it actually holds", () => {
    const points = oracle.rankHistory(90, [RELEGATED]);
    assert.ok(points.length > 0, "its trail must not end where the pool does");
    assert.ok(
      points.every((p) => p.rank > POOL),
      `and it stands where it stands: ${points.map((p) => p.rank).join(",")}`
    );
    assert.ok(
      points.every((p) => p.quoteVolume > 0),
      "with the volume that is the reason it fell, which is what says whether it is coming back"
    );
  });

  it("keeps ranking a field coin that stops qualifying to race", () => {
    // Not every coin that leaves the eligible set was relegated. Eligibility is
    // checked on every poll, and a coin can fail it — a liquidity reading of $5,
    // or $240k, against a floor of $250k, on a coin turning over millions an
    // hour — while trading throughout. That is not an outcome, so it must not
    // decide one: the coin stays on the board where its volume puts it, which is
    // also where the cut will score it.
    const [busiest, ...rest] = AFTER_COLLAPSE;
    oracle.track(FIELD_OF);
    oracle.seedForTest([{ ...busiest, racing: false }, ...rest]);

    const standing = oracle.standings(BOARD_SIZE).find((s) => s.symbol === busiest.symbol);
    assert.equal(standing?.rank, 1, "the busiest coin on the market leads the board");
    assert.equal(standing?.quoteVolume, busiest.volume);

    const points = oracle.rankHistory(90, [busiest.symbol]);
    assert.ok(points.length > 0, "its trail must not end where its eligibility does");
    assert.ok(
      points.every((p) => p.quoteVolume === busiest.volume && p.rank === 1),
      `and it is drawn where it stands: ${points.map((p) => `${p.rank}@${p.quoteVolume}`).join(",")}`
    );
  });

  it("still keeps an ineligible coin out of a field it is not in", () => {
    // The exemption is the field's, not the coin's. Between rounds, or for a coin
    // the round never named, the floor applies as it always has — that is what
    // stops a thin book being raced in the first place.
    const [busiest, ...rest] = AFTER_COLLAPSE;
    oracle.track(FIELD_OF.filter((s) => s !== busiest.symbol));
    oracle.seedForTest([{ ...busiest, racing: false }, ...rest]);
    assert.ok(!oracle.standings(POOL).some((s) => s.symbol === busiest.symbol));
  });

  it("drops the exemption the moment the field is released", () => {
    // `currentRound` releases the field before it snapshots the next one, and
    // that snapshot is read straight after — not at the next poll.
    const [busiest, ...rest] = AFTER_COLLAPSE;
    oracle.track(FIELD_OF);
    oracle.seedForTest([{ ...busiest, racing: false }, ...rest]);
    assert.equal(oracle.standings(BOARD_SIZE)[0].symbol, busiest.symbol, "precondition");

    oracle.track([]);
    assert.ok(
      !oracle.standings(POOL).some((s) => s.symbol === busiest.symbol),
      "a new round's field is chosen on eligibility alone"
    );
  });

  it("measures nothing extra once the round is over", () => {
    // The field is the live round's, and between rounds there isn't one. A coin
    // below the pool is then just a coin below the pool.
    oracle.track([]);
    oracle.seedForTest(AFTER_COLLAPSE);
    assert.deepEqual(oracle.rankHistory(90, [RELEGATED]), []);
  });
});
