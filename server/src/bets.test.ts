import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { placeBet, type RoundWithEntries } from "./bets";
import { openRound, recordFill, resetMarket } from "./market";
import { ordersForRound } from "./orders";
import type { Standing } from "./oracle/index";
import { prisma } from "./prisma";

/**
 * The half that needs Postgres: that a bet is a real `CryptoBet` row against a
 * real balance, that everything illegal is refused without costing anything, and
 * that the orders feed reports what actually happened.
 *
 * Everything here is torn down afterwards, and the rounds it opens start far
 * enough in the past that they cannot collide with a live one.
 */

let reachable = true;
let roundId: string | null = null;
const madeUsers: string[] = [];

function standing(symbol: string, rank: number): Standing {
  return {
    symbol,
    ticker: symbol,
    name: symbol,
    imageUrl: null,
    rank,
    previousRank: null,
    quoteVolume: 1000 - rank * 50,
    price: 1,
    trades1h: 0,
    wallets1h: 0,
    priceChange1hPercent: 0,
  };
}
const BOARD = Array.from({ length: 10 }, (_, i) => standing(`T${i + 1}`, i + 1));

async function makeRound(overrides: Partial<RoundWithEntries> = {}) {
  const now = Date.now();
  // Sweep any fixture round a previous run left behind before making another.
  //
  // This suite writes a real round and deletes it in teardown, and a run that is
  // interrupted — a killed process, a timeout — never reaches the teardown. Each
  // one then sits in the database with a far-future `endsAt`, which is enough to
  // make `currentRound()` serve it: the app opens no new round, the board fills
  // with T1..T10, and the chart filters its history to symbols no feed has ever
  // produced. One session's interruptions left 151 of them carrying 51,894 bets,
  // and the symptom people chased was "the chart is empty".
  const orphans = await prisma.round.findMany({
    select: { id: true, entries: { select: { symbol: true } } },
  });
  const stale = orphans
    .filter((r) => r.entries.length > 0 && r.entries.every((e) => /^T\d+$/.test(e.symbol)))
    .map((r) => r.id);
  if (stale.length) {
    await prisma.cryptoBet.deleteMany({ where: { roundId: { in: stale } } });
    await prisma.round.deleteMany({ where: { id: { in: stale } } });
  }

  const round = await prisma.round.create({
    data: {
      startsAt: new Date(now - 15 * 60_000 - Math.floor(Math.random() * 1e9)),
      lockAt: new Date(now + 14 * 60_000),
      endsAt: new Date(now + 15 * 60_000),
      commitHash: "test",
      status: "OPEN",
      entries: {
        create: BOARD.map((s) => ({
          symbol: s.symbol,
          ticker: s.ticker,
          startRank: s.rank,
          startVolume: s.quoteVolume,
        })),
      },
      ...(overrides as object),
    },
    include: { entries: true },
  });
  roundId = round.id;
  return round;
}

before(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    reachable = false;
  }
});

after(async () => {
  if (reachable) {
    if (roundId) {
      await prisma.cryptoBet.deleteMany({ where: { roundId } });
      await prisma.round.delete({ where: { id: roundId } }).catch(() => {});
    }
    if (madeUsers.length) {
      await prisma.cryptoBet.deleteMany({ where: { userId: { in: madeUsers } } });
      await prisma.user.deleteMany({ where: { id: { in: madeUsers } } });
    }
  }
  await prisma.$disconnect();
});

async function makePlayer(credits: number) {
  const player = await prisma.user.create({
    data: { handle: `test-player-${Date.now()}-${madeUsers.length}`, credits },
  });
  madeUsers.push(player.id);
  return player;
}

