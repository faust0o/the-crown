import { strict as assert } from "node:assert";
import { beforeEach, describe, it } from "node:test";
import {
  CAP_CENTS,
  DIRECTIONS,
  FLOOR_CENTS,
  SPREAD_CENTS,
  book,
  closeBook,
  closeCents,
  closeValue,
  fillCents,
  marketLines,
  OPENING_POOL,
  openRound,
  quoteCents,
  record,
  recordFill,
  resetMarket,
  unwind,
  type Direction,
  type RoundBook,
} from "./market";
import type { Standing } from "./oracle/index";

/**
 * These exercise the book directly rather than through Apollo: the whole point
 * of the design is that one function decides a line's price, so the tests that
 * matter are the ones that can pin that number down without a round trip.
 *
 * Sizes are written as multiples of `OPENING_POOL` rather than as literals. What
 * a clip does to a mark is entirely a question of its size *relative to the
 * pool*, so a test that hard-codes credits is really asserting the tunable — and
 * silently stops testing what it says it tests the moment somebody moves it.
 * Which is exactly what happened when the desks were removed and the pool went
 * from 300,000 to 2,000.
 */
/** Credits, as a multiple of what the opening auction stakes on one coin. */
const pools = (n: number) => Math.round(OPENING_POOL * n);

function standing(symbol: string, rank: number, quoteVolume: number): Standing {
  return {
    symbol,
    ticker: symbol,
    name: symbol,
    imageUrl: null,
    rank,
    previousRank: null,
    quoteVolume,
    price: 1,
    trades1h: 0,
    wallets1h: 0,
    priceChange1hPercent: 0,
  };
}

/** `[symbol, volume]` in board order, rank 1 the busiest. */
function ladder(rows: [string, number][]): Standing[] {
  return rows.map(([symbol, volume], i) => standing(symbol, i + 1, volume));
}

const TEN = ladder([
  ["C1", 1000],
  ["C2", 800],
  ["C3", 640],
  ["C4", 512],
  ["C5", 410],
  ["C6", 328],
  ["C7", 262],
  ["C8", 210],
  ["C9", 168],
  ["C10", 134],
]);
function roundBook(
  board: Standing[],
  { id = "r1", crownSymbol = null as string | null, remaining = 0.5 } = {}
): RoundBook {
  const total = 30 * 60_000;
  const now = Date.now();
  return {
    id,
    startsAt: new Date(now - total * (1 - remaining)),
    endsAt: new Date(now + total * remaining),
    crownSymbol,
    entries: board.map((s) => ({ symbol: s.symbol, ticker: s.ticker, startRank: s.rank })),
  };
}

beforeEach(() => resetMarket());

describe("opening prints", () => {
  it("gives every tradable line a price the moment the round opens", () => {
    const round = roundBook(TEN);
    openRound(round);

    for (const entry of round.entries) {
      for (const line of marketLines(round, entry.symbol)) {
        // Rank 1 cannot finish HIGHER and last place cannot finish LOWER; those
        // legs never open. Everything else must be quoted with no fallback.
        const structural =
          (entry.startRank === 1 && line.direction === "HIGHER") ||
          (entry.startRank === round.entries.length && line.direction === "LOWER");
        assert.equal(line.available, !structural, `${entry.symbol} ${line.direction}`);
        if (!structural) {
          assert.ok(line.cents >= FLOOR_CENTS && line.cents <= CAP_CENTS, `${line.cents}`);
          assert.ok(line.multiplier > 1);
        }
      }
    }
  });

  it("keeps the crown off the book entirely", () => {
    const round = roundBook(TEN, { crownSymbol: "C3" });
    openRound(round);

    assert.deepEqual(
      marketLines(round, "C3").map((l) => [l.available, l.cents]),
      [
        [false, 0],
        [false, 0],
        [false, 0],
      ]
    );
    assert.equal(quoteCents("C3", "HIGHER"), null);
    assert.ok(marketLines(round, "C4").every((l) => l.available));
  });

  it("wipes the book when a new round opens", () => {
    const first = roundBook(TEN, { id: "r1" });
    openRound(first);
    const before = quoteCents("C5", "HIGHER");
    assert.ok(before);

    openRound(roundBook(TEN, { id: "r2" }));
    // The settled round is no longer quoted — its lines resolved, and its start
    // ranks are not the ones the live prices refer to.
    assert.ok(marketLines(first, "C5").every((l) => !l.available));
  });
});

