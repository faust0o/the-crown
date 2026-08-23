import { strict as assert } from "node:assert";
import { after, beforeEach, describe, it } from "node:test";
import {
  botsTicking,
  deskIntent,
  ramp,
  resetBots,
  setDeskAccounts,
  simulateArrival,
  startBots,
  stopBots,
  urgencyOf,
} from "./bots";
import {
  CAP_CENTS,
  DIRECTIONS,
  FLOOR_CENTS,
  fairCents,
  openRound,
  quoteCents,
  type RoundBook,
} from "./market";
import type { Standing } from "./oracle/index";
import { prisma } from "./prisma";

/**
 * The desks are driven through `simulateArrival`, which makes the same decision
 * and applies the same price impact as a live arrival without the `CryptoBet`
 * row. A round is nearly two thousand arrivals and every question worth asking
 * here — where does the price end up, does it run away early, how far does it
 * stray from the model — needs all of them. That the real path writes real bets
 * and debits real credits is `bets.test.ts`, against Postgres.
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

const ladder = (rows: [string, number][]): Standing[] =>
  rows.map(([symbol, volume], i) => standing(symbol, i + 1, volume));

const OPEN = ladder([
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

/** C5 overtakes C4 — the only thing that changes. */
const AFTER_OVERTAKE = ladder([
  ["C1", 1000],
  ["C2", 800],
  ["C3", 640],
  ["C5", 600],
  ["C4", 512],
  ["C6", 328],
  ["C7", 262],
  ["C8", 210],
  ["C9", 168],
  ["C10", 134],
]);

/** C5 slips a place — LOWER is what the model backs here. */
const AFTER_SLIP = ladder([
  ["C1", 1000],
  ["C2", 800],
  ["C3", 640],
  ["C4", 512],
  ["C6", 328],
  ["C5", 300],
  ["C7", 262],
  ["C8", 210],
  ["C9", 168],
  ["C10", 134],
]);

const MINUTES = 30;
const MS = MINUTES * 60_000;
/** Betting closes a minute before the end, which is the desks' real deadline. */
const LOCK_MS = MS - 60_000;
const C5 = AFTER_OVERTAKE.find((s) => s.symbol === "C5")!;

/** A round starting now, so the market will make a book on it. */
function roundBook(crownSymbol: string | null = null, id = "round-under-test"): RoundBook {
  const now = Date.now();
  return {
    id,
    startsAt: new Date(now),
    endsAt: new Date(now + MS),
    lockAt: new Date(now + LOCK_MS),
    crownSymbol,
    entries: OPEN.map((s) => ({ symbol: s.symbol, ticker: s.ticker, startRank: s.rank })),
  };
}

/**
 * Run the desks from `fromMs` to `toMs` into the round on the given board, at
 * the rate they actually run: all eight of them, every tick.
 *
 * `symbol` pins every desk to one coin — the shape a test uses when it wants to
 * say something about one line. Left out, each desk picks an asset the way the
 * live loop does, so the flow is spread across the board and a single coin sees
 * roughly a tenth of it.
 */
function run(
  round: RoundBook,
  board: Standing[],
  fromMs: number,
  toMs: number,
  stepMs = 1_000,
  symbol?: string
): number {
  const t0 = round.startsAt.getTime();
  let spent = 0;
  let pick = 0;
  for (let at = t0 + fromMs; at < t0 + toMs; at += stepMs) {
    for (let desk = 0; desk < 8; desk++) {
      const on =
        symbol ?? round.entries[Math.floor(rand(pick++) * round.entries.length)].symbol;
      const fill = simulateArrival(desk, { symbol: on, standings: board, round, now: at });
      if (fill) spent += fill.size;
    }
  }
  return spent;
}

