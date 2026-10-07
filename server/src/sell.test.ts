import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { placeBet, type RoundWithEntries } from "./bets";
import { openRound, recordFill, resetMarket } from "./market";
import { ordersForRound } from "./orders";
import type { Standing } from "./oracle/index";
import { prisma } from "./prisma";
import { sellPosition } from "./sell";

/**
 * Selling, against a real database.
 *
 * The half that cannot be reasoned about from the pricing alone: that a partial
 * sale leaves the right position standing, that the credits it pays are the
 * credits the quote promised, and that what the room sees is one sale rather
 * than a purchase nobody made.
 */

let reachable = true;
const madeRounds: string[] = [];
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
const BOARD = Array.from({ length: 10 }, (_, i) => standing(`S${i + 1}`, i + 1));

async function makeRound(overrides: Partial<RoundWithEntries> = {}) {
  const now = Date.now();
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
  madeRounds.push(round.id);
  return round;
}

async function makePlayer(credits: number) {
  const player = await prisma.user.create({
    data: { handle: `sell-player-${Date.now()}-${madeUsers.length}`, credits },
  });
  madeUsers.push(player.id);
  return player;
}

/** Place a bet the way the mutation does — the fill has to reach the book. */
async function buy(round: RoundWithEntries, userId: string, symbol: string, stake: number) {
  const placed = await placeBet({ prisma, userId, round, symbol, direction: "HIGHER", stake });
  assert.equal(placed.ok, true, "the fixture's own bet was taken");
  if (!placed.ok) throw new Error("unreachable");
  recordFill({
    at: placed.bet.openedAt.getTime(),
    symbol,
    direction: "HIGHER",
    size: stake,
  });
  return placed.bet;
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

describe("selling part of a position", () => {
  it("shrinks the lot, writes the slice that left, and pays for it", async (t) => {
    if (!reachable) return t.skip("no database reachable");

    resetMarket();
    const round = await makeRound();
    openRound(round);
    const player = await makePlayer(1_000);
    const lot = await buy(round, player.id, "S5", 200);
    const spent = (await prisma.user.findUniqueOrThrow({ where: { id: player.id } })).credits;

    const sold = await sellPosition({
      prisma,
      userId: player.id,
      round,
      symbol: "S5",
      direction: "HIGHER",
      stake: 80,
      rank: 5,
    });
    assert.equal(sold.ok, true);
    if (!sold.ok) throw new Error("unreachable");
    assert.equal(sold.sale.sold, 80, "it sold what was asked for");
    assert.ok(sold.sale.payout > 0, "and it paid something for it");

    const open = await prisma.cryptoBet.findUniqueOrThrow({ where: { id: lot.id } });
    assert.equal(open.status, "OPEN", "the position that is left is still a position");
    assert.equal(open.stake, 120, "and it is exactly what was not sold");
    assert.equal(open.odds, lot.odds, "at the price it was bought at — a sale is not a re-fill");

    const slice = await prisma.cryptoBet.findFirstOrThrow({ where: { parentId: lot.id } });
    assert.equal(slice.status, "CASHED_OUT");
    assert.equal(slice.stake, 80, "the slice is the part that left");
    assert.equal(slice.payout, sold.sale.payout, "credited what the sale said it would be");
    assert.equal(slice.cutRank, 5, "and standing where the coin stood when it left");

    const paid = (await prisma.user.findUniqueOrThrow({ where: { id: player.id } })).credits;
    assert.equal(paid - spent, sold.sale.payout, "the balance moved by the payout and nothing else");
  });

  it("fills oldest lot first, and prices the whole clip once", async (t) => {
    if (!reachable) return t.skip("no database reachable");

    resetMarket();
    const round = await makeRound();
    openRound(round);
    const player = await makePlayer(1_000);
    const first = await buy(round, player.id, "S5", 100);
    const second = await buy(round, player.id, "S5", 100);

    const sold = await sellPosition({
      prisma,
      userId: player.id,
      round,
      symbol: "S5",
      direction: "HIGHER",
      stake: 150,
      rank: 5,
    });
    assert.equal(sold.ok, true);
    if (!sold.ok) throw new Error("unreachable");
    assert.equal(sold.sale.sold, 150);

    const oldest = await prisma.cryptoBet.findUniqueOrThrow({ where: { id: first.id } });
    const newest = await prisma.cryptoBet.findUniqueOrThrow({ where: { id: second.id } });
    assert.equal(oldest.status, "CASHED_OUT", "the first lot went entirely");
    assert.equal(newest.status, "OPEN", "the second is what is left");
    assert.equal(newest.stake, 50, "less the fifty the sale reached into it for");

    // One bid for the clip: both parts of it left at the same price per share,
    // which is what "the sale walks the pool back down once" means.
    const parts = [oldest, await prisma.cryptoBet.findFirstOrThrow({ where: { parentId: second.id } })];
    for (const part of parts) {
      const cents = Math.round((part.payout * 100) / (part.stake * part.odds));
      assert.ok(
        Math.abs(cents - sold.sale.cents) <= 1,
        `each part left at the clip's price (${cents} vs ${sold.sale.cents})`
      );
    }
    assert.equal(
      parts.reduce((n, p) => n + p.payout, 0),
      sold.sale.payout,
      "and the parts add up to what was paid"
    );
  });

  it("sells everything when asked for more than is held", async (t) => {
    if (!reachable) return t.skip("no database reachable");

    resetMarket();
    const round = await makeRound();
    openRound(round);
    const player = await makePlayer(1_000);
    await buy(round, player.id, "S5", 60);

    const sold = await sellPosition({
      prisma,
      userId: player.id,
      round,
      symbol: "S5",
      direction: "HIGHER",
      stake: 10_000,
      rank: 5,
    });
    assert.equal(sold.ok, true);
    if (!sold.ok) throw new Error("unreachable");
    assert.equal(sold.sale.sold, 60, "a Max is a clamp, not a refusal");

    const left = await prisma.cryptoBet.count({
      where: { userId: player.id, roundId: round.id, status: "OPEN" },
    });
    assert.equal(left, 0, "nothing is still standing");
  });

  it("prints one sale to the room, and no purchase that never happened", async (t) => {
    if (!reachable) return t.skip("no database reachable");

    resetMarket();
    const round = await makeRound();
    openRound(round);
    const player = await makePlayer(1_000);
    await buy(round, player.id, "S5", 200);

    const sold = await sellPosition({
      prisma,
      userId: player.id,
      round,
      symbol: "S5",
      direction: "HIGHER",
      stake: 50,
      rank: 5,
    });
    assert.equal(sold.ok, true);
    if (!sold.ok) throw new Error("unreachable");

    const feed = await ordersForRound(round.id, 40);
    assert.equal(feed.length, 2, "the buy, and the part of it that was sold");
    assert.equal(feed[0].kind, "SELL");
    assert.equal(feed[0].credits, sold.sale.payout, "for what the seller was actually credited");
    assert.equal(feed[1].kind, "BUY");
    assert.equal(feed[1].credits, 200, "and the purchase still reads at its full size");
  });

  it("refuses what cannot be sold", async (t) => {
    if (!reachable) return t.skip("no database reachable");

    resetMarket();
    const round = await makeRound();
    openRound(round);
    const player = await makePlayer(1_000);
    await buy(round, player.id, "S5", 100);

    const none = await sellPosition({
      prisma,
      userId: player.id,
      round,
      symbol: "S5",
      direction: "LOWER",
      stake: 50,
      rank: 5,
    });
    assert.equal(none.ok, false, "a line they never backed is not a position");
    assert.equal(none.ok === false && none.refusal, "NO_POSITION");

    const nothing = await sellPosition({
      prisma,
      userId: player.id,
      round,
      symbol: "S5",
      direction: "HIGHER",
      stake: 0,
      rank: 5,
    });
    assert.equal(nothing.ok === false && nothing.refusal, "BAD_STAKE");

    const locked = await sellPosition({
      prisma,
      userId: player.id,
      round: { id: round.id, status: "LOCKED" },
      symbol: "S5",
      direction: "HIGHER",
      stake: 50,
      rank: 5,
    });
    assert.equal(locked.ok === false && locked.refusal, "CLOSED", "a locked round settles at the cut");

    const still = await prisma.cryptoBet.findFirstOrThrow({
      where: { userId: player.id, roundId: round.id },
    });
    assert.equal(still.stake, 100, "and none of that touched the position");
  });
});