/** A fill: `credits` of buying pressure on one line. */
const buy = (symbol: string, direction: Direction, credits: number, at = Date.now()) =>
  recordFill({ at, symbol, direction, size: credits });

/** Depth-window only — no flow, so no price move. */
const print = (symbol: string, direction: Direction, size = 5_000, at = Date.now()) =>
  record({ at, symbol, direction, size });

describe("one flow, three views", () => {
  it("quotes the board, the fill and the book off the same number", () => {
    const round = roundBook(TEN);
    openRound(round);
    buy("C5", "HIGHER", pools(100));

    const line = marketLines(round, "C5").find((l) => l.direction === "HIGHER")!;
    const level = book("C5").find((l) => l.direction === "HIGHER")!;
    const quote = quoteCents("C5", "HIGHER")!;

    assert.equal(line.cents, quote.ask, "the board shows the ask");
    assert.equal(level.cents, quote.ask, "the book shows the same ask");
    // `placeBet` stores `line.multiplier` as the bet's odds, so this is
    // literally the number a stake fills at.
    assert.equal(Math.round(100 / line.multiplier), quote.ask, "a bet fills at the ask");
  });

  it("moves the price by what the money says, and by nothing else", () => {
    const round = roundBook(TEN);
    openRound(round);
    const opened = quoteCents("C5", "HIGHER")!.mark;

    // A clip is worth its share of the pool — no more, and no less either. A
    // thirtieth of the pool is a couple of cents, and it is a couple of cents
    // rather than nothing: there is no threshold a trade has to clear before the
    // book will admit it happened.
    buy("C5", "HIGHER", pools(1 / 30));
    const trickle = quoteCents("C5", "HIGHER")!.mark;
    assert.ok(trickle > opened, `every credit counts: ${opened}c -> ${trickle}c`);
    assert.ok(trickle - opened <= 3, `but only for its share: ${opened}c -> ${trickle}c`);

    // Ten times the pool, and the line is worth what the pool says: nearly all
    // of it. Nothing damps this and nothing needs to.
    buy("C5", "HIGHER", pools(10));
    const pushed = quoteCents("C5", "HIGHER")!.mark;
    assert.ok(pushed > trickle + 40, `real size must move it: ${trickle}c -> ${pushed}c`);
  });

  it("takes a position back out of the pool when it is closed", () => {
    // Buying moves a mark up, so closing has to move it back down by the same
    // amount — otherwise a big enough position bids up its own line and sells
    // into the bid it just made.
    const round = roundBook(TEN);
    openRound(round);
    const before = DIRECTIONS.map((d) => quoteCents("C5", d)!.mark);

    buy("C5", "HIGHER", pools(1));
    assert.ok(quoteCents("C5", "HIGHER")!.mark > before[0], "precondition: the buy moved it");

    unwind("C5", "HIGHER", pools(1));
    assert.deepEqual(
      DIRECTIONS.map((d) => quoteCents("C5", d)!.mark),
      before,
      "closing must leave the book exactly where it found it"
    );
  });

  it("comes back down when the buying goes the other way", () => {
    // The reversibility the whole design depends on. Nobody can sell short; what
    // brings a mark back is somebody buying an outcome competing with it.
    const round = roundBook(TEN);
    openRound(round);
    buy("C5", "HIGHER", pools(150));
    const high = quoteCents("C5", "HIGHER")!.mark;
    assert.ok(high > 60, `precondition: HIGHER ran up, got ${high}c`);

    buy("C5", "LOWER", pools(300));
    const back = quoteCents("C5", "HIGHER")!.mark;

    assert.ok(back < high - 20, `hedging into LOWER must bring HIGHER back: ${high}c -> ${back}c`);
    assert.ok(quoteCents("C5", "LOWER")!.mark > back, "and leave LOWER on top");
  });

  it("keeps every mark inside the bounds however hard a line is bought", () => {
    const round = roundBook(TEN);
    openRound(round);
    // Far more than anyone could ever hold, twice, to make sure nothing overflows
    // out the top of the arithmetic.
    buy("C5", "HIGHER", 5_000_000_000);
    buy("C5", "HIGHER", 5_000_000_000);

    for (const direction of ["HIGHER", "DRAW", "LOWER"] as Direction[]) {
      const mark = quoteCents("C5", direction)!.mark;
      assert.ok(
        mark >= FLOOR_CENTS && mark <= CAP_CENTS,
        `${direction} left the bounds at ${mark}c`
      );
    }
    // Two legs pinned at the floor is what caps the third below CAP_CENTS.
    assert.equal(quoteCents("C5", "HIGHER")!.mark, 100 - 2 * FLOOR_CENTS);
  });

  it("never lets a trade profit from the price it moved itself", () => {
    // The exploit this closed: a bet filled at the mark it *arrived* at, and
    // then its own credits pushed that mark up. Buy 500,000, close immediately,
    // keep the difference. It has to lose at every size, and the bigger the
    // clip the more it loses, because size pays for the room it takes.
    const losses: string[] = [];
    for (const stake of [1, 10, pools(0.1), pools(1), pools(20)]) {
      resetMarket();
      const round = roundBook(TEN);
      openRound(round);

      const ask = fillCents("C5", "HIGHER", stake)!;
      buy("C5", "HIGHER", stake);
      const bid = closeCents("C5", "HIGHER", stake)!;
      const back = closeValue(stake, 100 / ask, bid);

      if (back >= stake) losses.push(`${stake} in -> ${back} out @ ${ask}c/${bid}c`);
    }
    assert.deepEqual(losses, [], `round trips that paid: ${losses.join(", ")}`);
  });

  it("charges a bigger clip a worse price, on the same book", () => {
    const round = roundBook(TEN);
    openRound(round);
    const small = fillCents("C5", "HIGHER", 1)!;
    const large = fillCents("C5", "HIGHER", pools(2))!;
    assert.ok(
      large > small + 10,
      `size must pay for the room it takes: ${small}c for 1, ${large}c for ${pools(2)}`
    );
  });

  it("never lets a round trip be free at any price or size", () => {
    // Rounding to nearest used to hand the spread back whenever it was worth
    // under half a credit. Re-run over the widened bounds, because a 1c floor
    // makes the spread a much larger fraction of the ask than a 2c one did.
    const free: string[] = [];
    for (let mark = FLOOR_CENTS; mark <= CAP_CENTS; mark++) {
      const ask = Math.min(CAP_CENTS, mark + SPREAD_CENTS);
      const bid = Math.max(FLOOR_CENTS, mark - SPREAD_CENTS);
      for (let stake = 1; stake <= 500; stake++) {
        if (closeValue(stake, 100 / ask, bid) >= stake) free.push(`${stake}@${mark}c`);
      }
    }
    assert.deepEqual(free, [], `round trips that cost nothing: ${free.length}`);
  });
});

