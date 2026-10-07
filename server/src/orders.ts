import type { Direction } from "./market";
import { oracle } from "./oracle/index";
import { prisma } from "./prisma";

/**
 * The orders panel: what the room is actually betting, as it happens.
 *
 * This replaced a tape of simulated desks, and the replacement is the point. The
 * board's prices are now moved by players and by nothing else, so the honest
 * thing to show beside them is the flow that moved them — every bet opened and
 * every position closed in the live round, newest first, with the handle that
 * placed it.
 *
 * **Read from `CryptoBet` rather than from a ring in memory.** The rows are the
 * ledger: they are what settlement pays, what the portfolio shows and what the
 * pool priced, so a panel built on them cannot disagree with any of those, and
 * it survives a restart with the round intact. The alternative — mirroring each
 * fill into a process-local buffer as it happens — is a second copy of the same
 * facts, and a second copy is a thing that can drift.
 *
 * One bet is up to two orders. A `CryptoBet` row is opened once and may be
 * closed once, and those are two different moments at two different prices; a
 * feed that showed only the open would report a market in which nobody ever took
 * profit. So an open prints a BUY at the price the stake filled at, and a
 * cash-out prints a SELL at the price it left at — derived from the payout the
 * row was actually credited, not re-quoted now, because what the panel claims
 * happened has to be what happened.
 */

export type OrderKind = "BUY" | "SELL";

export interface Order {
  id: string;
  at: number;
  /** The player's pseudonymous handle. There are no other participants. */
  handle: string;
  symbol: string;
  ticker: string;
  imageUrl: string | null;
  direction: Direction;
  kind: OrderKind;
  /** Credits staked, for a BUY; credits returned, for a SELL. */
  credits: number;
  /** Price per share in cents, on the same scale as `RankLine.cents`. */
  cents: number;
  /**
   * Profit or loss on a SELL, against what the position cost. Null on a BUY,
   * where there is nothing yet to have made or lost.
   */
  pnl: number | null;
}

/**
 * How long a read may be reused.
 *
 * The panel polls in seconds and every viewer polls the same query, so without
 * this the orders feed is the busiest thing in the database — two round trips
 * per viewer per tick for rows that change a handful of times a minute. A second
 * of staleness is invisible on a feed of human-placed bets and is the difference
 * between one query and a hundred.
 */
const CACHE_MS = 1_000;
let cache: { until: number; rows: Order[] } | null = null;

/** How long the feed may reuse the round it last read. */
const ROUND_CACHE_MS = 5_000;
let cachedRound: { until: number; roundId: string | null } | null = null;

/**
 * The round the book is on, read-only.
 *
 * Deliberately not `currentRound()`: that one opens rounds and opens the book as
 * a side effect, and a panel refreshing every couple of seconds is the last
 * thing that should be able to advance the game's clock. A round that has
 * already ended is never served from the cache, and a null is cached too — the
 * gap between rounds would otherwise be the busiest the database ever gets.
 */
async function liveRound(): Promise<string | null> {
  const now = Date.now();
  if (cachedRound && now < cachedRound.until) return cachedRound.roundId;

  const round = await prisma.round.findFirst({
    where: { endsAt: { gt: new Date(now) } },
    orderBy: { startsAt: "desc" },
    select: { id: true },
  });
  cachedRound = { until: now + ROUND_CACHE_MS, roundId: round?.id ?? null };
  return round?.id ?? null;
}

/**
 * The price a stake filled at, from the odds the row locked in.
 *
 * `placeBet` stores `odds = 100 / cents`, so this is that arithmetic run
 * backwards. Recomputing it from the row rather than storing a second column
 * means the panel and the payout can never quote different entries for one bet.
 */
const entryCents = (odds: number): number =>
  odds > 0 ? Math.max(1, Math.min(100, Math.round(100 / odds))) : 0;

/**
 * The price a position was closed at, from what it was credited.
 *
 * `closeValue` floors `shares * bid / 100`, so this inverts it to the nearest
 * cent. Quoting the line's *current* bid instead would be a different and worse
 * number: the panel would say a position sold at a price it never saw, and would
 * keep changing what it said about a trade that is over.
 */
function exitCents(stake: number, odds: number, payout: number): number {
  const shares = stake * odds;
  if (!(shares > 0)) return 0;
  return Math.max(0, Math.min(100, Math.round((payout * 100) / shares)));
}

