import { strict as assert } from "node:assert";
import { beforeEach, describe, it } from "node:test";
import { placeBet, quoteBet, winnings, type RoundWithEntries } from "./bets";
import type { PrismaClient } from "./generated/prisma";
import {
  DIRECTIONS,
  marketLines,
  OPENING_POOL,
  openRound,
  recordFill,
  resetMarket,
  type Direction,
} from "./market";

/**
 * The ticket's "to win" against what the bet actually pays.
 *
 * These were two calculations: the panel multiplied the board's price by the
 * stake, and the bet filled at the average price its own size walked the line
 * through. For a stake that is small against the pool they agree; for one that
 * is not, the panel promised a 10,000 clip on a 17¢ line nearly 60,000 and it
 * paid 14,000. Nothing here needs Postgres — a quote and a refusal both come
 * back before anything is written — so the bet is placed against a stand-in
 * that records the row it would have created.
 */

/** Credits, as a multiple of what the opening auction stakes on one coin. */
const pools = (n: number) => Math.round(OPENING_POOL * n);

function makeRound(): RoundWithEntries {
  const now = Date.now();
  const symbols = Array.from({ length: 10 }, (_, i) => `Q${i + 1}`);
  return {
    id: "quote-round",
    startsAt: new Date(now - 60_000),
    lockAt: new Date(now + 14 * 60_000),
    endsAt: new Date(now + 15 * 60_000),
    status: "OPEN",
    crownSymbol: "Q1",
    entries: symbols.map((symbol, i) => ({ symbol, ticker: symbol, startRank: i + 1 })),
  } as unknown as RoundWithEntries;
}

/** Enough of Prisma for `placeBet`'s transaction, keeping the row it writes. */
function ledger() {
  const rows: { stake: number; odds: number }[] = [];
  let transactions = 0;
  const tx = {
    user: { updateMany: async () => ({ count: 1 }) },
    cryptoBet: {
      create: async ({ data }: { data: { stake: number; odds: number } }) => {
        rows.push(data);
        return { ...data, id: `bet-${rows.length}`, openedAt: new Date() };
      },
    },
  };
  const prisma = {
    $transaction: async (fn: (t: typeof tx) => unknown) => {
      transactions++;
      return fn(tx);
    },
  } as unknown as PrismaClient;
  return { prisma, rows, transactions: () => transactions };
}

/** The cheapest line on the book that isn't the crown — where a long shot lives. */
function longShot(round: RoundWithEntries): { symbol: string; direction: Direction; cents: number; multiplier: number } {
  let best: ReturnType<typeof longShot> | null = null;
  for (const entry of round.entries) {
    for (const line of marketLines(round, entry.symbol)) {
      if (!line.available) continue;
      if (!best || line.cents < best.cents) best = { symbol: entry.symbol, ...line };
    }
  }
  assert.ok(best, "the round has a line to buy");
  return best;
}

beforeEach(() => resetMarket());