describe("a fill sets the whole book on its asset", () => {
  it("keeps the three outcomes summing to a hundred", () => {
    const round = roundBook(TEN);
    openRound(round);
    for (const credits of [pools(3), pools(30), pools(150)]) {
      buy("C5", "HIGHER", credits);
      const marks = (["HIGHER", "DRAW", "LOWER"] as Direction[]).map(
        (d) => quoteCents("C5", d)!.mark
      );
      assert.equal(
        marks.reduce((sum, m) => sum + m, 0),
        100,
        `the outcomes are exhaustive, so the book must be too: ${marks.join(" + ")}`
      );
    }
  });

  it("moves a leg that never trades", () => {
    const round = roundBook(TEN);
    openRound(round);
    const before = quoteCents("C5", "LOWER")!.mark;
    const seeded = book("C5").find((l) => l.direction === "LOWER")!.size;

    buy("C5", "HIGHER", pools(100));

    assert.ok(
      quoteCents("C5", "LOWER")!.mark < before,
      `nobody touched LOWER and it must still have moved: ${before}c -> ${quoteCents("C5", "LOWER")!.mark}c`
    );
    assert.equal(
      book("C5").find((l) => l.direction === "LOWER")!.size,
      seeded,
      "…but nothing traded on it, so all that stands behind it is the auction"
    );
    assert.ok(seeded > 0, "which is a real stake, not a placeholder");
  });

  it("does not hand a closed leg's share to the one line left", () => {
    const round = roundBook(TEN);
    openRound(round);

    // C10 opened last, so its LOWER never opens — but falling off the board is
    // exactly the outcome LOWER describes, and the prior the auction was staked
    // from says what it is worth. Buying DRAW must not therefore mark HIGHER up
    // to the whole remainder.
    //
    // This is the one thing the model still decides, and with the desks gone
    // `openRound` is the only place it can be decided: nothing else in a round
    // ever computes what an outcome nobody can bet on is worth.
    assert.equal(quoteCents("C10", "LOWER"), null);
    buy("C10", "DRAW", pools(100));

    const higher = quoteCents("C10", "HIGHER")!.mark;
    const draw = quoteCents("C10", "DRAW")!.mark;
    // The mass that belongs to the outcome with no line is simply missing from
    // the book, rather than being shared out among the lines that do exist.
    assert.ok(
      higher + draw < 100,
      `the untradable outcome keeps its share: ${higher} + ${draw} = ${higher + draw}`
    );
    assert.ok(
      100 - (higher + draw) >= 15,
      `and it is a real share of the hundred, not a rounding crumb: ${100 - (higher + draw)}c`
    );
  });
});

