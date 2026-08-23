import { extendType, floatArg, intArg, nonNull, stringArg } from "nexus";
import type { CryptoBet, RankSample, Token } from "../generated/prisma";
import { callerId } from "../context";
import { botTape } from "../bots";
import { book } from "../market";
import { toUserView } from "../views";
import { CHAIN_MODE } from "../env";
import { chainTape } from "../chain/tape";
import { oracle, WINDOW_LABEL } from "../oracle/index";
import { currentRound } from "../rounds";
import { toRoundView, toCryptoBetView, liveRankOf } from "../crypto-views";

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
        // Desks hold accounts but are not people. Nothing can mint a session for
        // one, so this is belt and braces — but a bot account surfacing as the
        // logged-in player is the kind of thing worth making impossible twice.
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
     * The chart draws the round's field, not today's top ten.
     *
     * Those are different sets the moment the board moves, and the difference is
     * the whole point of a round: a coin that opened in the field and has been
     * pushed off the board is still bettable, still holds positions, and is
     * exactly the one whose line a player needs — while a coin that trended into
     * the top ten mid-round is not in this race at all. Membership therefore
     * comes from the round; only when there is no live round does it fall back
     * to the board, which is all there is to draw between rounds.
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

    /** Simulated desk activity, newest first. In-memory only — never persisted. */
    t.nonNull.list.nonNull.field("botTape", {
      type: "BotTrade",
      args: { limit: intArg() },
      // Whichever desks are actually trading. `botTape` groups Postgres rows,
      // which the chain desks never write — so with the chain on it correctly
      // returns nothing and the panel goes blank while the market runs.
      resolve: (_root, args) =>
        CHAIN_MODE === "on"
          ? chainTape(clampCount(args.limit, 24, 120))
          : botTape(clampCount(args.limit, 24, 120)),
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
    /** Recent rounds, newest first — powers the results/verification panel. */
    t.nonNull.list.nonNull.field("cryptoRounds", {
      type: "Round",
      args: { limit: intArg() },
      resolve: async (_root, args, ctx) => {
        const rounds = await ctx.prisma.round.findMany({
          orderBy: { startsAt: "desc" },
          take: clampCount(args.limit, 10, 50),
          include: { entries: true },
        });
        return rounds.map(toRoundView);
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
