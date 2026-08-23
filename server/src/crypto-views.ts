import type { Round, RoundEntry, CryptoBet } from "./generated/prisma";
import { closeCents, closeValue, marketLines, type Direction } from "./market";
import { oracle, BOARD_SIZE } from "./oracle/index";

type RoundWithEntries = Round & { entries: RoundEntry[] };

/**
 * Shape a round for the API.
 *
 * `seed` is withheld until the round is SETTLED — publishing it earlier would
 * let anyone compute the cut instant in advance, which is the whole thing the
 * commitment exists to prevent.
 */
export function toRoundView(round: RoundWithEntries) {
  // `liveRank` only means anything while the round is still running. For a
  // settled round in the results panel the board has moved on, and reporting a
  // coin's rank in today's race as its standing in a race that finished hours
  // ago is worse than reporting nothing — which is what `cutRank` is for.
  const running = round.endsAt.getTime() > Date.now();
  const board = running ? oracle.standings(BOARD_SIZE) : [];

  return {
    id: round.id,
    startsAt: round.startsAt,
    lockAt: round.lockAt,
    endsAt: round.endsAt,
    status: round.status,
    commitHash: round.commitHash,
    seed: round.status === "SETTLED" ? round.seed : null,
    cutAt: round.status === "SETTLED" ? round.cutAt : null,
    cutWindowSeconds: round.cutWindowSeconds,
    crownSymbol: round.crownSymbol,
    entries: [...round.entries]
      .sort((a, b) => a.startRank - b.startRank)
      .map((e) => ({
        symbol: e.symbol,
        ticker: e.ticker,
        // From the oracle's token record rather than the live board: a settled
        // round's coins have usually stopped trending by the time anyone opens
        // it, and borrowing the logo off `standings()` left every one of them
        // drawn as a lettered disc.
        imageUrl: oracle.metaFor(e.symbol)?.imageUrl ?? null,
        startRank: e.startRank,
        startVolume: e.startVolume,
        cutRank: e.cutRank,
        // A coin that has dropped off the board stands where the cut will score
        // it, the same place `liveRankOf` puts a position on it — not nowhere.
        liveRank: running ? liveRankOf(e.symbol, board) : null,
        // Read from the oracle's whole pool, not the visible board.
        //
        // Being pushed out of the top ten is a change of rank, not a delisting:
        // the coin is still trading and the oracle is still watching it. Sourcing
        // this from `standings(BOARD_SIZE)` meant the instant a coin dropped out
        // its row reported "$0 · —", which reads as "this market has died" when
        // what actually happened is the one thing the round is about. Its volume
        // is also the reason it dropped, so it is the number a player most needs
        // in order to judge whether it is coming back.
        liveVolume: running ? (oracle.tokenFor(e.symbol)?.volume ?? 0) : 0,
        livePrice: running ? (oracle.tokenFor(e.symbol)?.price ?? 0) : 0,
        isCrown: e.symbol === round.crownSymbol,
        lines: marketLines(round, e.symbol),
      })),
  };
}

/**
 * Where a coin in the live round is standing, for the purpose of pricing and
 * closing a position on it.
 *
 * Falling off the board is not the same as ceasing to exist. `recordCut` scores
 * a coin that has dropped out at one place below the last visible slot and the
 * tape quotes it there, which usually makes a LOWER on it a *winner* — so
 * treating it as absent left the player watching a winning position show no
 * value and refuse to close. It stands where settlement will say it stands.
 */
export function liveRankOf(symbol: string, board = oracle.standings()): number {
  return board.find((s) => s.symbol === symbol)?.rank ?? BOARD_SIZE + 1;
}

/**
 * `liveRank`/`liveValue` are what the position is standing at and worth right
 * now; null once the bet has resolved or its round is over, since there is
 * nothing left to close. `live` is passed only for a position on the round the
 * market has its book on.
 *
 * ## The value is priced at this position's size
 *
 * `closeCents(symbol, direction, stake)`, not the resting bid. The two are the
 * same number at small size and diverge sharply as the position grows, because
 * closing walks the pool back down and a big position walks it further: on a
 * fresh book, closing 50,000 credits realises 6¢ where the resting bid reads
 * 13¢ — less than half.
 *
 * This used to show the resting bid, described in this comment as "the same
 * number `cashOutCryptoBet` pays". It was not. Cash-out has always priced with
 * `closeCents` at the real stake, so the figure a player read before deciding
 * was one nobody could ever be paid, and it erred high — the direction that gets
 * someone to click. Only the largest positions were affected, which is exactly
 * why it survived: every position anyone tested was small enough to round to the
 * same cent.
 */
export function toCryptoBetView(bet: CryptoBet, live?: { rank: number }) {
  const open = bet.status === "OPEN" && live != null;
  const bid = open ? closeCents(bet.symbol, bet.direction as Direction, bet.stake) : null;
  return {
    liveRank: open ? live!.rank : null,
    liveValue: bid != null ? closeValue(bet.stake, bet.odds, bid) : null,
    id: bet.id,
    roundId: bet.roundId,
    symbol: bet.symbol,
    ticker: bet.ticker,
    direction: bet.direction,
    stake: bet.stake,
    odds: bet.odds,
    startRank: bet.startRank,
    cutRank: bet.cutRank,
    status: bet.status,
    payout: bet.payout,
    openedAt: bet.openedAt,
  };
}
