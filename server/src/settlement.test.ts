import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { prisma } from "./prisma";
import { settleRoundForTest } from "./rounds";

/**
 * What settlement owes, and to whom.
 *
 * Every credit in the game is either in a balance or staked in an open bet, so
 * the property that has to hold is a conservation law: after a round settles,
 * what left the balances as stakes and what came back as payouts must differ by
 * exactly the sum the resolved rows claim. A settlement that pays the right
 * people the wrong amount, or the wrong people at all, still looks fine one bet
 * at a time — it only shows up in the total.
 */

let reachable = true;
const madeRounds: string[] = [];
const madeUsers: string[] = [];

before(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    reachable = false;
  }
});

after(async () => {
  if (reachable) {
    if (madeRounds.length) {
      await prisma.cryptoBet.deleteMany({ where: { roundId: { in: madeRounds } } });
      await prisma.round.deleteMany({ where: { id: { in: madeRounds } } });
    }
    if (madeUsers.length) {
      await prisma.cryptoBet.deleteMany({ where: { userId: { in: madeUsers } } });
      await prisma.user.deleteMany({ where: { id: { in: madeUsers } } });
    }
  }
  await prisma.$disconnect();
});

let seq = 0;
const unique = () => `${Date.now()}-${process.pid}-${seq++}`;

async function makePlayer(credits: number) {
  const user = await prisma.user.create({
    data: { handle: `settle-${unique()}`, credits },
  });
  madeUsers.push(user.id);
  return user;
}

/**
 * A round frozen at the cut, ready to settle.
 *
 * `cuts` maps symbol to the rank it was scored at; a symbol mapped to `null`
 * models the case `recordCut` can leave behind — an entry that never got a rank
 * because another worker had already claimed the flip.
 */
async function makeCutRound(cuts: Record<string, number | null>) {
  const now = Date.now();
  const round = await prisma.round.create({
    data: {
      // Far enough back that it cannot collide with the live schedule.
      startsAt: new Date(now - 1e9 - seq * 60_000 - Math.floor(Math.random() * 1e8)),
      lockAt: new Date(now - 120_000),
      endsAt: new Date(now - 60_000),
      cutAt: new Date(now - 90_000),
      commitHash: "test",
      seed: "test-seed",
      status: "CUT",
      entries: {
        create: Object.entries(cuts).map(([symbol, cutRank], i) => ({
          symbol,
          ticker: symbol,
          startRank: i + 1,
          startVolume: 1000 - i,
          ...(cutRank === null ? {} : { cutRank, cutVolume: 500 }),
        })),
      },
    },
    include: { entries: true },
  });
  madeRounds.push(round.id);
  return round;
}

const betOn = (
  userId: string,
  roundId: string,
  symbol: string,
  direction: "HIGHER" | "DRAW" | "LOWER",
  startRank: number,
  stake: number,
  odds: number
) =>
  prisma.cryptoBet.create({
    data: { userId, roundId, symbol, ticker: symbol, direction, stake, odds, startRank },
  });

describe("settling a round", () => {
  it("pays winners, keeps losers' stakes, and the credits add up", async (t) => {
    if (!reachable) return t.skip("no database reachable");

    // A started 1st and finished 3rd (LOWER); B started 2nd and finished 1st
    // (HIGHER); C started 3rd and held (DRAW).
    const round = await makeCutRound({ A: 3, B: 1, C: 3 });
    const player = await makePlayer(1000);

    const winner = await betOn(player.id, round.id, "A", "LOWER", 1, 100, 2.5);
    const loser = await betOn(player.id, round.id, "B", "LOWER", 2, 50, 3);
    const drawer = await betOn(player.id, round.id, "C", "DRAW", 3, 40, 4);

    await settleRoundForTest(round.id);

    const rows = await prisma.cryptoBet.findMany({ where: { roundId: round.id } });
    const byId = new Map(rows.map((r) => [r.id, r]));
    assert.equal(byId.get(winner.id)!.status, "WON");
    assert.equal(byId.get(winner.id)!.payout, 250);
    assert.equal(byId.get(loser.id)!.status, "LOST");
    assert.equal(byId.get(loser.id)!.payout, 0);
    assert.equal(byId.get(drawer.id)!.status, "WON", "a held rank is a DRAW");
    assert.equal(byId.get(drawer.id)!.payout, 160);

    const after = await prisma.user.findUnique({ where: { id: player.id } });
    const paid = rows.reduce((sum, r) => sum + r.payout, 0);
    assert.equal(
      after!.credits,
      1000 + paid,
      "the balance moved by exactly what the resolved rows say it was owed"
    );
    assert.ok(rows.every((r) => r.cutRank !== null), "every settled bet records where it was scored");
  });

  it("refunds a bet the cut never scored instead of stranding it", async (t) => {
    if (!reachable) return t.skip("no database reachable");

    // `recordCut` can return early when another worker claims the flip, which
    // leaves entries with no cutRank. The round still settles.
    const round = await makeCutRound({ A: 2, GHOST: null });
    const player = await makePlayer(500);
    const stranded = await betOn(player.id, round.id, "GHOST", "HIGHER", 2, 75, 3);

    await settleRoundForTest(round.id);

    const row = await prisma.cryptoBet.findUniqueOrThrow({ where: { id: stranded.id } });
    assert.notEqual(row.status, "OPEN", "an unscored bet must not be left open forever");
    assert.equal(row.status, "VOID");
    assert.equal(row.payout, 75, "a void returns the stake, no more and no less");

    const after = await prisma.user.findUnique({ where: { id: player.id } });
    assert.equal(after!.credits, 500 + 75, "and the player is made whole");
  });

  it("pays a round once, however many times it is settled", async (t) => {
    if (!reachable) return t.skip("no database reachable");

    const round = await makeCutRound({ A: 1 });
    const player = await makePlayer(0);
    await betOn(player.id, round.id, "A", "HIGHER", 3, 100, 2);

    await settleRoundForTest(round.id);
    const once = await prisma.user.findUnique({ where: { id: player.id } });
    assert.equal(once!.credits, 200);

    await settleRoundForTest(round.id);
    await settleRoundForTest(round.id);
    const still = await prisma.user.findUnique({ where: { id: player.id } });
    assert.equal(still!.credits, 200, "the CUT → SETTLED claim is what makes this safe");
  });

  it("does not pay for a bet that was already closed out from under it", async (t) => {
    if (!reachable) return t.skip("no database reachable");

    const round = await makeCutRound({ A: 1 });
    const player = await makePlayer(0);
    const bet = await betOn(player.id, round.id, "A", "HIGHER", 3, 100, 2);

    // Exactly the race the RETURNING rewrite exists for: the bet leaves OPEN
    // after settlement has read it and before it writes. The status guard skips
    // the row — the credit has to be skipped with it.
    await prisma.cryptoBet.update({
      where: { id: bet.id },
      data: { status: "CASHED_OUT", payout: 120, resolvedAt: new Date() },
    });
    await prisma.user.update({ where: { id: player.id }, data: { credits: 120 } });

    await settleRoundForTest(round.id);

    const after = await prisma.user.findUnique({ where: { id: player.id } });
    assert.equal(
      after!.credits,
      120,
      "one stake pays once — settling a cashed-out bet must not pay it again"
    );
    const row = await prisma.cryptoBet.findUniqueOrThrow({ where: { id: bet.id } });
    assert.equal(row.status, "CASHED_OUT", "and the row it skipped is left alone");
  });
});