describe("the ticket quotes what the bet pays", () => {
  it("prices a big stake at its fill, not at the board times the stake", () => {
    const round = makeRound();
    openRound(round);
    const line = longShot(round);
    const stake = pools(5);

    const quote = quoteBet({ round, symbol: line.symbol, direction: line.direction, stake });
    assert.ok(quote);
    assert.ok(
      quote.cents > line.cents + 20,
      `a stake five times the pool walks a ${line.cents}¢ line well up — filled at ${quote.cents}¢`
    );
    assert.ok(
      quote.payout < (stake * line.multiplier) / 2,
      `and pays ${quote.payout}, nowhere near the ${Math.round(stake * line.multiplier)} the board's price implies`
    );
    assert.ok(quote.payout > stake, "a win still returns more than the stake");
  });

  it("quotes exactly what the bet then locks in and settlement pays", async () => {
    const round = makeRound();
    openRound(round);
    const line = longShot(round);
    const { prisma, rows } = ledger();

    for (const stake of [1, 37, pools(0.5), pools(5)]) {
      const quote = quoteBet({ round, symbol: line.symbol, direction: line.direction, stake });
      assert.ok(quote);
      const placed = await placeBet({
        prisma,
        userId: "u",
        round,
        symbol: line.symbol,
        direction: line.direction,
        stake,
        maxCents: quote.cents,
      });
      assert.ok(placed.ok, `stake ${stake} was taken at its own quote`);
      assert.equal(placed.cents, quote.cents, `stake ${stake} filled where it was quoted`);
      const row = rows.at(-1)!;
      assert.equal(winnings(row.stake, row.odds), quote.payout, `stake ${stake} pays what it was quoted`);
      // Leave the book as it was, so every stake is quoted against the open.
      resetMarket();
      openRound(round);
    }
  });

  it("quotes a stake too small to move the line at the board's price", () => {
    const round = makeRound();
    openRound(round);
    for (const entry of round.entries) {
      for (const line of marketLines(round, entry.symbol)) {
        if (!line.available) continue;
        const quote = quoteBet({ round, symbol: entry.symbol, direction: line.direction, stake: 1 });
        assert.equal(quote?.cents, line.cents, `${entry.symbol} ${line.direction}`);
      }
    }
  });

  it("has no quote for a bet that would be refused", () => {
    const round = makeRound();
    openRound(round);
    const line = longShot(round);
    const ask = (over: Partial<Parameters<typeof quoteBet>[0]>) =>
      quoteBet({ round, symbol: line.symbol, direction: line.direction, stake: 10, ...over });

    assert.equal(ask({ stake: 0 }), null, "no stake");
    assert.equal(ask({ symbol: "NOPE" }), null, "a coin not in the round");
    assert.equal(ask({ symbol: "Q1" }), null, "the crown");
    assert.equal(ask({ symbol: "Q10", direction: "LOWER" }), null, "a leg that never opens");
    assert.equal(
      ask({ round: { ...round, lockAt: new Date(Date.now() - 1) } }),
      null,
      "a locked round"
    );
  });
});

describe("a bet never fills worse than its ticket", () => {
  it("is refused, at no cost, when the line moved after the quote", async () => {
    const round = makeRound();
    openRound(round);
    const line = longShot(round);
    const stake = pools(1);
    const quote = quoteBet({ round, symbol: line.symbol, direction: line.direction, stake })!;

    // Somebody else backs the same line between the poll and the tap.
    recordFill({ at: Date.now(), symbol: line.symbol, direction: line.direction, size: pools(1) });

    const { prisma, transactions } = ledger();
    const placed = await placeBet({
      prisma,
      userId: "u",
      round,
      symbol: line.symbol,
      direction: line.direction,
      stake,
      maxCents: quote.cents,
    });
    assert.equal(placed.ok, false);
    assert.equal(!placed.ok && placed.refusal, "PRICE_MOVED");
    assert.equal(transactions(), 0, "nothing was debited");

    // Re-quoted, the same stake goes through at the new price.
    const fresh = quoteBet({ round, symbol: line.symbol, direction: line.direction, stake })!;
    assert.ok(fresh.cents > quote.cents);
    const retried = await placeBet({
      prisma,
      userId: "u",
      round,
      symbol: line.symbol,
      direction: line.direction,
      stake,
      maxCents: fresh.cents,
    });
    assert.equal(retried.ok, true);
  });

  it("still fills when the line moved in the bettor's favour", async () => {
    const round = makeRound();
    openRound(round);
    const line = longShot(round);
    const stake = pools(1);
    const quote = quoteBet({ round, symbol: line.symbol, direction: line.direction, stake })!;

    // Money onto the other legs makes this one cheaper.
    for (const direction of DIRECTIONS) {
      if (direction === line.direction) continue;
      recordFill({ at: Date.now(), symbol: line.symbol, direction, size: pools(1) });
    }

    const { prisma } = ledger();
    const placed = await placeBet({
      prisma,
      userId: "u",
      round,
      symbol: line.symbol,
      direction: line.direction,
      stake,
      maxCents: quote.cents,
    });
    assert.equal(placed.ok, true);
    assert.ok(placed.ok && placed.cents < quote.cents, "and at the better price");
  });
});