/** Deterministic asset choice for the tests, so a run is reproducible. */
function rand(n: number): number {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

beforeEach(() => {
  resetBots();
  setDeskAccounts();
});
after(() => prisma.$disconnect());

describe("the ramp takes both gates", () => {
  it("stays moderate unless the signal has held *and* the round is nearly over", () => {
    const fresh = ramp(0.02, 0.95); // brand-new signal, two minutes left
    const early = ramp(0.9, 0.1); // long-held signal, still early
    const ripe = ramp(0.9, 0.95); // held all round, about to expire

    assert.ok(fresh < 1.3, `a fresh signal trades moderately however late: ${fresh.toFixed(2)}x`);
    assert.ok(early < 3, `a held signal early is still early: ${early.toFixed(2)}x`);
    // The book damps nothing now, so the ramp no longer has to supply a
    // thousandfold to carry a line — it only has to make the end of a round
    // count for far more than the start, which is what buys a player the window.
    assert.ok(ripe > 40, `both gates open is where the size is: ${ripe.toFixed(0)}x`);
    assert.ok(ripe / early > 20, `and the two ends of a round are not comparable`);
  });

  it("measures urgency against the close of betting, not the end of the round", () => {
    const round = roundBook();
    const t0 = round.startsAt.getTime();
    // A desk cannot trade after `lockAt`, so that is when its clock runs out.
    assert.ok(Math.abs(urgencyOf(round, t0 + LOCK_MS) - 1) < 1e-9, "spent at the lock");
    assert.ok(urgencyOf(round, t0) < 0.01, "and nothing at the open");
  });
});

describe("price is the pool", () => {
  it("has barely moved a minute into the round", () => {
    const round = roundBook();
    openRound(round);
    const opened = quoteCents("C5", "HIGHER")!.mark;

    run(round, AFTER_OVERTAKE, 0, 60_000);

    // Not frozen — every credit moves the pool, and pretending otherwise was the
    // damping constant this design got rid of. What buys a player the early
    // window is that the desks are barely trading yet, so a minute of it is
    // worth a cent or two rather than the twenty the signal is really worth.
    const after = quoteCents("C5", "HIGHER")!.mark;
    assert.ok(
      after - opened <= 5,
      `a minute of buying must not price the signal: ${opened}c -> ${after}c`
    );
  });

  it("tracks the signal upward through the round rather than gapping at the end", () => {
    const round = roundBook();
    openRound(round);
    const path = [quoteCents("C5", "HIGHER")!.mark];
    for (let at = 0; at < LOCK_MS; at += LOCK_MS / 6) {
      run(round, AFTER_OVERTAKE, at, at + LOCK_MS / 6);
      path.push(quoteCents("C5", "HIGHER")!.mark);
    }

    // The bug this replaced: the mark sat on its opening print for two thirds of
    // the round and then jumped fifty cents in the last three minutes. Every
    // sixth of the round must now carry some of the move, and no single one of
    // them may carry most of it.
    const moves = path.slice(1).map((m, i) => m - path[i]);
    const total = path[path.length - 1] - path[0];
    assert.ok(total > 25, `the signal must be priced by the close: ${path.join(" -> ")}`);
    assert.ok(
      moves.every((m) => m >= 0),
      `and priced monotonically while it holds: ${path.join(" -> ")}`
    );
    assert.ok(
      Math.max(...moves) < total * 0.6,
      `no single stretch may carry the whole move: ${path.join(" -> ")}`
    );
  });

  it("is still nowhere near the bound at the halfway mark", () => {
    const round = roundBook();
    run(round, AFTER_OVERTAKE, 0, MS / 2);

    const mark = quoteCents("C5", "HIGHER")!.mark;
    assert.ok(
      mark < CAP_CENTS - 30,
      `half a round of accumulation must leave room to trade: ${mark}c`
    );
  });

  it("carries the signal to the outcome by the time betting closes", () => {
    const round = roundBook();
    run(round, AFTER_OVERTAKE, 0, LOCK_MS);

    const mark = quoteCents("C5", "HIGHER")!.mark;
    // Not pinned at the bound any more, and it should not be: the desks stop
    // buying a leg once the mark reaches what they think it is worth, so where
    // this lands is the model's own confidence with a minute of round left.
    assert.ok(
      mark > 80,
      `a signal held all round must end up priced as the outcome: ${mark}c`
    );
    assert.ok(mark <= CAP_CENTS, `and inside the bounds: ${mark}c`);
  });

  it("leaves a player who read the move ahead of the desks all the way", () => {
    // The whole point of the ramp. A player buying the moment the coin overtakes
    // gets a price the desks spend the rest of the round walking up to.
    const round = roundBook();
    openRound(round);
    run(round, AFTER_OVERTAKE, 0, 2 * 60_000);
    const boughtAt = quoteCents("C5", "HIGHER")!.ask;

    run(round, AFTER_OVERTAKE, 2 * 60_000, LOCK_MS);
    const soldAt = quoteCents("C5", "HIGHER")!.bid;

    assert.ok(
      soldAt > boughtAt + 30,
      `reading it two minutes in must pay: bought ${boughtAt}c, closed ${soldAt}c`
    );
  });

  it("leaves a late signal short, which is what makes catching one early worth it", () => {
    const round = roundBook();
    run(round, AFTER_SLIP, 0, LOCK_MS - 5 * 60_000);
    const before = quoteCents("C5", "HIGHER")!.mark;
    run(round, AFTER_OVERTAKE, LOCK_MS - 5 * 60_000, LOCK_MS);

    const mark = quoteCents("C5", "HIGHER")!.mark;
    assert.ok(mark > before, `the late move must still be picked up: ${before}c -> ${mark}c`);
    assert.ok(
      mark < 100 - 2 * FLOOR_CENTS,
      `but five minutes of signal is not a round of it: ${mark}c`
    );
  });
});

describe("a desk caught offside hedges", () => {
  /** Fills for one desk on one asset, in order. */
  function fills(round: RoundBook, board: Standing[], fromMs: number, toMs: number) {
    const t0 = round.startsAt.getTime();
    const out: { direction: string; stake: number }[] = [];
    for (let at = t0 + fromMs; at < t0 + toMs; at += 3_000) {
      const fill = simulateArrival(0, { symbol: "C5", standings: board, round, now: at });
      if (fill) out.push({ direction: fill.direction, stake: fill.size });
    }
    return out;
  }

  /** Credits this desk put on each leg. */
  const byLeg = (rows: { direction: string; stake: number }[]) =>
    rows.reduce<Record<string, number>>(
      (acc, f) => ({ ...acc, [f.direction]: (acc[f.direction] ?? 0) + f.stake }),
      {}
    );

  it("keeps what it holds and buys the other side", () => {
    const round = roundBook();
    // C5 has slipped: the desk's view is LOWER and it builds a position there.
    // Not *every* fill — it buys whichever leg the book is asking least for, so
    // it takes the odd cheap DRAW along the way — but that is where its money is.
    const backing = byLeg(fills(round, AFTER_SLIP, 0, 18 * 60_000));
    const held = backing.LOWER ?? 0;
    assert.ok(
      held > (backing.HIGHER ?? 0) + (backing.DRAW ?? 0),
      `it was net long LOWER: ${JSON.stringify(backing)}`
    );

    // Then C5 overtakes instead. It cannot sell what it holds, so it buys the
    // leg that is now winning — and sizes that against the exposure, not against
    // a ramp whose clock has just been reset to nothing.
    const hedging = fills(round, AFTER_OVERTAKE, 18 * 60_000, 21 * 60_000);
    assert.ok(hedging.length > 0, "it kept trading");
    const into = byLeg(hedging);
    assert.ok(
      (into.HIGHER ?? 0) > (into.LOWER ?? 0),
      `it turned to HIGHER: ${JSON.stringify(into)}`
    );

    // The first clip after the turn answers the position rather than the ramp.
    const first = hedging.find((f) => f.direction === "HIGHER")!;
    assert.ok(
      first.stake > 0.05 * held,
      `the first hedge answers the position: held ${held}, hedged ${first.stake}`
    );
    // …and the hedge shrinks as it fills out, because it is what the desk is
    // *net* short, not a mood.
    const last = [...hedging].reverse().find((f) => f.direction === "HIGHER")!;
    assert.ok(
      last.stake < first.stake,
      `the hedge fades as it gets square: ${first.stake} -> ${last.stake}`
    );
  });

  it("brings the mark back with the hedge flow", () => {
    const round = roundBook();
    run(round, AFTER_SLIP, 0, 18 * 60_000, 3_000, "C5");
    const backed = quoteCents("C5", "LOWER")!.mark;
    assert.ok(backed > 55, `precondition: LOWER ran up, got ${backed}c`);

    run(round, AFTER_OVERTAKE, 18 * 60_000, LOCK_MS, 3_000, "C5");

    const now = quoteCents("C5", "LOWER")!.mark;
    assert.ok(now < backed - 20, `hedging must pull the old leg back: ${backed}c -> ${now}c`);
    assert.ok(
      quoteCents("C5", "HIGHER")!.mark > now,
      "and leave the leg it hedged into on top"
    );
    assert.equal(
      DIRECTIONS.reduce((sum, d) => sum + quoteCents("C5", d)!.mark, 0),
      100,
      "and the book still adds up"
    );
  });
});

describe("a desk is bounded by its bankroll", () => {
  const intentAt = (credits: number) =>
    deskIntent({
      deskId: 0,
      entry: roundBook().entries[4],
      standing: C5,
      board: AFTER_OVERTAKE,
      remaining: 0.02,
      urgency: 0.98,
      windowMs: LOCK_MS,
      credits,
      now: Date.now(),
    });

  it("never asks for more than it has, at the ripest moment of the round", () => {
    openRound(roundBook());
    for (const credits of [100_000_000, 1_000_000, 10_000, 100, 5, 1]) {
      const intent = intentAt(credits);
      if (!intent) continue;
      assert.ok(
        intent.stake <= credits,
        `${credits} credits must not fund a ${intent.stake} clip`
      );
      assert.ok(Number.isInteger(intent.stake) && intent.stake >= 1, "and stakes are whole");
    }
  });

  it("simply stops trading when it is broke", () => {
    openRound(roundBook());
    assert.equal(intentAt(0), null, "a broke desk has no intent, and does not throw");
    setDeskAccounts(0);
    assert.equal(
      simulateArrival(0, { symbol: "C5", standings: AFTER_OVERTAKE, round: roundBook() }),
      null
    );
  });

  it("scales down as it loses, with no special case for it", () => {
    // A clip is sized by the mispricing it is correcting, not by the bankroll,
    // so two desks looking at the same wrong price want the same credits. What
    // the bankroll decides is how much of that a desk may risk on one coin —
    // which over a whole round is what separates a rich desk from a poor one.
    const committed = (credits: number) => {
      resetBots();
      setDeskAccounts(credits);
      const round = roundBook();
      return run(round, AFTER_OVERTAKE, 0, LOCK_MS, 1_000, "C5");
    };

    const rich = committed(100_000_000);
    const poor = committed(1_000_000);
    assert.ok(
      Math.abs(rich / poor - 100) < 10,
      `what a desk may risk is a fraction of what it has: ${rich} vs ${poor}`
    );
  });
});

describe("the desks respect the same rules as players", () => {
  it("will not take a view on the crown", () => {
    const round = roundBook("C3");
    openRound(round);
    const intent = deskIntent({
      deskId: 0,
      entry: round.entries[2],
      standing: OPEN[2],
      board: OPEN,
      remaining: 0.5,
      urgency: 0.5,
      windowMs: LOCK_MS,
      credits: 100_000_000,
      now: Date.now(),
    });
    assert.equal(intent, null, "nothing on the reigning coin is tradable");
    assert.equal(quoteCents("C3", "HIGHER"), null);
  });
});

/**
 * The number the flow model costs us, made visible rather than enforced.
 *
 * Nothing tethers a mark to `fairCents` any more, so it can sit at a price the
 * modelled probability does not justify. This does not fail the build — a band
 * to hold them together was considered and declined — it reports, so the drift
 * is a number somebody has seen rather than a surprise.
 */
describe("divergence from the model", () => {
  it("reports how far the marks stray", () => {
    const round = roundBook();
    openRound(round);

    const measure = (board: Standing[], at: number) => {
      const remaining = (round.endsAt.getTime() - at) / MS;
      let max = 0;
      let sum = 0;
      let n = 0;
      for (const entry of round.entries) {
        const s = board.find((x) => x.symbol === entry.symbol) ?? standing(entry.symbol, 11, 0);
        for (const d of DIRECTIONS) {
          const q = quoteCents(entry.symbol, d);
          if (!q) continue;
          const div = Math.abs(q.mark - fairCents(s, board, d, entry.startRank, remaining));
          max = Math.max(max, div);
          sum += div;
          n++;
        }
      }
      return { max, mean: sum / n };
    };

    const t0 = round.startsAt.getTime();
    const untraded = measure(OPEN, t0);

    let max = 0;
    let sum = 0;
    let n = 0;
    for (let at = 0; at < LOCK_MS; at += 20_000) {
      run(round, AFTER_OVERTAKE, at, at + 20_000, 4_000);
      const d = measure(AFTER_OVERTAKE, t0 + at);
      max = Math.max(max, d.max);
      sum += d.mean;
      n++;
    }

    console.log(
      `      divergence |mark - fairCents|:\n` +
        `        before a credit trades: max ${untraded.max}c, mean ${untraded.mean.toFixed(1)}c ` +
        `(the opening print is a band prior; fairCents adds live volume drift)\n` +
        `        over a whole round:     max ${max}c, mean ${(sum / n).toFixed(1)}c`
    );
    assert.ok(n > 0, "the measurement has to have run");
  });
});

describe("the desks are always in the market", () => {
  it("trades every tick, from the first minute to the last", () => {
    const round = roundBook();
    openRound(round);

    // A desk used to wake on a Poisson clock a few times a minute and see any
    // one asset a handful of times a round. It now re-prices and trades every
    // second, so there is no minute of a round in which the book is untouched.
    // Across the board, the way the live loop picks: a desk that is full on one
    // coin still has nine others, so nothing here is ever idle.
    let pick = 0;
    const traded = (fromMs: number) => {
      let fills = 0;
      for (let at = fromMs; at < fromMs + 60_000; at += 1_000) {
        for (let desk = 0; desk < 8; desk++) {
          const fill = simulateArrival(desk, {
            symbol: round.entries[Math.floor(rand(pick++) * round.entries.length)].symbol,
            standings: AFTER_OVERTAKE,
            round,
            now: round.startsAt.getTime() + at,
          });
          if (fill) fills++;
        }
      }
      return fills;
    };

    assert.equal(traded(0), 8 * 60, "every desk trades every tick of the first minute");
    // By the last minute a desk is at its position limit on some of the coins it
    // lands on, and declining to add there is the limit working rather than the
    // desk going quiet — it is still trading nine ticks in ten.
    const late = traded(LOCK_MS - 60_000);
    assert.ok(late > 0.8 * 8 * 60, `and is still in the market at the close: ${late}/480`);
  });

  it("sizes the last minute far above the first", () => {
    const round = roundBook();
    openRound(round);
    const early = run(round, AFTER_OVERTAKE, 0, 60_000, 1_000, "C5");
    const late = run(round, AFTER_OVERTAKE, LOCK_MS - 60_000, LOCK_MS, 1_000, "C5");

    // Same number of fills either side; the difference is entirely the ramp,
    // and it is the only thing standing between a player and the desks.
    assert.ok(
      late > early * 10,
      `the ramp must back-load the accumulation: ${early} early vs ${late} late`
    );
  });
});

describe("the desks' clock", () => {
  it("cannot double-start, and stops for good", async () => {
    assert.equal(botsTicking(), false);

    startBots();
    assert.equal(botsTicking(), true);
    startBots(); // a second call must not stack a second set of timers
    assert.equal(botsTicking(), true);

    stopBots();
    assert.equal(botsTicking(), false);
    stopBots(); // and stopping twice is not an error

    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(botsTicking(), false);
  });
});
