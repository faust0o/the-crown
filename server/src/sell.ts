import type { CryptoBet, Prisma, PrismaClient } from "./generated/prisma";
import { closeCents, closeValue, unwind, type Direction } from "./market";

/**
 * Selling a position — the one path out of the book.
 *
 * The mirror of `placeBet`, and deliberately shaped like it: the same refusals
 * as values, the same one-unit transaction, the same rule that a caller cannot
 * take the quote and the write apart.
 *
 * Two things make this more than "cash out, but smaller".
 *
 * **A position is a line, not a lot.** A player who backed HIGHER three times
 * holds one position on that line, priced as one; the three rows are only the
 * order it was assembled in. So a sale names `(symbol, direction, stake)` and
 * is filled oldest-lot-first, exactly as a broker would. It is also the shape
 * the chain already uses — `place_bet` seeds one Bet PDA per
 * (round, owner, entry, direction) — so the two halves agree about what a
 * position is.
 *
 * **The clip is priced once.** `closeCents` is asked for the whole size being
 * sold, not per lot, because the sale walks the pool back down once. Pricing
 * each lot on its own would quote a better price for a position that happened
 * to be assembled in pieces, which is the same free option `closeValue`'s
 * rounding was written to close.
 */

export type SellRefusal = "BAD_STAKE" | "CLOSED" | "NO_POSITION" | "UNAVAILABLE";

export type SellOutcome =
  | { ok: true; sale: Sale }
  | { ok: false; refusal: SellRefusal; message: string };

/** What a sale is worth, and what it will be worth — the same three numbers. */
export interface Sale {
  /** Credits of position closed. Never more than is held. */
  sold: number;
  /** Credits returned for them. */
  payout: number;
  /** The price per share it leaves at, in cents. */
  cents: number;
}

/** One lot, as much of it as this sale takes, and what that fetches. */
interface Slice {
  lot: Lot;
  take: number;
  value: number;
}

/** The columns a sale needs off an open lot. */
export type Lot = Pick<
  CryptoBet,
  "id" | "stake" | "odds" | "ticker" | "startRank" | "openedAt" | "userId" | "roundId" | "symbol"
>;

const refuse = (refusal: SellRefusal, message: string): SellOutcome => ({
  ok: false,
  refusal,
  message,
});

/**
 * What selling `stake` credits of a line would fetch right now.
 *
 * Exported because the quote a player reads before selling and the payout they
 * are credited afterwards must be one calculation rather than two that agree.
 * `crypto-views.ts` documents what happens when they are not: the panel quoted
 * the resting bid while the mutation paid the size-aware one, and the number on
 * the screen was always the better of the two.
 *
 * Null when the line is not on the book. `sold` is clamped to the position, so
 * asking to sell more than is held sells all of it rather than failing.
 */
export function quoteSale(
  lots: readonly Lot[],
  symbol: string,
  direction: Direction,
  stake: number
): (Sale & { slices: Slice[] }) | null {
  const held = lots.reduce((n, l) => n + l.stake, 0);
  const sold = Math.min(Math.max(0, Math.floor(stake)), held);
  if (sold <= 0) return null;

  const cents = closeCents(symbol, direction, sold);
  if (cents == null) return null;

  const slices: Slice[] = [];
  let left = sold;
  let payout = 0;
  for (const lot of lots) {
    if (left <= 0) break;
    const take = Math.min(lot.stake, left);
    // Each lot's own odds: shares were bought at the price of the day, and it is
    // shares that are being sold. Only the bid is common to the clip.
    const value = closeValue(take, lot.odds, cents);
    slices.push({ lot, take, value });
    payout += value;
    left -= take;
  }
  return { sold, payout, cents, slices };
}

export interface SellPosition {
  prisma: PrismaClient;
  userId: string;
  round: { id: string; status: string };
  symbol: string;
  direction: Direction;
  stake: number;
  /** Where the coin stands now — recorded on what leaves, as cash-out does. */
  rank: number;
}

export async function sellPosition({
  prisma,
  userId,
  round,
  symbol,
  direction,
  stake,
  rank,
}: SellPosition): Promise<SellOutcome> {
  if (!Number.isInteger(stake) || stake <= 0) {
    return refuse("BAD_STAKE", "Sell a positive whole number of credits.");
  }
  // The same rule cash-out has always held: once the round locks there is
  // nothing to sell into, and every open position settles at the cut.
  if (round.status !== "OPEN") {
    return refuse("CLOSED", "The round is locked; positions settle at the cut.");
  }

  const lots = await prisma.cryptoBet.findMany({
    where: {
      userId,
      roundId: round.id,
      symbol,
      direction,
      status: "OPEN",
      // A position the program is holding is closed by the program. Nothing
      // writes `chainAddress` yet, and when something does, slicing its row here
      // would leave the row and the account disagreeing about one position.
      chainAddress: null,
    },
    // Oldest first. Which lot a partial sale comes out of is arbitrary — every
    // one of them holds the same claim — but it must not be *unstated*, or two
    // sales of the same size leave different positions behind.
    orderBy: { openedAt: "asc" },
  });
  if (!lots.length) return refuse("NO_POSITION", "You have no position on that line.");

  const quote = quoteSale(lots, symbol, direction, stake);
  if (!quote) return refuse("UNAVAILABLE", "That line is no longer on the book.");

  const resolvedAt = new Date();
  const sold = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    for (const { lot, take, value } of quote.slices) {
      if (take >= lot.stake) {
        // The whole lot leaves: the row itself is the sale, exactly as a full
        // cash-out writes it.
        const claimed = await tx.cryptoBet.updateMany({
          where: { id: lot.id, status: "OPEN" },
          data: { status: "CASHED_OUT", payout: value, cutRank: rank, resolvedAt },
        });
        if (claimed.count !== 1) return null;
        continue;
      }

      // Guarded on the size it was quoted against, not just on OPEN: two sales
      // racing on one lot would otherwise both fill against the same credits.
      const shrunk = await tx.cryptoBet.updateMany({
        where: { id: lot.id, status: "OPEN", stake: lot.stake },
        data: { stake: { decrement: take } },
      });
      if (shrunk.count !== 1) return null;

      await tx.cryptoBet.create({
        data: {
          parentId: lot.id,
          userId: lot.userId,
          roundId: lot.roundId,
          symbol: lot.symbol,
          ticker: lot.ticker,
          direction,
          stake: take,
          odds: lot.odds,
          startRank: lot.startRank,
          status: "CASHED_OUT",
          payout: value,
          cutRank: rank,
          // Bought when the lot was bought. The slice never prints a BUY — see
          // `parentId` — and this keeps a history sorted by age honest anyway.
          openedAt: lot.openedAt,
          resolvedAt,
        },
      });
    }

    if (quote.payout > 0) {
      await tx.user.update({
        where: { id: userId },
        data: { credits: { increment: quote.payout } },
      });
    }
    return quote.sold;
  });

  if (sold == null) {
    return refuse("NO_POSITION", "That position changed while it was being sold — try again.");
  }

  // The credits leave the pool they joined, so the mark this position moved on
  // the way in comes back off on the way out and a round trip costs the spread.
  // After the commit, not inside it: the book is in memory and cannot be rolled
  // back, so unwinding early would take a position out of the market that the
  // database still says is open.
  unwind(symbol, direction, sold);
  return { ok: true, sale: { sold, payout: quote.payout, cents: quote.cents } };
}