describe("depth", () => {
  it("counts the whole window, and only the window", () => {
    const round = roundBook(TEN);
    openRound(round);

    // One print a minute for two hours: four times the window, so most of these
    // must be gone by the time it is read. Counting depth by walking a list of
    // past fills reported whatever the list happened to still be holding, which
    // is a different number and one that nothing said out loud.
    const now = Date.now();
    const CLIP = 100;
    const WINDOW_MINUTES = 30;
    const seeded = book("C5").find((l) => l.direction === "HIGHER")!.size;
    for (let minute = 120; minute >= 1; minute--) {
      for (const entry of round.entries) {
        for (const direction of DIRECTIONS) {
          print(entry.symbol, direction, CLIP, now - minute * 60_000);
        }
      }
    }

    const level = book("C5").find((l) => l.direction === "HIGHER")!;
    const traded = level.size - seeded;
    // Thirty minutes of prints, give or take the bucket the clock rolls into
    // mid-test, on top of what the opening auction staked.
    assert.ok(
      traded >= (WINDOW_MINUTES - 1) * CLIP && traded <= WINDOW_MINUTES * CLIP,
      `a ${WINDOW_MINUTES}-minute window at one print a minute holds ~${WINDOW_MINUTES} clips, got ${traded / CLIP}`
    );
  });
});

describe("the book closes with the round", () => {
  it("stops quoting once no round is live", () => {
    const round = roundBook(TEN);
    openRound(round);
    assert.ok(quoteCents("C5", "HIGHER"), "the precondition is that it was quoting");

    // What the round loop does when `currentRound()` comes back empty.
    closeBook();

    assert.equal(quoteCents("C5", "HIGHER"), null, "a resolved round has no bid");
    assert.ok(
      marketLines(round, "C5").every((l) => !l.available && l.cents === 0),
      "the results panel must not offer a bet on a round that is over"
    );
    assert.ok(book("C5").every((l) => l.cents === 0), "nor may the depth panel price it");
  });

  it("stops quoting the moment the round it is on ends", async () => {
    // Not everything that reads a price goes through the round loop first, so
    // the market has to notice this itself rather than wait to be told.
    const round = { ...roundBook(TEN, { id: "ending" }), endsAt: new Date(Date.now() + 40) };
    openRound(round);
    assert.ok(quoteCents("C5", "HIGHER"));

    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.ok(Date.now() > round.endsAt.getTime(), "the round under test must have ended");
    assert.equal(quoteCents("C5", "HIGHER"), null);
    assert.ok(marketLines(round, "C5").every((l) => !l.available));
  });

  it("opens the next round's book on a market that was closed", () => {
    openRound(roundBook(TEN, { id: "r1" }));
    closeBook();

    const next = roundBook(TEN, { id: "r2" });
    openRound(next);
    assert.ok(marketLines(next, "C5").every((l) => l.available));
  });
});