/**
 * The live round's orders, newest first.
 *
 * Cached, because every viewer polls this same question every couple of seconds
 * and the answer changes a handful of times a minute.
 */
export async function orders(limit = 40): Promise<Order[]> {
  if (cache && Date.now() < cache.until) return cache.rows.slice(0, limit);

  const roundId = await liveRound();
  if (!roundId) return [];

  const rows = await ordersForRound(roundId, limit);
  cache = { until: Date.now() + CACHE_MS, rows };
  return rows.slice(0, limit);
}

/**
 * One round's orders, newest first — the query, without the question of which
 * round is live.
 *
 * Two queries rather than one, and they are not the same query with a different
 * sort. Opens are recent by `openedAt` and closes by `resolvedAt`, so a single
 * ordering would drop a cash-out of a bet placed at the top of the round —
 * exactly the trade a feed of activity most wants to show.
 *
 * Desk accounts are excluded. Nothing creates them any more, but rows they
 * placed before the desks were removed still sit in old rounds, and a feed
 * captioned as the room's betting must not quietly include a bot's.
 */
export async function ordersForRound(roundId: string, limit = 40): Promise<Order[]> {
  const select = {
    id: true,
    symbol: true,
    ticker: true,
    direction: true,
    stake: true,
    odds: true,
    payout: true,
    openedAt: true,
    resolvedAt: true,
    user: { select: { handle: true } },
  } as const;

  // The cap is per query and the panel shows the merge of both, so each is asked
  // for a full panel's worth: a round in which everybody is closing must not
  // push every open off the feed, and the reverse.
  const take = Math.max(1, Math.min(200, limit));
  const [opened, closed, sliced] = await Promise.all([
    prisma.cryptoBet.findMany({
      // `parentId: null` keeps partial sales out of the BUY side. A slice is a
      // row carved off a lot when part of it was sold — it is the SELL below,
      // and nobody ever bought it as its own trade.
      where: { roundId, user: { isDesk: false }, parentId: null },
      orderBy: { openedAt: "desc" },
      take,
      select,
    }),
    prisma.cryptoBet.findMany({
      where: {
        roundId,
        user: { isDesk: false },
        status: "CASHED_OUT",
        resolvedAt: { not: null },
      },
      orderBy: { resolvedAt: "desc" },
      take,
      select,
    }),
    // What has since been sold out of each lot.
    //
    // A partial sale shrinks the lot it came from, so `stake` on a surviving row
    // is what is *still open* rather than what was bought — and a feed is a
    // record of what happened, so a BUY printed at 200 must still read 200 after
    // 50 of it is sold. Adding the slices back is what keeps that true without a
    // second column that could drift from the rows it describes.
    prisma.cryptoBet.groupBy({
      by: ["parentId"],
      where: { roundId, parentId: { not: null } },
      _sum: { stake: true },
    }),
  ]);
  const soldOut = new Map(sliced.map((s) => [s.parentId!, s._sum.stake ?? 0]));

  const common = (bet: (typeof opened)[number]) => ({
    handle: bet.user.handle,
    symbol: bet.symbol,
    ticker: bet.ticker,
    // From the token record rather than the live board: a round's entry can fall
    // out of the trending pool mid-round, and `standings()` no longer holds it —
    // which drew exactly those rows, and only sometimes, as lettered discs. The
    // ticker comes off the bet, which recorded the round's own at placement.
    imageUrl: oracle.metaFor(bet.symbol)?.imageUrl ?? null,
    direction: bet.direction as Direction,
  });

  const rows: Order[] = [
    ...opened.map((bet) => ({
      ...common(bet),
      id: `${bet.id}:open`,
      at: bet.openedAt.getTime(),
      kind: "BUY" as const,
      credits: bet.stake + (soldOut.get(bet.id) ?? 0),
      cents: entryCents(bet.odds),
      pnl: null,
    })),
    ...closed.map((bet) => ({
      ...common(bet),
      id: `${bet.id}:close`,
      at: bet.resolvedAt!.getTime(),
      kind: "SELL" as const,
      credits: bet.payout,
      cents: exitCents(bet.stake, bet.odds, bet.payout),
      pnl: bet.payout - bet.stake,
    })),
  ].sort((a, b) => b.at - a.at);

  return rows.slice(0, limit);
}
