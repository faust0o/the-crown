import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { placeBet, type RoundWithEntries } from "./bets";
import { resetBots, seedDesks, tradeOnArrival } from "./bots";
import { openRound } from "./market";
import type { Standing } from "./oracle/index";
import { prisma } from "./prisma";

/**
 * The half that needs Postgres: that a desk's clip is a real `CryptoBet` row
 * against a real balance, that it is refused for everything a player would be
 * refused for, and that a bot account cannot become a player.
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

describe("the desks bet real money", () => {
  it("writes a CryptoBet row and debits the account", async (t) => {
    if (!reachable) return t.skip("no database reachable");

    resetBots();
    await seedDesks();
    const round = await makeRound();
    openRound(round);

    const desks = await prisma.user.findMany({ where: { isDesk: true } });
    assert.ok(desks.length >= 8, `the desks must have accounts, found ${desks.length}`);

    const before = new Map(desks.map((d) => [d.id, d.credits]));
    const fill = await tradeOnArrival(0, { symbol: "T5", standings: BOARD, round });
    assert.ok(fill, "the desk traded");

    const bets = await prisma.cryptoBet.findMany({ where: { roundId: round.id } });
    assert.equal(bets.length, 1, "one arrival is one bet");
    assert.equal(bets[0].stake, fill!.size, "the clip is the stake");
    assert.equal(bets[0].symbol, "T5");
    assert.ok(bets[0].odds > 1, "and it locked real odds");

    const after = await prisma.user.findUnique({ where: { id: bets[0].userId } });
    assert.equal(
      after!.credits,
      before.get(bets[0].userId)! - bets[0].stake,
      "the stake came out of the desk's own balance"
    );
  });

  it("refuses a desk everything it would refuse a player", async (t) => {
    if (!reachable) return t.skip("no database reachable");
    const round = await makeRound();
    openRound(round);
    const desk = (await prisma.user.findFirst({ where: { isDesk: true } }))!;

    const cases: [string, Awaited<ReturnType<typeof placeBet>>][] = [
      ["a stake of zero", await placeBet({ prisma, userId: desk.id, round, symbol: "T5", direction: "HIGHER", stake: 0 })],
      ["a fractional stake", await placeBet({ prisma, userId: desk.id, round, symbol: "T5", direction: "HIGHER", stake: 1.5 })],
      ["a coin not in the round", await placeBet({ prisma, userId: desk.id, round, symbol: "NOPE", direction: "HIGHER", stake: 10 })],
      ["more than it holds", await placeBet({ prisma, userId: desk.id, round, symbol: "T5", direction: "HIGHER", stake: desk.credits + 1 })],
    ];
    for (const [what, outcome] of cases) {
      assert.equal(outcome.ok, false, `${what} must be refused`);
    }

    // …and the crown, and a locked round.
    const crowned = { ...round, crownSymbol: "T5" };
    assert.equal(
      (await placeBet({ prisma, userId: desk.id, round: crowned, symbol: "T5", direction: "HIGHER", stake: 10 })).ok,
      false,
      "the reigning coin is not bettable by anyone"
    );
    const locked = { ...round, lockAt: new Date(Date.now() - 1) };
    assert.equal(
      (await placeBet({ prisma, userId: desk.id, round: locked, symbol: "T5", direction: "HIGHER", stake: 10 })).ok,
      false,
      "and nobody bets after the lock"
    );

    const balance = await prisma.user.findUnique({ where: { id: desk.id } });
    assert.equal(balance!.credits, desk.credits, "a refusal costs nothing");
  });

  it("cannot bet itself negative under a stale balance", async (t) => {
    if (!reachable) return t.skip("no database reachable");
    const round = await makeRound();
    openRound(round);
    const broke = await prisma.user.create({
      data: { handle: `broke-desk-${Date.now()}`, credits: 5, isDesk: true },
    });
    madeUsers.push(broke.id);

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

  it("keeps desks out of the players' world", async (t) => {
    if (!reachable) return t.skip("no database reachable");
    await seedDesks();

    const desks = await prisma.user.findMany({ where: { isDesk: true } });
    const sessions = await prisma.session.count({
      where: { userId: { in: desks.map((d) => d.id) } },
    });
    assert.equal(sessions, 0, "no desk has a session, so no desk can be logged in as");
    assert.ok(
      desks.every((d) => d.inviteCodeId === null),
      "and none of them consumed an invite"
    );
  });

  it("does not refill a desk that has spent its money", async (t) => {
    if (!reachable) return t.skip("no database reachable");
    const desk = (await prisma.user.findFirst({ where: { isDesk: true } }))!;
    await prisma.user.update({ where: { id: desk.id }, data: { credits: 42 } });

    await seedDesks(); // a restart

    const after = await prisma.user.findUnique({ where: { id: desk.id } });
    assert.equal(after!.credits, 42, "P&L persists; a restart is not a bailout");
    await prisma.user.update({ where: { id: desk.id }, data: { credits: desk.credits } });
  });
});
