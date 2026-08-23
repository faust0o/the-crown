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
  fairCents,
  marketLines,
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
 * These exercise the tape directly rather than through Apollo: the whole point
 * of the change is that one function decides a line's price, so the tests that
 * matter are the ones that can pin that number down without a round trip.
 */

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
/** The tail of the board, unchanged in every scenario below. */
const TAIL: [string, number][] = [
  ["C6", 328],
  ["C7", 262],
  ["C8", 210],
  ["C9", 168],
  ["C10", 134],
];

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

describe("fair value", () => {
  const gapBoard = (c5Volume: number) =>
    ladder([["C1", 1000], ["C2", 800], ["C3", 640], ["C4", 512], ["C5", c5Volume], ...TAIL]);

  it("prices a coin closing on its neighbour higher than one adrift", () => {
    const chasing = gapBoard(500); // 2% behind the coin above
    const adrift = gapBoard(330); // 55% behind

    const near = fairCents(chasing[4], chasing, "HIGHER", 5, 0.5);
    const far = fairCents(adrift[4], adrift, "HIGHER", 5, 0.5);

    assert.ok(
      near - far >= 10,
      `closing the gap should bid HIGHER up: adrift=${far}c chasing=${near}c`
    );
  });

  it("reprices when the coin actually changes rank", () => {
    const before = fairCents(TEN[4], TEN, "HIGHER", 5, 0.5); // sitting at its start rank
    // Same coin, now one place up: C5 opened 5th and stands 4th.
    const climbed = ladder([
      ["C1", 1000],
      ["C2", 800],
      ["C3", 640],
      ["C5", 600],
      ["C4", 512],
      ...TAIL,
    ]);
    const after = fairCents(climbed[3], climbed, "HIGHER", 5, 0.5);

    assert.ok(
      after - before >= 20,
      `an overtake must move the quote: ${before}c -> ${after}c`
    );
  });

  it("converges on the realised outcome as the cut approaches", () => {
    // C5 opened 5th and stands 3rd: HIGHER has already happened, and only the
    // time left can still take it away.
    const climbed = ladder([
      ["C1", 1000],
      ["C2", 800],
      ["C5", 700],
      ["C3", 640],
      ["C4", 512],
      ...TAIL,
    ]);
    const now = climbed[2];
    const quotes = [1, 0.5, 0.2, 0.05, 0.001].map((r) =>
      fairCents(now, climbed, "HIGHER", 5, r)
    );

    for (let i = 1; i < quotes.length; i++) {
      assert.ok(
        quotes[i] >= quotes[i - 1],
        `HIGHER must not cheapen as the cut nears: ${quotes.join(" -> ")}`
      );
    }
    assert.ok(
      quotes[0] <= CAP_CENTS - 10,
      `a whole round left is not a certainty: ${quotes[0]}c`
    );
    assert.equal(quotes[quotes.length - 1], CAP_CENTS, "at the cut the winner is the cap");

    for (const direction of ["DRAW", "LOWER"] as const) {
      assert.equal(
        fairCents(now, climbed, direction, 5, 0.001),
        FLOOR_CENTS,
        `${direction} lost; it must go to the floor`
      );
    }
  });

  it("prices the realised loser at the floor", () => {
    // C5 one place *below* where it opened: LOWER is what actually happened.
    const slipped = ladder([
      ["C1", 1000],
      ["C2", 800],
      ["C3", 640],
      ["C4", 512],
      ["C6", 410],
      ["C5", 380],
      ["C7", 262],
      ["C8", 210],
      ["C9", 168],
      ["C10", 134],
    ]);
    const now = slipped[5];
    assert.equal(fairCents(now, slipped, "LOWER", 5, 0.001), CAP_CENTS);
    assert.equal(fairCents(now, slipped, "HIGHER", 5, 0.001), FLOOR_CENTS);
  });
});

/** A fill: `credits` of buying pressure on one line, with the model's view. */
const buy = (
  symbol: string,
  direction: Direction,
  credits: number,
  model: Record<Direction, number> = { HIGHER: 33, DRAW: 33, LOWER: 34 },
  at = Date.now(),
  cents = fillCents(symbol, direction, credits) ?? 0
) =>
  recordFill(
    {
      id: `${symbol}-${direction}-${credits}-${at}`,
      at,
      bot: "Test Desk",
      symbol,
      ticker: symbol,
      imageUrl: null,
      direction,
      size: credits,
      cents,
    },
    model
  );

/** Ledger-only, for the depth window — no flow, so no price move. */
const print = (
  symbol: string,
  direction: Direction,
  cents: number,
  size = 5_000,
  at = Date.now()
) =>
  record({
    id: `${symbol}-${direction}-${cents}-${at}`,
    at,
    bot: "Test Desk",
    symbol,
    ticker: symbol,
    imageUrl: null,
    direction,
    size,
    cents,
  });

