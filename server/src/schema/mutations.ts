import { extendType, nonNull, arg, stringArg, idArg, intArg } from "nexus";
import { GraphQLError } from "graphql";
import type { Prisma, PrismaClient } from "../generated/prisma";
import { hashToken, newHandle, newToken, sessionExpiry } from "../auth";
import { issueChallenge, normaliseAddress, verifyChallenge } from "../wallet-auth";
import { callerId } from "../context";
import { toUserView } from "../views";
import { currentRound } from "../rounds";
import { confirmCreditPurchase, prepareCreditPurchase } from "../chain/purchase";
import { closeCents, closeValue, recordFill, unwind, type Direction } from "../market";
import { sellPosition } from "../sell";
import { placeBet } from "../bets";
import { liveRankOf, toCryptoBetView } from "../crypto-views";

function badInput(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: "BAD_USER_INPUT" } });
}

/** Credits a fresh account is seeded with. */
const STARTING_CREDITS = 1000;

/**
 * Which unique index a Prisma P2002 was about.
 *
 * Two of them can fire on the same insert here and they mean opposite things: a
 * clash on `handle` is a coincidence to redraw past, a clash on `walletAddress`
 * means somebody else's request already made this player's account and ours
 * should return theirs. Treating them alike would either loop forever or hand
 * back a duplicate row.
 */
function uniqueViolationOn(err: unknown): string[] | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as { code?: string; meta?: { target?: unknown } };
  if (e.code !== "P2002") return null;
  const target = e.meta?.target;
  return Array.isArray(target) ? target.map(String) : [];
}

/**
 * The account behind a wallet, made on first sign-in.
 *
 * There is no registration step: the wallet is the identity, so proving it is
 * the whole of signing up. Everyone starts with the same play balance.
 */
async function userForWallet(prisma: PrismaClient, walletAddress: string) {
  const existing = await prisma.user.findUnique({ where: { walletAddress } });
  if (existing) return existing;

  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await prisma.user.create({
        data: { handle: newHandle(), walletAddress, credits: STARTING_CREDITS },
      });
    } catch (err) {
      const target = uniqueViolationOn(err);
      if (!target) throw err;
      if (target.includes("walletAddress")) {
        // A concurrent sign-in from the same wallet won the insert. Its row is
        // the account — there is only ever one per wallet.
        const raced = await prisma.user.findUnique({ where: { walletAddress } });
        if (raced) return raced;
        throw err;
      }
      // Handle collision: redraw.
    }
  }
  return prisma.user.create({
    data: {
      handle: `${newHandle()}-${Math.floor(Date.now() % 100000)}`,
      walletAddress,
      credits: STARTING_CREDITS,
    },
  });
}

export const mutations = extendType({
  type: "Mutation",
  definition(t) {
    // --- auth ---

    /**
     * Step one of signing in: a nonce to sign.
     *
     * Wallet addresses are public, so naming one proves nothing. What proves
     * ownership is a signature over something the server picked — which is what
     * this hands out. The message comes back rendered rather than assembled by
     * the client, so what the wallet displays is exactly what gets verified.
     */
    t.nonNull.field("walletChallenge", {
      type: "WalletChallenge",
      args: { address: nonNull(stringArg()) },
      resolve: (_root, args) => {
        let address: string;
        try {
          address = normaliseAddress(args.address);
        } catch (err) {
          throw badInput(err instanceof Error ? err.message : "That is not a wallet address.");
        }
        return issueChallenge(address);
      },
    });

    /**
     * Step two: the signature, and a session if it checks out.
     *
     * The account is found or made from the wallet itself — there is no
     * registration, because there is nothing left to register. A wallet that has
     * never been here gets an account with a starting balance the first time it
     * signs in.
     */
    t.nonNull.field("walletLogin", {
      type: "AuthPayload",
      args: {
        address: nonNull(stringArg()),
        nonce: nonNull(stringArg()),
        signature: nonNull(stringArg()),
      },
      resolve: async (_root, args, ctx) => {
        // Bounded before any work: all three are caller-controlled and
        // unauthenticated, and none has a legitimate form anywhere near this
        // long. A real signature is 88 base64 characters.
        if (args.nonce.length > 128 || args.signature.length > 256) {
          throw badInput("That sign-in request could not be read.");
        }
        let address: string;
        try {
          address = normaliseAddress(args.address);
          verifyChallenge(address, args.nonce, args.signature);
        } catch (err) {
          throw badInput(err instanceof Error ? err.message : "Could not verify that wallet.");
        }

        const user = await userForWallet(ctx.prisma, address);

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
        const placed = await placeBet({
          prisma: ctx.prisma,
          userId,
          round,
          symbol: args.symbol,
          direction: args.direction,
          stake: args.stake,
        });
        if (!placed.ok) throw badInput(placed.message);

        // The stake joins the pool, which is what a price is. This is the whole
        // of the market's flow now — there is no other participant whose buying
        // could move a line — so a bet that failed to reach the book here would
        // be a bet the board never noticed.
        recordFill({
          at: placed.bet.openedAt.getTime(),
          symbol: placed.bet.symbol,
          direction: placed.bet.direction as Direction,
          size: placed.bet.stake,
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
      args: { lamports: nonNull(stringArg()), owner: nonNull(stringArg()) },
      resolve: async (_root, args, ctx) => {
        // The payer must be the wallet the account signed in with. It was an
        // open argument back when a wallet was only a payment method and an
        // account was made by an invite code — the two could legitimately
        // differ. They cannot now: the wallet *is* the account, so a purchase
        // prepared for some other one is either a mistake or a stranger's
        // transaction, and neither is worth building.
        const account = await ctx.prisma.user.findUnique({
          where: { id: callerId(ctx) },
          select: { walletAddress: true },
        });
        if (!account?.walletAddress) throw badInput("Sign in with a wallet first.");
        if (args.owner !== account.walletAddress) {
          throw badInput("That is not the wallet this account signed in with.");
        }

        let lamports: bigint;
        try {
          lamports = BigInt(args.lamports);
        } catch {
          throw badInput("That is not a whole number of lamports.");
        }
        if (lamports <= 0n) throw badInput("Enter an amount above zero.");
        try {
          return await prepareCreditPurchase({ owner: args.owner, lamports });
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




    /**
     * Sell part or all of a position, at the current bid.
     *
     * A position is a line — `(coin, direction)` — not a lot, so this is what
     * the sell panel calls and `cashOutCryptoBet` below is the special case of
     * it that names one row. Filled oldest lot first, priced once for the whole
     * clip; see `sell.ts` for why both of those are the rule.
     */
    t.nonNull.field("sellCryptoPosition", {
      type: "CryptoSale",
      args: {
        symbol: nonNull(stringArg()),
        direction: nonNull(arg({ type: "RankDirection" })),
        stake: nonNull(intArg()),
      },
      resolve: async (_root, args, ctx) => {
        const userId = callerId(ctx);
        const round = await currentRound();
        if (!round) throw badInput("That round has ended — it will settle on its own.");

        const sold = await sellPosition({
          prisma: ctx.prisma,
          userId,
          round,
          symbol: args.symbol,
          direction: args.direction,
          stake: args.stake,
          // A coin that has dropped off the board still stands where the cut
          // will score it, and the tape still quotes it there.
          rank: liveRankOf(args.symbol),
        });
        if (!sold.ok) throw badInput(sold.message);
        return sold.sale;
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
