import { arg, extendType, floatArg, intArg, nonNull, stringArg } from "nexus";
import type { CryptoBet, RankSample, Token } from "../generated/prisma";
import { callerId } from "../context";
import { orders } from "../orders";
import { book } from "../market";
import { toUserView } from "../views";
import { oracle, WINDOW_LABEL } from "../oracle/index";
import { currentRound } from "../rounds";
import { toRoundView, toCryptoBetView, liveRankOf } from "../crypto-views";
import { quoteSale } from "../sell";
import { quoteBet } from "../bets";
import type { Direction } from "../market";

/**
 * Clamp a caller-supplied count into a range we are willing to serve.
 *
 * Every list argument here is an integer straight off the wire, and left alone
 * each is a way to ask for arbitrarily much work: `limit: 100000` on the
 * standings, `maxPoints: 1e9` on the history. `Math.min(x, cap)` alone is not
 * enough either — a negative `take` is valid Prisma and means "the last n", so
 * an unclamped floor quietly changes which rows come back rather than how many.
 */
const clampCount = (value: number | null | undefined, fallback: number, cap: number): number => {
  const n = Math.floor(value ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(cap, Math.max(1, n));
};

export const queries = extendType({
  type: "Query",
  definition(t) {



    t.field("me", {
      type: "User",
      resolve: async (_root, _args, ctx) => {
        if (!ctx.userId) return null;
        // The retired market-making desks hold accounts but are not people.
        // Nothing can mint a session for one, so this is belt and braces — but a
        // bot account surfacing as the logged-in player is the kind of thing
        // worth making impossible twice.
        const user = await ctx.prisma.user.findFirst({
          where: { id: ctx.userId, isDesk: false },
        });
        return user ? toUserView(user) : null;
      },
    });

    // ---------- Crypto volume-rank oracle ----------

    t.nonNull.list.nonNull.field("cryptoStandings", {
      type: "CryptoStanding",
      args: { limit: intArg() },
      resolve: (_root, args) => oracle.standings(clampCount(args.limit, 10, 50)),
    });

    /**
     * The chart draws today's top ten and the round's field together.
     *
     * Those are different sets the moment the board moves. A coin that opened in
     * the field and has been pushed off the board is still bettable, still holds
     * positions, and is exactly the one whose line a player needs; a coin that
     * trended into the top ten mid-round is on the board under the chart, and
     * gets its line the moment it arrives. Between rounds there is no field, and
     * the board is all there is to draw.
     */
    t.nonNull.list.nonNull.field("cryptoRankHistory", {
      type: "CryptoRankPoint",
      args: { minutes: intArg(), limit: intArg(), maxPoints: intArg() },
      resolve: async (_root, args) => {
        const round = await currentRound();
        return oracle.rankHistory(
          clampCount(args.minutes, 15, 240),
          round?.entries.map((e) => e.symbol),
          clampCount(args.maxPoints, 120, 500)
        );
      },
    });

    t.nonNull.list.nonNull.field("cryptoFlow", {
      type: "FlowEvent",
      args: { limit: intArg(), since: floatArg() },
      resolve: (_root, args) => oracle.recentFlow(clampCount(args.limit, 40, 200), args.since ?? 0),
    });

    /**
     * Every bet placed and every position closed in the live round, newest
     * first — the flow that is moving the board, since it is the only flow there
     * is.
     *
     * Public, like the rest of the board. What it exposes is a pseudonymous
     * handle against a bet in a play-money game, which is the same thing the
     * board's prices already say in aggregate; a market whose participants can
     * see the prices but not the trades is a worse market and not a more private
     * one.
     */
    t.nonNull.list.nonNull.field("orders", {
      type: "Order",
      args: { limit: intArg() },
      resolve: (_root, args) => orders(clampCount(args.limit, 24, 120)),
    });

    t.nonNull.field("oracleStatus", {
      type: "OracleStatus",
      resolve: () => ({
        status: oracle.status,
        // From the upstream's own `asOf`, so this is the age of the numbers
        // rather than the age of our last successful request.
        ageSeconds: Math.max(0, Math.round((Date.now() - oracle.updatedAt) / 1000)),
        window: WINDOW_LABEL,
        updatedAt: oracle.updatedAt,
      }),
    });
    t.field("cryptoRound", {
      type: "Round",
      resolve: async () => {
        const round = await currentRound();
        return round ? toRoundView(round) : null;
      },
    });

    /**
     * What buying `stake` credits of a line would fill at and pay if it lands.
     *
     * The buy side's counterpart to `cryptoSellQuote`, for the same reason: the
     * price depends on the size, and only the server holds the curve. Public,
     * like the board — a signed-out ticket is fully live.
     *
     * Null whenever the bet itself would be refused.
     */
    t.field("cryptoBuyQuote", {
      type: "CryptoBuyQuote",
      args: {
        symbol: nonNull(stringArg()),
        direction: nonNull(arg({ type: "RankDirection" })),
        stake: nonNull(intArg()),
      },
      resolve: async (_root, args) => {
        const round = await currentRound();
        if (!round) return null;
        return quoteBet({
          round,
          symbol: args.symbol,
          direction: args.direction as Direction,
          stake: args.stake,
        });
      },
    });

    /**
     * What selling `stake` credits of one of my lines would fetch right now.
     *
     * Its own field rather than something the panel derives, because the price
     * depends on the size: closing walks the pool back down, and a clip large
     * enough to move it gets a worse average than the first credit out. The
     * client cannot know that curve, and the last time it guessed — quoting the
     * resting bid against a size-aware payout — the screen was reliably kinder
     * than the wallet.
     *
     * Null when there is no position, no round, or no book on that line. The
     * amount is clamped rather than refused: asking to sell more than is held
     * sells all of it, which is what a Max button means.
     */
    t.field("cryptoSellQuote", {
      type: "CryptoSale",
      args: {
        symbol: nonNull(stringArg()),
        direction: nonNull(arg({ type: "RankDirection" })),
        stake: nonNull(intArg()),
      },
      resolve: async (_root, args, ctx) => {
        const round = await currentRound();
        if (!round) return null;
        const lots = await ctx.prisma.cryptoBet.findMany({
          where: {
            userId: callerId(ctx),
            roundId: round.id,
            symbol: args.symbol,
            direction: args.direction,
            status: "OPEN",
            chainAddress: null,
          },
          orderBy: { openedAt: "asc" },
        });
        const quote = quoteSale(lots, args.symbol, args.direction as Direction, args.stake);
        return quote ? { sold: quote.sold, payout: quote.payout, cents: quote.cents } : null;
      },
    });

    t.nonNull.list.nonNull.field("myCryptoBets", {
      type: "CryptoBet",
      args: { roundId: stringArg() },
      resolve: async (_root, args, ctx) => {
        const bets = await ctx.prisma.cryptoBet.findMany({
          where: { userId: callerId(ctx), ...(args.roundId ? { roundId: args.roundId } : {}) },
          orderBy: { openedAt: "desc" },
          take: 100,
        });
        // `currentRound` is what opens the book, so the tape is guaranteed to be
        // quoting this round by the time the positions are priced off it. Only a
        // position on that round is standing anywhere — the rest have resolved.
        const round = await currentRound();
        const board = oracle.standings();
        return bets.map((b: CryptoBet) =>
          toCryptoBetView(
            b,
            b.roundId === round?.id ? { rank: liveRankOf(b.symbol, board) } : undefined
          )
        );
      },
    });
    /**
     * Finished rounds, newest first — powers the results/verification panel.
     *
     * "Finished" means the cut was recorded, not that the payouts have landed.
     * A round's result is the board at its cut instant; paying the bets on it is
     * a separate job that can be slow, can be retried, and — when the chain is
     * mirroring — can be stuck on something that has nothing to do with the
     * race. Keying the history on `SETTLED` meant every one of those failures
     * presented as "no rounds have settled yet", which is a claim about the
     * game's history rather than about a payout queue.
     *
     * The live round is excluded for the same reason it always was: it has no
     * result yet. That is now said in the `where` clause instead of being left
     * to the client to filter out.
     */
    t.nonNull.list.nonNull.field("cryptoRounds", {
      type: "Round",
      args: { limit: intArg() },
      resolve: async (_root, args, ctx) => {
        const rounds = await ctx.prisma.round.findMany({
          where: { cutAt: { not: null } },
          orderBy: { startsAt: "desc" },
          take: clampCount(args.limit, 10, 50),
          include: { entries: true },
        });
        return rounds.map(toRoundView);
      },
    });
    /**
     * One finished round by id — the round a replay link names.
     *
     * The history above stops at fifty, and a link is meant to outlast that.
     * Null for a round with no cut yet, on the history's own terms: a round
     * without a result has nothing to replay.
     */
    t.field("roundResult", {
      type: "Round",
      args: { roundId: nonNull(stringArg()) },
      resolve: async (_root, args, ctx) => {
        const round = await ctx.prisma.round.findUnique({
          where: { id: args.roundId },
          include: { entries: true },
        });
        return round?.cutAt ? toRoundView(round) : null;
      },
    });
    /**
     * Every ordering recorded during a round, oldest first — enough to replay
     * the race. Reads the persisted samples rather than the oracle's in-memory
     * buffer, so rounds stay replayable long after they scroll out of it.
     */
    t.nonNull.list.nonNull.field("roundReplay", {
      type: "CryptoRankPoint",
      args: { roundId: nonNull(stringArg()) },
      resolve: async (_root, args, ctx) => {
        const round = await ctx.prisma.round.findUnique({
          where: { id: args.roundId },
        });
        if (!round) return [];
        const rows = await ctx.prisma.rankSample.findMany({
          where: {
            at: { gte: round.startsAt, lte: round.cutAt ?? round.endsAt },
          },
          orderBy: { at: "asc" },
          // A round's window bounds this already (roughly one row per token per
          // minute); the cap is only so that a round left open by a stalled
          // clock can't turn one query into a table scan.
          take: 20_000,
        });
        return rows.map((r: RankSample) => ({
          t: r.at.getTime(),
          symbol: r.symbol,
          rank: r.rank,
          quoteVolume: r.volume,
        }));
      },
    });
    /**
     * Identities for every token that appears anywhere in a round — its ten
     * entries plus whatever climbed onto the board while it ran.
     *
     * Those climbers are in the samples, so they're in the replay's flow feed,
     * but they were never entries and are rarely still trending, so there is
     * nowhere else left holding their marks. Answered alongside `roundReplay`
     * rather than from a second trip once the client knows the symbols.
     */
    t.nonNull.list.nonNull.field("roundTokens", {
      type: "TokenMeta",
      args: { roundId: nonNull(stringArg()) },
      resolve: async (_root, args, ctx) => {
        const round = await ctx.prisma.round.findUnique({
          where: { id: args.roundId },
          include: { entries: { select: { symbol: true } } },
        });
        if (!round) return [];
        const sampled = await ctx.prisma.rankSample.findMany({
          where: { at: { gte: round.startsAt, lte: round.cutAt ?? round.endsAt } },
          distinct: ["symbol"],
          select: { symbol: true },
        });
        const symbols = [
          ...new Set([...round.entries, ...sampled].map((r) => r.symbol)),
        ];
        const known = await ctx.prisma.token.findMany({
          where: { symbol: { in: symbols } },
        });
        return known.map((t: Token) => ({
          symbol: t.symbol,
          ticker: t.symbol,
          name: t.name,
          imageUrl: t.imageUrl,
        }));
      },
    });
    /** Depth for one coin, aggregated from the same tape that sets its price. */
    t.nonNull.list.nonNull.field("cryptoBook", {
      type: "BookLevel",
      args: { symbol: nonNull(stringArg()) },
      resolve: (_root, args) => book(args.symbol),
    });
  },
});
