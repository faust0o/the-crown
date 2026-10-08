import type { CryptoBet, PrismaClient, Round, RoundEntry } from "./generated/prisma";
import { fillCents, marketLines, type Direction } from "./market";

/**
 * Placing a bet — the one path into the book.
 *
 * Every credit that has ever moved a price on this board came through here. The
 * checks, the quote and the debit are one unit and stay one unit: a caller that
 * could take any of them separately could bet money it does not have, or bet it
 * at a price the book never offered.
 *
 * Refusals come back as values rather than exceptions. The mutation turns them
 * into messages, and a refusal is an ordinary answer rather than a failure —
 * "not enough credits" is a thing a player does several times an evening.
 */

export type RoundWithEntries = Round & { entries: RoundEntry[] };

export type Refusal =
  | "BAD_STAKE"
  | "CLOSED"
  | "NOT_IN_ROUND"
  | "CROWN"
  | "UNAVAILABLE"
  | "PRICE_MOVED"
  | "INSUFFICIENT";

export type BetOutcome =
  | { ok: true; bet: CryptoBet; cents: number }
  | { ok: false; refusal: Refusal; message: string };

const refuse = (refusal: Refusal, message: string) => ({ ok: false as const, refusal, message });

/**
 * What a winning stake returns, stake included — one credit per share.
 *
 * Settlement pays exactly this, and the ticket quotes exactly this, so the two
 * are one function rather than two copies of the same rounding.
 */
export const winnings = (stake: number, odds: number): number => Math.round(stake * odds);

/** What a stake would fill at right now, and what it pays if it lands. */
export interface BetQuote {
  /** The price the whole stake fills at, in cents — the ask after its own impact. */
  cents: number;
  /** What a win returns, stake included. */
  payout: number;
}

export interface QuoteBet {
  round: RoundWithEntries;
  symbol: string;
  direction: Direction;
  stake: number;
}

type Priced =
  | { ok: true; entry: RoundEntry; cents: number }
  | { ok: false; refusal: Refusal; message: string };

/**
 * Every check a bet has to pass, and the price it fills at — shared by the
 * quote and the bet so the number on the ticket and the number in the row
 * cannot come from two different places.
 */
function price({ round, symbol, direction, stake }: QuoteBet): Priced {
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
  return { ok: true, entry, cents };
}

/**
 * What `stake` on this line would fill at and pay, or null if it would be
 * refused.
 *
 * The ticket's "to win" has to come from here rather than from the board's
 * price. The board quotes what the *next* credit pays; a stake that is large
 * against the pool walks the line up as it fills and pays the average of that
 * walk. Multiplying the board price by the stake promised a 10,000 clip on a
 * 17¢ line nearly 60,000 when it filled at 71¢ and paid 14,000.
 */
export function quoteBet(args: QuoteBet): BetQuote | null {
  const priced = price(args);
  if (!priced.ok) return null;
  return { cents: priced.cents, payout: winnings(args.stake, 100 / priced.cents) };
}

export interface PlaceBet extends QuoteBet {
  prisma: PrismaClient;
  userId: string;
  /**
   * The worst price this bet will accept, in cents — what the ticket quoted.
   *
   * The quote is a poll, and the book can move between it and the tap: anyone
   * else's bet on the same coin re-marks every line on it. Without a bound the
   * bet fills at whatever it finds and pays less than the ticket said. The
   * chain's `place_bet` takes the same bound as `max_cents`.
   */
  maxCents?: number | null;
}

export async function placeBet({
  prisma,
  userId,
  round,
  symbol,
  direction,
  stake,
  maxCents,
}: PlaceBet): Promise<BetOutcome> {
  const priced = price({ round, symbol, direction, stake });
  if (!priced.ok) return priced;
  const { entry, cents } = priced;
  if (maxCents != null && cents > maxCents) {
    return refuse(
      "PRICE_MOVED",
      `The price moved to ${cents}¢ since your ticket was quoted — check the payout and buy again.`
    );
  }

  // Debit inside the transaction and only if the balance actually covers it, so
  // two concurrent bets can't both spend the same credits.
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
