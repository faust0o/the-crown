import type { CryptoBet, PrismaClient, Round, RoundEntry } from "./generated/prisma";
import { fillCents, marketLines, type Direction } from "./market";

/**
 * Placing a bet — the one path, used by players and desks alike.
 *
 * The desks bet real credits out of real accounts now, and the only way that is
 * honest is if they go through exactly what a player goes through: the same
 * checks, the same quote off the same tape, the same atomic debit. Anything the
 * desks got to skip would be a thumb on the scale, and anything a player is
 * refused for the desks must be refused for too.
 *
 * Refusals come back as values rather than exceptions. The mutation turns them
 * into messages; a desk that cannot afford a clip simply does not place one, and
 * needs that to be an ordinary Tuesday rather than a thrown error inside a
 * timer.
 */

export type RoundWithEntries = Round & { entries: RoundEntry[] };

export type Refusal =
  | "BAD_STAKE"
  | "CLOSED"
  | "NOT_IN_ROUND"
  | "CROWN"
  | "UNAVAILABLE"
  | "INSUFFICIENT";

export type BetOutcome =
  | { ok: true; bet: CryptoBet; cents: number }
  | { ok: false; refusal: Refusal; message: string };

const refuse = (refusal: Refusal, message: string): BetOutcome => ({
  ok: false,
  refusal,
  message,
});

export interface PlaceBet {
  prisma: PrismaClient;
  userId: string;
  round: RoundWithEntries;
  symbol: string;
  direction: Direction;
  stake: number;
}

export async function placeBet({
  prisma,
  userId,
  round,
  symbol,
  direction,
  stake,
}: PlaceBet): Promise<BetOutcome> {
  if (!Number.isInteger(stake) || stake <= 0) {
    return refuse("BAD_STAKE", "Stake must be a positive whole number of credits.");
  }
  if (round.status !== "OPEN" || Date.now() >= round.lockAt.getTime()) {
    return refuse("CLOSED", "Betting is closed for this round.");
  }

  const entry = round.entries.find((e) => e.symbol === symbol);
  if (!entry) return refuse("NOT_IN_ROUND", "That coin is not in this round.");

  if (round.crownSymbol === entry.symbol) {
    return refuse(
      "CROWN",
      `${entry.ticker} is wearing the crown — you can't bet on the reigning coin. Back a challenger to take it.`
    );
  }

  // Fills at the price this stake walks the book through, not at the mark it
  // found on arrival. The board quotes the latter because that is what the next
  // credit pays; a clip large enough to move the pool pays its own way up, and
  // billing it at the pre-trade mark handed it the whole of its own impact —
  // buy big, close immediately, keep the difference.
  const line = marketLines(round, entry.symbol).find((l) => l.direction === direction);
  if (!line?.available) {
    return refuse("UNAVAILABLE", "That outcome is not available for this coin.");
  }
  const cents = fillCents(entry.symbol, direction, stake);
  if (cents == null) {
    return refuse("UNAVAILABLE", "That outcome is not available for this coin.");
  }

  // Debit inside the transaction and only if the balance actually covers it, so
  // two concurrent bets can't both spend the same credits — and so a desk can
  // never bet itself negative no matter how its ramp sized the clip.
  const bet = await prisma.$transaction(async (tx) => {
    const debited = await tx.user.updateMany({
      where: { id: userId, credits: { gte: stake } },
      data: { credits: { decrement: stake } },
    });
    if (debited.count !== 1) return null;

    return tx.cryptoBet.create({
      data: {
        userId,
        roundId: round.id,
        symbol: entry.symbol,
        ticker: entry.ticker,
        direction,
        stake,
        odds: 100 / cents,
        startRank: entry.startRank,
      },
    });
  });

  if (!bet) return refuse("INSUFFICIENT", "Not enough credits.");
  return { ok: true, bet, cents };
}
