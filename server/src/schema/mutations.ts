import { extendType, nonNull, arg, stringArg, idArg, intArg } from "nexus";
import { GraphQLError } from "graphql";
import type { Prisma, PrismaClient } from "../generated/prisma";
import { hashToken, newHandle, newToken, sessionExpiry } from "../auth";
import { callerId } from "../context";
import { toUserView } from "../views";
import { currentRound } from "../rounds";
import { confirmCreditPurchase, prepareCreditPurchase } from "../chain/purchase";
import { closeCents, closeValue, recordFill, unwind, type Direction } from "../market";
import { placeBet } from "../bets";
import { liveRankOf, toCryptoBetView } from "../crypto-views";

function badInput(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: "BAD_USER_INPUT" } });
}

/** Credits a fresh account is seeded with. */
const STARTING_CREDITS = 1000;

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "P2002"
  );
}

async function createUniqueUser(prisma: PrismaClient, inviteCodeId: string) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await prisma.user.create({
        data: { handle: newHandle(), inviteCodeId, credits: STARTING_CREDITS },
      });
    } catch (err) {
      if (isUniqueViolation(err)) continue;
      throw err;
    }
  }
  return prisma.user.create({
    data: {
      handle: `${newHandle()}-${Math.floor(Date.now() % 100000)}`,
      inviteCodeId,
      credits: STARTING_CREDITS,
    },
  });
}