describe("a bet is money", () => {
  it("writes a CryptoBet row and debits the account", async (t) => {
    if (!reachable) return t.skip("no database reachable");

    resetMarket();
    const round = await makeRound();
    openRound(round);
    const player = await makePlayer(1_000);

    const placed = await placeBet({
      prisma,
      userId: player.id,
      round,
      symbol: "T5",
      direction: "HIGHER",
      stake: 120,
    });
    assert.equal(placed.ok, true, "the bet was taken");
    assert.ok(placed.ok && placed.cents > 0, "and it filled at a real price");

    const bets = await prisma.cryptoBet.findMany({ where: { roundId: round.id } });
    assert.equal(bets.length, 1, "one bet is one row");
    assert.equal(bets[0].stake, 120);
    assert.ok(bets[0].odds > 1, "and it locked real odds");

    const after = await prisma.user.findUnique({ where: { id: player.id } });
    assert.equal(after!.credits, 1_000 - 120, "the stake came out of the player's balance");
  });

  it("refuses everything illegal, and a refusal costs nothing", async (t) => {
    if (!reachable) return t.skip("no database reachable");
    const round = await makeRound();
    openRound(round);
    const player = await makePlayer(1_000);

    const bet = (over: Partial<Parameters<typeof placeBet>[0]>) =>
      placeBet({
        prisma,
        userId: player.id,
        round,
        symbol: "T5",
        direction: "HIGHER" as const,
        stake: 10,
        ...over,
      });

    const cases: [string, Awaited<ReturnType<typeof placeBet>>][] = [
      ["a stake of zero", await bet({ stake: 0 })],
      ["a fractional stake", await bet({ stake: 1.5 })],
      ["a coin not in the round", await bet({ symbol: "NOPE" })],
      ["more than it holds", await bet({ stake: player.credits + 1 })],
      ["the reigning coin", await bet({ round: { ...round, crownSymbol: "T5" } })],
      ["a locked round", await bet({ round: { ...round, lockAt: new Date(Date.now() - 1) } })],
    ];
    for (const [what, outcome] of cases) {
      assert.equal(outcome.ok, false, `${what} must be refused`);
    }

    const balance = await prisma.user.findUnique({ where: { id: player.id } });
    assert.equal(balance!.credits, player.credits, "a refusal costs nothing");
  });

  it("cannot bet itself negative under a stale balance", async (t) => {
    if (!reachable) return t.skip("no database reachable");
    const round = await makeRound();
    openRound(round);
    const broke = await makePlayer(5);

    const outcome = await placeBet({
      prisma,
      userId: broke.id,
      round,
      symbol: "T5",
      direction: "HIGHER",
      stake: 1_000_000,
    });

    assert.equal(outcome.ok, false);
    const after = await prisma.user.findUnique({ where: { id: broke.id } });
    assert.equal(after!.credits, 5, "the debit is conditional, so it simply did not happen");
  });
});

describe("the orders feed", () => {
  it("prints a BUY for a bet and a SELL for the close, at the prices they got", async (t) => {
    if (!reachable) return t.skip("no database reachable");

    resetMarket();
    const round = await makeRound();
    openRound(round);
    const player = await makePlayer(1_000);

    const placed = await placeBet({
      prisma,
      userId: player.id,
      round,
      symbol: "T5",
      direction: "HIGHER",
      stake: 200,
    });
    assert.ok(placed.ok);
    // What the mutation does after a fill: the stake joins the pool.
    recordFill({
      at: placed.bet.openedAt.getTime(),
      symbol: placed.bet.symbol,
      direction: "HIGHER",
      size: placed.bet.stake,
    });

    // `ordersForRound` rather than `orders`: which round is live is a question
    // about the whole database, and a developer's own server having a real round
    // open is not a reason for this to fail.
    const opened = await ordersForRound(round.id, 40);
    assert.equal(opened.length, 1, "one bet, one order");
    assert.equal(opened[0].kind, "BUY");
    assert.equal(opened[0].handle, player.handle, "the feed names who bet");
    assert.equal(opened[0].credits, 200);
    assert.equal(opened[0].cents, placed.cents, "at the price the bet actually filled at");
    assert.equal(opened[0].pnl, null, "nothing is won or lost yet");

    // What `cashOutCryptoBet` writes.
    await prisma.cryptoBet.update({
      where: { id: placed.bet.id },
      data: { status: "CASHED_OUT", payout: 260, resolvedAt: new Date() },
    });

    const both = await ordersForRound(round.id, 40);
    assert.equal(both.length, 2, "one row, two moments");
    assert.equal(both[0].kind, "SELL", "and the close is the newer of them");
    assert.equal(both[0].credits, 260, "a SELL reports what was credited");
    assert.equal(both[0].pnl, 60, "and what that made against the stake");
    assert.equal(both[1].kind, "BUY");
  });

  it("leaves the desk rows the old market left behind out of it", async (t) => {
    if (!reachable) return t.skip("no database reachable");

    resetMarket();
    const round = await makeRound();
    openRound(round);
    const ghost = await prisma.user.create({
      data: { handle: `ghost-desk-${Date.now()}`, credits: 1_000, isDesk: true },
    });
    madeUsers.push(ghost.id);

    const placed = await placeBet({
      prisma,
      userId: ghost.id,
      round,
      symbol: "T5",
      direction: "HIGHER",
      stake: 50,
    });
    assert.equal(placed.ok, true, "the row exists — nothing stops one being written");

    assert.deepEqual(
      await ordersForRound(round.id, 40),
      [],
      "but a feed of the room's betting excludes it"
    );
  });
});