describe("one flow, three views", () => {
  it("quotes the board, the fill and the book off the same number", () => {
    const round = roundBook(TEN);
    openRound(round);
    buy("C5", "HIGHER", 40_000_000);

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

    // A clip is worth its share of the pool — no more, and no less either. Ten
    // thousand credits against an opening pool of three hundred thousand is a
    // couple of cents, and it is a couple of cents rather than nothing: there is
    // no threshold a trade has to clear before the book will admit it happened.
    buy("C5", "HIGHER", 10_000);
    const trickle = quoteCents("C5", "HIGHER")!.mark;
    assert.ok(trickle > opened, `every credit counts: ${opened}c -> ${trickle}c`);
    assert.ok(trickle - opened <= 3, `but only for its share: ${opened}c -> ${trickle}c`);

    // Ten times the pool, and the line is worth what the pool says: nearly all
    // of it. Nothing damps this and nothing needs to.
    buy("C5", "HIGHER", 3_000_000);
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

    buy("C5", "HIGHER", 250_000);
    assert.ok(quoteCents("C5", "HIGHER")!.mark > before[0], "precondition: the buy moved it");

    unwind("C5", "HIGHER", 250_000);
    assert.deepEqual(
      DIRECTIONS.map((d) => quoteCents("C5", d)!.mark),
      before,
      "closing must leave the book exactly where it found it"
    );
  });

  it("comes back down when the buying goes the other way", () => {
    // The reversibility the hedge depends on. The desks cannot sell; what brings
    // a mark back is somebody buying one of the outcomes competing with it.
    const round = roundBook(TEN);
    openRound(round);
    buy("C5", "HIGHER", 60_000_000);
    const high = quoteCents("C5", "HIGHER")!.mark;
    assert.ok(high > 60, `precondition: HIGHER ran up, got ${high}c`);

    buy("C5", "LOWER", 120_000_000);
    const back = quoteCents("C5", "HIGHER")!.mark;

    assert.ok(back < high - 20, `hedging into LOWER must bring HIGHER back: ${high}c -> ${back}c`);
    assert.ok(quoteCents("C5", "LOWER")!.mark > back, "and leave LOWER on top");
  });

  it("keeps every mark inside the bounds however hard a line is bought", () => {
    const round = roundBook(TEN);
    openRound(round);
    // Far more than a desk could ever spend, twice, to make sure nothing
    // overflows out the top of the exponent.
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
    for (const stake of [1_000, 50_000, 250_000, 500_000, 5_000_000]) {
      resetMarket();
      const round = roundBook(TEN);
      openRound(round);

      const ask = fillCents("C5", "HIGHER", stake)!;
      buy("C5", "HIGHER", stake, undefined, undefined, ask);
      const bid = closeCents("C5", "HIGHER", stake)!;
      const back = closeValue(stake, 100 / ask, bid);

      if (back >= stake) losses.push(`${stake} in -> ${back} out @ ${ask}c/${bid}c`);
    }
    assert.deepEqual(losses, [], `round trips that paid: ${losses.join(", ")}`);
  });

  it("charges a bigger clip a worse price, on the same book", () => {
    const round = roundBook(TEN);
    openRound(round);
    const small = fillCents("C5", "HIGHER", 1_000)!;
    const large = fillCents("C5", "HIGHER", 500_000)!;
    assert.ok(
      large > small + 10,
      `size must pay for the room it takes: ${small}c for 1k, ${large}c for 500k`
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
    for (const credits of [1_000_000, 9_000_000, 50_000_000]) {
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

    buy("C5", "HIGHER", 40_000_000);

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
    // exactly the outcome LOWER describes, and the model says so. Buying DRAW
    // must not therefore mark HIGHER up to the whole remainder.
    assert.equal(quoteCents("C10", "LOWER"), null);
    buy("C10", "DRAW", 30_000_000, { HIGHER: 2, DRAW: 4, LOWER: 94 });

    const higher = quoteCents("C10", "HIGHER")!.mark;
    const draw = quoteCents("C10", "DRAW")!.mark;
    assert.ok(higher <= 6, `a leg the model has written off stays written off, got ${higher}c`);
    // The mass that belongs to the outcome with no line is simply missing from
    // the book, rather than being shared out among the lines that do exist.
    assert.ok(
      higher + draw < 100,
      `the untradable outcome keeps its share: ${higher} + ${draw} = ${higher + draw}`
    );
  });
});

describe("depth", () => {
  it("counts the whole window even when the tape has evicted most of it", () => {
    const round = roundBook(TEN);
    openRound(round);

    // Ten minutes of the desks' per-second trading: 18,000 prints against a tape
    // that keeps a few thousand. Counting depth by rescanning the tape reported
    // whatever survived — about a third of the six-minute window — and said
    // nothing about the rest.
    const now = Date.now();
    const CLIP = 10_000;
    const seeded = book("C5").find((l) => l.direction === "HIGHER")!.size;
    for (let second = 600; second >= 1; second--) {
      for (const entry of round.entries) {
        for (const direction of ["HIGHER", "DRAW", "LOWER"] as Direction[]) {
          print(entry.symbol, direction, 50, CLIP, now - second * 1_000);
        }
      }
    }

    const level = book("C5").find((l) => l.direction === "HIGHER")!;
    // 360 one-second buckets, give or take the bucket the clock rolls into
    // mid-test, on top of what the opening auction staked.
    assert.ok(
      level.size >= 358 * CLIP && level.size <= 361 * CLIP + seeded,
      `a six-minute window at one print a second holds ~360 clips, got ${(level.size - seeded) / CLIP}`
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