export const mutations = extendType({
  type: "Mutation",
  definition(t) {
    // --- auth ---
    t.nonNull.field("redeemInvite", {
      type: "AuthPayload",
      args: { code: nonNull(stringArg()) },
      resolve: async (_root, { code }, ctx) => {
        // Bounded before it reaches the index: `code` is caller-controlled and
        // unauthenticated, and a megabyte of it is a megabyte of hashing on
        // every attempt. No real code is anywhere near this long.
        const normalised = code.trim().toUpperCase();
        if (normalised.length > 64) throw badInput("Invalid or exhausted invite code.");

        const invite = await ctx.prisma.inviteCode.findUnique({
          where: { code: normalised },
        });
        if (!invite) throw badInput("Invalid or exhausted invite code.");

        // Claim the use *before* creating the account, conditional on there
        // still being one left. Checking and then incrementing lets two
        // concurrent redeems of a single-use code both pass the check.
        const claimed = await ctx.prisma.inviteCode.updateMany({
          where: { id: invite.id, active: true, uses: { lt: invite.maxUses } },
          data: { uses: { increment: 1 } },
        });
        if (claimed.count !== 1) throw badInput("Invalid or exhausted invite code.");

        const user = await createUniqueUser(ctx.prisma, invite.id);

        // The token is returned here and never again: the row holds its hash, so
        // this is the only moment the plaintext exists server-side.
        const token = newToken();
        await ctx.prisma.session.create({
          data: {
            token: hashToken(token),
            userId: user.id,
            expiresAt: sessionExpiry(),
          },
        });
        return { token, user: toUserView(user) };
      },
    });

    /**
     * Revoke this session.
     *
     * Dropping the token client-side is not logging out — the row stays valid
     * for the rest of its thirty days, so anything that saw the token once
     * (shared machine, a backup of localStorage, a stale browser profile) keeps
     * the account. Deleting the row is what makes the button mean something.
     *
     * Scoped to `ctx.sessionId`, so signing out on one device leaves the others
     * signed in.
     */
    t.nonNull.boolean("logout", {
      resolve: async (_root, _args, ctx) => {
        if (!ctx.sessionId) return true;
        await ctx.prisma.session.deleteMany({
          where: { id: ctx.sessionId, userId: callerId(ctx) },
        });
        return true;
      },
    });

    /** Place a three-way bet on one coin's rank movement this round. */
    t.nonNull.field("placeCryptoBet", {
      type: "CryptoBet",
      args: {
        symbol: nonNull(stringArg()),
        direction: nonNull(arg({ type: "RankDirection" })),
        stake: nonNull(intArg()),
      },
      resolve: async (_root, args, ctx) => {
        const userId = callerId(ctx);

        const round = await currentRound();
        if (!round) throw badInput("No round is open yet — the oracle is still warming up.");
        // The same call the desks make. Whatever a player is refused for, a desk
        // is refused for, and at the identical quote.
        const placed = await placeBet({
          prisma: ctx.prisma,
          userId,
          round,
          symbol: args.symbol,
          direction: args.direction,
          stake: args.stake,
        });
        if (!placed.ok) throw badInput(placed.message);

        // A player's credits go into the pool like anyone's. The desks' fills
        // reach the book through `bookFill`; this is the same step for the other
        // side of the market, and without it a player could move the board only
        // by convincing the desks to move it for them.
        recordFill({
          id: placed.bet.id,
          at: placed.bet.openedAt.getTime(),
          bot: "Player",
          symbol: placed.bet.symbol,
          ticker: placed.bet.ticker,
          imageUrl: null,
          direction: placed.bet.direction as Direction,
          size: placed.bet.stake,
          cents: placed.cents,
        });
        return toCryptoBetView(placed.bet);
      },
    });
    /**
     * Close an open position at the current quote.
     *
     * Sold into the tape's bid on that line, so taking profit early costs you the
     * spread and whatever the market has already priced in — the same trade-off a
     * real book gives you. Settles atomically: the row only flips out of OPEN
     * once, so a double-click can't pay twice.
     */

    /**
     * Move this player's credits onto the chain, once their wallet is set up.
     *
     * A transfer rather than a grant: the database balance goes to zero and the
     * same number appears on-chain, so connecting a wallet does not change what
     * anyone holds. Minting without zeroing would make every balance spendable
     * twice, through two paths, by the same person.
     */
    /**
     * The transaction that sells an on-chain position back.
     *
     * Returned rather than performed, because `close_bet` takes the owner's
     * signature and offers no relayer path: money moves out of the vault toward
     * the player, so theirs is the only signature that could matter. The house
     * pays the fee — a player holds credits and never SOL, so a transaction they
     * paid for is one their wallet would refuse to simulate.
     */
    /**
     * The transaction that buys credits with SOL.
     *
     * One atomic effect: the buyer's SOL moves to the house and the credits are
     * minted back, in a single transaction, so there is no state where one
     * happened and the other did not.
     *
     * The caller sends lamports and nothing else — what those are worth is
     * decided server-side, because a client that names its own credit figure is
     * a client that can mint. The wallet in front of the player already contains
     * the resulting number, so what they approve is what they get.
     */
    t.nonNull.field("prepareCreditPurchase", {
      type: "PreparedPurchase",
      args: { lamports: nonNull(stringArg()) },
      resolve: async (_root, args, ctx) => {
        const player = await ctx.prisma.user.findUnique({
          where: { id: callerId(ctx) },
          select: { walletAddress: true },
        });
        if (!player?.walletAddress) throw badInput("Connect a wallet first.");
        let lamports: bigint;
        try {
          lamports = BigInt(args.lamports);
        } catch {
          throw badInput("That is not a whole number of lamports.");
        }
        if (lamports <= 0n) throw badInput("Enter an amount above zero.");
        try {
          return await prepareCreditPurchase({ owner: player.walletAddress, lamports });
        } catch (err) {
          throw badInput(err instanceof Error ? err.message : "Could not prepare that purchase.");
        }
      },
    });

    /**
     * Credit an account for a top-up that has landed on chain.
     *
     * The caller sends a signature and nothing else. What it was worth is read
     * off the transaction — a client that could name its own figure would be a
     * mint button with extra steps — and the signature is stored unique, so
     * presenting it twice credits once.
     */
    t.nonNull.field("confirmCreditPurchase", {
      type: "CreditedPurchase",
      args: { signature: nonNull(stringArg()) },
      resolve: async (_root, args, ctx) => {
        try {
          return await confirmCreditPurchase({
            prisma: ctx.prisma,
            userId: callerId(ctx),
            signature: args.signature,
          });
        } catch (err) {
          throw badInput(err instanceof Error ? err.message : "Could not credit that payment.");
        }
      },
    });




    t.nonNull.field("cashOutCryptoBet", {
      type: "CryptoBet",
      args: { id: nonNull(idArg()) },
      resolve: async (_root, args, ctx) => {
        const userId = callerId(ctx);
        const bet = await ctx.prisma.cryptoBet.findUnique({ where: { id: args.id } });

        // Same refusal either way: "no such position" and "not yours" must not
        // be distinguishable, or the id space becomes an oracle for whose bets
        // exist.
        if (!bet || bet.userId !== userId) throw badInput("No such position.");
        if (bet.status !== "OPEN") throw badInput("That position is already closed.");

        const round = await currentRound();
        if (!round || round.id !== bet.roundId) {
          throw badInput("That round has ended — it will settle on its own.");
        }
        if (round.status !== "OPEN") {
          throw badInput("The round is locked; positions settle at the cut.");
        }

        // A coin that has dropped off the board still stands where the cut will
        // score it, and the tape still quotes it there — so the position closes
        // like any other. Refusing it stranded a bet that was usually winning.
        const rank = liveRankOf(bet.symbol);

        // Sold back down the same stretch of curve the opening trade walked up,
        // so the position pays its own impact on the way out too. Quoting the
        // resting bid instead would let a big position sell into the mark its
        // own credits had just created.
        const bid = closeCents(bet.symbol, bet.direction as Direction, bet.stake);
        if (bid == null) throw badInput("That line is no longer on the book.");
        const payout = closeValue(bet.stake, bet.odds, bid);

        // `tx` is annotated rather than inferred: Prisma's generated overloads
        // are heavy enough that the inference is not something a deploy gate
        // should depend on, and `server:check` is now one.
        const closed = await ctx.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
          const claimed = await tx.cryptoBet.updateMany({
            where: { id: bet.id, status: "OPEN" },
            data: {
              status: "CASHED_OUT",
              payout,
              cutRank: rank,
              resolvedAt: new Date(),
            },
          });
          if (claimed.count !== 1) throw badInput("That position is already closed.");
          if (payout > 0) {
            await tx.user.update({
              where: { id: userId },
              data: { credits: { increment: payout } },
            });
          }
          const fresh = await tx.cryptoBet.findUniqueOrThrow({ where: { id: bet.id } });
          return toCryptoBetView(fresh);
        });

        // The position leaves the pool it joined, so the mark it moved on the
        // way in comes back off on the way out and a round trip costs exactly
        // the spread. After the transaction commits, not inside it: the book is
        // in memory and cannot be rolled back, so unwinding early would take a
        // position out of the market that the database still says is open.
        unwind(bet.symbol, bet.direction as Direction, bet.stake);
        return closed;
      },
    });
  },
});
