import type { Standing } from "./oracle/index";
import {
  CAP,
  FEE,
  FLOOR,
  bandDrift,
  outcomeSigma,
  probabilities,
  rankOutcomeProbability,
} from "./crypto-odds";

/**
 * The market: one book, and every price read straight off it.
 *
 * **A line's price is its share of the book.** Not a function of its share —
 * the share itself. The three outcomes on an asset are exhaustive, so the
 * credits standing behind each one, divided by the credits standing behind all
 * of them, is a probability already; that number in cents is the mark. There is
 * no coefficient anywhere between the book and the price, and nothing damps how
 * far a credit can move it. Buy a leg and it goes up by exactly what the pool
 * says, immediately.
 *
 * That leaves the round's opening auction as the only thing the model ever says
 * about price. `openRound` stakes a real pool on each line in proportion to the
 * prior, so an untouched book quotes the prior exactly, and every credit traded
 * after that dilutes it. The seeded stake is not a fudge factor standing in for
 * liquidity — it *is* the liquidity, it is denominated in credits like every
 * other number in the book, and it shows up in the depth panel like every other
 * fill.
 *
 * What protects a player who reads a move early is therefore not the pricing.
 * It is that the desks accumulate slowly at the start of a round and hard into
 * the end (see `bots.ts`), so the first credits behind a signal are few and the
 * mark barely stirs — which is exactly the window in which a player can buy it
 * cheap, and then watch the desks' own buying carry the mark up to them.
 *
 * The board's quote, the price a bet fills at, the value of an open position and
 * the depth bars all read this one place, so the views of a line cannot
 * disagree. Nothing outside this module may invent a price.
 *
 * A fill sets the whole book on its asset rather than just its own line, because
 * the three outcomes' prices are not independent — see `remark`. Every tradable
 * line is staked the moment a round opens, so no caller ever meets a line that
 * has never traded.
 */

/** A tunable, read from the environment — see the note in `bots.ts`. */
const tunable = (name: string, fallback: number): number => {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) ? raw : fallback;
};

export type Direction = "HIGHER" | "DRAW" | "LOWER";

export const DIRECTIONS = ["HIGHER", "DRAW", "LOWER"] as const;

export interface Trade {
  id: string;
  at: number;
  bot: string;
  symbol: string;
  ticker: string;
  imageUrl: string | null;
  direction: Direction;
  /** Credits staked. This is the flow that moves the price. */
  size: number;
  /** Price per share in cents at the moment it filled. */
  cents: number;
}

/**
 * How much of the fill-by-fill ledger to keep.
 *
 * Nothing renders it any more — the desks panel shows positions and depth comes
 * from the rolling aggregates below — so this is the audit trail's memory
 * budget and nothing else: roughly the last ten minutes of a round at the rate
 * the desks arrive into the cut. Trimmed in blocks rather than one entry at a
 * time, because at that rate it sits at capacity permanently and shifting the
 * whole array down to drop a single fill is a cost that only shows up under
 * exactly the load that made it necessary.
 */
const TAPE_LIMIT = tunable("MARKET_TAPE_LIMIT", 4_000);
/** Book depth counts trades inside this window. */
const BOOK_WINDOW_MS = tunable("MARKET_BOOK_WINDOW_MS", 6 * 60_000);
/** Depth is bucketed at this resolution — one bucket per tick of the desks. */
const DEPTH_BUCKET_MS = 1_000;
const DEPTH_BUCKETS = Math.max(1, Math.ceil(BOOK_WINDOW_MS / DEPTH_BUCKET_MS));

/** Prices are probabilities in cents; never 0 or 100, so a payout stays finite. */
export const FLOOR_CENTS = Math.round(FLOOR * 100);
export const CAP_CENTS = Math.round(CAP * 100);
/**
 * Half-spread around the last print, in cents. The house margin is charged on
 * the way in and again on the way out, so round-tripping a position is never
 * free — the same `FEE / 3` per leg the model has always assumed.
 */
export const SPREAD_CENTS = Math.max(1, Math.round((FEE / 3) * 100));

/**
 * How far a coin is expected to travel, in places, if the volume gap to a
 * neighbour were a certainty and the whole round were still to run. Small on
 * purpose: over one round the board shuffles by a place or two, not by five.
 */
const DRIFT_PLACES = 1.2;

/**
 * Credits the opening auction stakes across one coin's three lines.
 *
 * The only number in the pricing, and the one thing a market maker would
 * otherwise be for. In an automated market maker this is the subsidy that
 * bounds how far the first trade can move the price; here it is the same
 * quantity, denominated in credits and sitting in the book where the depth
 * panel can show it, rather than hidden in a coefficient. Split across the legs
 * in proportion to the prior, so an untouched book quotes the prior exactly.
 *
 * It sets one thing: how much a round's buying is worth against the house's
 * opening opinion. The desks put roughly twenty times this through a coin over a
 * round, so a signal they back from the start ends up owning the pool and the
 * line converges on the outcome — while the first minutes, when they are barely
 * trading, move it only a cent or two. Raise it and the board is stickier and
 * the opening prior harder to argue with; lower it and early flow swings it.
 */
const OPENING_POOL = tunable("MARKET_OPENING_POOL", 300_000);
const OPENING_DESK = "Opening Auction";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const lineKey = (symbol: string, d: Direction) => `${symbol}|${d}`;

const tape: Trade[] = [];
const lastCents = new Map<string, number>();
/** Credits bought on each line this round. The only thing that moves a price. */
const flow = new Map<string, number>();
/**
 * Credits the opening auction staked on each line — the model's entire say on
 * what it is worth, and the pool a round's buying has to out-weigh to argue.
 */
const opening = new Map<string, number>();
/**
 * The last fair value a desk brought to each asset, kept so a fill that arrives
 * without one — a player's — can still value an outcome that has no line.
 */
const lastModel = new Map<string, Partial<Record<Direction, number>>>();

/**
 * Rolling depth for one line: shares traded per bucket, plus the running sum.
 *
 * Depth used to be counted by rescanning the tape, which quietly made two
 * unrelated numbers depend on each other — how far back the panel can scroll and
 * how much traded in the last six minutes. At one print a minute per line the
 * tape covered the window several times over and nobody noticed; at one a second
 * it covers under a third of it, and `book()` reported a third of the depth
 * without any indication it was doing so. Keeping the total here decouples them,
 * and turns the book into a constant-time read at the same time.
 */
interface Depth {
  shares: Float64Array;
  total: number;
  /** Newest bucket this line has been rolled forward to. */
  bucket: number;
}
const depth = new Map<string, Depth>();

const bucketOf = (at: number) => Math.floor(at / DEPTH_BUCKET_MS);

/** Drop whatever has fallen out of the back of the window since we last looked. */
function roll(d: Depth, bucket: number): Depth {
  if (bucket <= d.bucket) return d;
  const expired = Math.min(DEPTH_BUCKETS, bucket - d.bucket);
  for (let n = 1; n <= expired; n++) {
    const i = (d.bucket + n) % DEPTH_BUCKETS;
    d.total -= d.shares[i];
    d.shares[i] = 0;
  }
  d.bucket = bucket;
  return d;
}

/** Lines this round's book is open on. A line not in here is never quoted. */
const quoted = new Set<string>();
let openRoundId: string | null = null;
let openEndsAt = 0;

/**
 * Is the market making a book right now?
 *
 * The clock is part of the answer, not just which round is on the book. A round
 * that has passed its own end has resolved — its lines are settled facts — so it
 * stops being quoted the moment it ends rather than whenever something next gets
 * around to telling the market so.
 */
function trading(): boolean {
  return openRoundId != null && Date.now() < openEndsAt;
}

/**
 * The minimum a round has to look like for the market to make a book on it.
 * Structural, not Prisma's `Round`, so the pricing can be exercised without a
 * database behind it.
 */
export interface RoundBook {
  id: string;
  startsAt: Date;
  endsAt: Date;
  /** When betting closes. Defaults to the round's end where it isn't known. */
  lockAt?: Date;
  crownSymbol: string | null;
  entries: { symbol: string; ticker: string; startRank: number }[];
}

/** Fraction of a round still to run, 0..1. */
export function remainingFraction(
  round: { startsAt: Date; endsAt: Date },
  now = Date.now()
): number {
  const total = round.endsAt.getTime() - round.startsAt.getTime();
  if (!(total > 0)) return 0;
  return clamp((round.endsAt.getTime() - now) / total, 0, 1);
}

/**
 * Expected further movement in places, positive meaning "expected to slip down
 * the board", from the coin's live volume relative to its neighbours.
 *
 * Rank is decided by volume, so the distance to the coin above and below is the
 * whole story: a coin sitting 2% under the one above is far more likely to
 * overtake it than one sitting 60% under. Expressing that as a drift on the
 * expected finishing rank — rather than as a price directly — is what lets the
 * same number keep meaning something as the clock runs out, since a coin with
 * ten seconds left cannot act on any gap at all.
 */
function volumeDrift(standing: Standing, board: Standing[]): number {
  const i = board.findIndex((s) => s.symbol === standing.symbol);
  if (i < 0) return 0; // fell off the board; there are no neighbours to close on

  const above = i > 0 ? board[i - 1] : null;
  const below = i < board.length - 1 ? board[i + 1] : null;
  const v = Math.max(1, standing.quoteVolume);

  // Fractional gap to each neighbour: 0 means level (a coin-flip to swap),
  // large means safe. Squashed so the drift saturates rather than running away.
  const squash = (gap: number) => 1 / (1 + Math.max(0, gap) * 14);
  const pUp = above ? squash((above.quoteVolume - v) / v) : 0;
  const pDown = below ? squash((v - below.quoteVolume) / Math.max(1, below.quoteVolume)) : 0;
  return pDown - pUp;
}

/**
 * Where a line *should* trade — the desks' target, and the only fair value in
 * the codebase.
 *
 * Three inputs, and it needs all three. The live volume gaps say how likely the
 * coin is to swap with a neighbour from here; its rank *now versus its start
 * rank* is the outcome the bet actually resolves against; and the time left says
 * how much of that gap can still be closed. Drop the time term and a price is
 * pinned for a whole round by `startRank` alone — the board can reshuffle
 * completely without a chip moving, and the tape ends up disagreeing with
 * settlement at the cut.
 */
export function fairCents(
  standing: Standing,
  board: Standing[],
  direction: Direction,
  startRank: number,
  remaining: number
): number {
  const r = clamp(remaining, 0, 1);
  // Two drifts, and they answer different questions. `bandDrift` is what a coin
  // starting in this band was measured to do on average and is what the book
  // opens at; `volumeDrift` is what *this* coin is doing right now. Nothing that
  // hasn't happened yet can happen in no time at all, so both fade with the
  // clock. At the open, with the coin still on its start rank and no volume gap
  // yet closed, this returns the opening print exactly — so the desks have
  // nothing to arbitrage until something actually moves.
  const expected =
    standing.rank + bandDrift(startRank, r) + volumeDrift(standing, board) * DRIFT_PLACES * r;
  const p = rankOutcomeProbability(startRank, expected, outcomeSigma(r, startRank), direction);
  return clamp(Math.round(p * 100), FLOOR_CENTS, CAP_CENTS);
}

/** Last traded price for a line, or null if the book isn't open on it. */
function priceCents(symbol: string, direction: Direction): number | null {
  return lastCents.get(lineKey(symbol, direction)) ?? null;
}

export interface Quote {
  /** Last traded price. */
  mark: number;
  /** What a taker pays to open. */
  ask: number;
  /** What a holder gets to close. */
  bid: number;
}

/**
 * The two-sided quote for a line, or null if it isn't on the book.
 *
 * Null is "there is nothing to trade here" — the crown, a leg that is
 * structurally impossible, or a round that has already ended. It is never a
 * missing price on a live line, because `openRound` prints one for every line it
 * opens the book on.
 */
export function quoteCents(symbol: string, direction: Direction): Quote | null {
  const mark = priceCents(symbol, direction);
  if (mark == null || !trading() || !quoted.has(lineKey(symbol, direction))) return null;
  return {
    mark,
    ask: clamp(mark + SPREAD_CENTS, FLOOR_CENTS, CAP_CENTS),
    bid: clamp(mark - SPREAD_CENTS, FLOOR_CENTS, CAP_CENTS),
  };
}

/**
 * Write a fill into the ledger and the depth window.
 *
 * Deliberately does *not* set a price: what a line is worth is a function of all
 * the flow on its asset, which is `remark`'s job. Use `recordFill` to trade;
 * this is the half that only remembers.
 */
export function record(trade: Trade): void {
  const line = lineKey(trade.symbol, trade.direction);

  const bucket = bucketOf(trade.at);
  let d = depth.get(line);
  if (!d) {
    d = { shares: new Float64Array(DEPTH_BUCKETS), total: 0, bucket };
    depth.set(line, d);
  }
  roll(d, bucket);
  // A print older than the whole window would otherwise land in a live bucket,
  // since the index is the timestamp modulo the ring. Nothing prints into the
  // past today; this keeps it that way.
  if (bucket > d.bucket - DEPTH_BUCKETS) {
    d.shares[bucket % DEPTH_BUCKETS] += trade.size;
    d.total += trade.size;
  }

  tape.push(trade);
  if (tape.length > TAPE_LIMIT * 2) tape.splice(0, tape.length - TAPE_LIMIT);
}

/**
 * Record a fill, and re-mark the rest of that asset's book off the same print.
 *
 * The desks only ever trade the leg the projection favours, so on its own
 * `record` would leave the other two frozen at their opening print while fair
 * value walked away from them. That is not cosmetic: a player holding a *losing*
 * position could close it at a mark the round had already disproved, and two of
 * the three chips on the board would stop meaning anything.
 *
 * The three outcomes are mutually exclusive and exhaustive, so their prices were
 * never independent — they sum to a hundred. What the fill did not take, the
 * remaining legs share in proportion to what is staked on them. `model` is every
 * leg's fair value, needed only to value an outcome that is real but has no line;
 * a desk has it to hand because it computed it to pick a side. A player has not,
 * and passes nothing — the asset's last one is remembered here and reused, which
 * is only ever the crown's or a structurally-closed leg's share of the hundred.
 */
export function recordFill(trade: Trade, model?: Partial<Record<Direction, number>>): void {
  record(trade);
  const line = lineKey(trade.symbol, trade.direction);
  flow.set(line, (flow.get(line) ?? 0) + Math.max(0, trade.size));
  if (model) lastModel.set(trade.symbol, model);
  remark(trade.symbol, model ?? lastModel.get(trade.symbol) ?? {});
}

/**
 * What one coin's tradable outcomes are worth between them, and what is staked
 * on each — everything `remark` needs, and everything a fill has to be priced
 * against. Shared so that quoting a trade and booking it cannot drift apart.
 */
function poolOf(symbol: string, model: Partial<Record<Direction, number>>) {
  let pool = 0;
  let elsewhere = 0;
  const staked = {} as Record<Direction, number>;
  for (const direction of DIRECTIONS) {
    const line = lineKey(symbol, direction);
    if (quoted.has(line)) {
      staked[direction] = (opening.get(line) ?? 0) + (flow.get(line) ?? 0);
      pool += staked[direction];
    } else {
      staked[direction] = 0;
      elsewhere += clamp(model[direction] ?? 0, 0, 100);
    }
  }
  return { staked, pool, target: clamp(100 - elsewhere, 0, 100) };
}

/**
 * The average mark paid while a trade of `stake` credits walks the pool from
 * `held`/`pool` to `held + stake`/`pool + stake`.
 *
 * A mark is `target * held / pool`, so the price is not constant across a fill —
 * it is the curve the trade itself moves along, and the honest price for the
 * whole clip is its average:
 *
 *     (1/s) ∫₀ˢ target * (held + u) / (pool + u) du
 *          = target * (1 + ((held - pool) / s) * ln((pool + s) / pool))
 *
 * This is the difference between a market and a gift. Quoting the mark *before*
 * a fill and then letting the fill move it hands the whole of its own impact to
 * whoever placed it: a big enough clip printed at the old price and was worth
 * more than it cost the instant it landed, so buying and immediately closing was
 * free money. Charging the average means a trade pays for the room it takes, and
 * because the same curve is walked back on the way out, a round trip costs the
 * spread and nothing else — whatever its size.
 */
function averageMark(held: number, pool: number, target: number, stake: number): number {
  if (!(pool > 0)) return 0;
  if (!(stake > 0)) return (target * held) / pool;
  const p = target * (1 + ((held - pool) / stake) * Math.log((pool + stake) / pool));
  return clamp(p, 0, 100);
}

/**
 * What a stake actually fills at on this line, in cents — the ask a bet is
 * written at, inclusive of the price its own size moves the book through.
 *
 * Null when the line is not on the book, exactly as `quoteCents`.
 */
export function fillCents(symbol: string, direction: Direction, stake: number): number | null {
  if (!quoteCents(symbol, direction)) return null;
  const { staked, pool, target } = poolOf(symbol, lastModel.get(symbol) ?? {});
  const avg = averageMark(staked[direction], pool, target, Math.max(0, stake));
  return clamp(Math.round(avg) + SPREAD_CENTS, FLOOR_CENTS, CAP_CENTS);
}

/**
 * What closing `stake` credits of a position fills at, in cents — the bid, over
 * the same stretch of curve the opening trade walked up.
 *
 * Deliberately the mirror of `fillCents`: the average is taken over the interval
 * the pool is about to move back down through, which is the identical integral.
 * So the two agree to the cent before the spread is applied, and the spread is
 * the entire cost of a round trip at any size.
 */
export function closeCents(symbol: string, direction: Direction, stake: number): number | null {
  if (!quoteCents(symbol, direction)) return null;
  const { staked, pool, target } = poolOf(symbol, lastModel.get(symbol) ?? {});
  const size = clamp(stake, 0, Math.min(staked[direction], pool - 1));
  const avg = averageMark(staked[direction] - size, pool - size, target, size);
  return clamp(Math.round(avg) - SPREAD_CENTS, FLOOR_CENTS, CAP_CENTS);
}

/**
 * How many credits it takes to close `fraction` of the gap between what a line
 * is marked at and `fairCents`.
 *
 * The pricing rule run backwards. `m = target * (held + x) / (pool + x)` solves
 * to `x = (m * pool - target * held) / (target - m)`, which is what lets a desk
 * trade *to a price* rather than trade a size and hope: it asks what correcting
 * a mispricing costs and buys exactly that.
 *
 * Takes the fraction rather than a target price on purpose. A caller working
 * from the quoted mark is working from an integer that has already been rounded
 * and largest-remaindered, and a target derived from it lands on the wrong side
 * of the true pool share about half the time — asking for a move the book has
 * already made, which solves to zero credits. The desks bought nothing for the
 * first third of a round that way, on lines that were sixty cents mispriced.
 * Everything here is computed from the unrounded share instead.
 */
export function creditsToClose(
  symbol: string,
  direction: Direction,
  fairCents: number,
  fraction: number
): number {
  const { staked, pool, target } = poolOf(symbol, lastModel.get(symbol) ?? {});
  if (!(pool > 0) || !(target > 0)) return 0;

  const now = (target * staked[direction]) / pool;
  const wanted = now + (clamp(fairCents, 0, target) - now) * clamp(fraction, 0, 1);
  // Leave a cent of headroom: a leg cannot own the whole book, and the solve
  // divides by what is left of it.
  const m = clamp(wanted, 0, target - 1);
  if (!(m > now)) return 0; // already there, or past it — nothing to buy
  return Math.max(0, (m * pool - target * staked[direction]) / (target - m));
}

/**
 * Take a position back out of the pool when it is closed early.
 *
 * The inverse of the buy, and it has to exist. A mark is a line's share of the
 * credits behind its coin, so buying moves it up; if closing did not move it
 * back down, a large enough position could bid its own line up, sell into the
 * bid it had just created and book the difference. Removing exactly what was
 * staked makes the round trip cost precisely the spread, which is the price the
 * design puts on it.
 */
export function unwind(symbol: string, direction: Direction, stake: number): void {
  const line = lineKey(symbol, direction);
  flow.set(line, Math.max(0, (flow.get(line) ?? 0) - Math.max(0, stake)));
  remark(symbol, lastModel.get(symbol) ?? {});
}

/**
 * Re-derive every mark on an asset from the credits standing behind it.
 *
 * A leg's weight is simply what is staked on it — the pool the opening auction
 * seeded, plus every credit bought since. The marks are those weights as
 * percentages of the asset's whole pool. That is the entire pricing rule: no
 * coefficient, no exponent, no scale to calibrate. Buying a leg raises it and
 * lowers the others by exactly what it gained, the book always sums to a
 * hundred, and nothing can leave `[FLOOR_CENTS, CAP_CENTS]`.
 *
 * Because the divisor is the pool rather than a constant, a credit's effect is
 * largest when there is least behind the asset and shrinks as the book fills —
 * which is the right way round, and is why the first credits of a round matter
 * more per credit than the last. Nothing else about a line's history enters.
 *
 * Reversible, which is the property that makes a hedge mean something: the desks
 * can only buy, never sell, but when a signal flips and they start buying the
 * opposite leg, that leg's share overtakes and the first one comes back down.
 *
 * A leg that is live but not on the book still owns its share of the hundred, at
 * what the model says it is worth — the outcome a coin that opened last gets
 * when it falls off the board is real even though nobody could bet it. Leaving
 * it out of the normalisation hands its probability to whichever line is left,
 * and marks a losing leg *up*. That share is the one number here quoted in cents
 * rather than credits, since there is no pool behind an outcome nobody can back;
 * it is taken out of the hundred before the pool divides up what remains.
 */
function remark(symbol: string, model: Partial<Record<Direction, number>>): void {
  const { staked, pool, target: exactTarget } = poolOf(symbol, model);
  if (!(pool > 0)) return;

  const open = DIRECTIONS.filter((direction) => quoted.has(lineKey(symbol, direction)));
  const target = Math.round(exactTarget);
  const exact = open.map((direction) => (target * staked[direction]) / pool);
  const cents = exact.map((v) => Math.floor(v));

  // Largest-remainder, so the book adds up to the target rather than to the
  // target plus rounding dust.
  const spare = target - cents.reduce((sum, c) => sum + c, 0);
  [...exact.keys()]
    .sort((a, b) => exact[b] - cents[b] - (exact[a] - cents[a]))
    .slice(0, Math.max(0, spare))
    .forEach((i) => (cents[i] += 1));

  // Bounds beat the sum: a leg outside them prices a payout that is infinite or
  // worthless, which is the one thing FLOOR and CAP exist to prevent. Whatever
  // the clamp costs is pushed into a leg with room, largest first, so the shape
  // survives and the total still holds wherever it can.
  const bounded = cents.map((c) => clamp(c, FLOOR_CENTS, CAP_CENTS));
  let drift = bounded.reduce((sum, c) => sum + c, 0) - target;
  for (let guard = 0; drift !== 0 && guard < 300; guard++) {
    const step = drift > 0 ? -1 : 1;
    const order = [...bounded.keys()].sort((a, b) =>
      step < 0 ? bounded[b] - bounded[a] : bounded[a] - bounded[b]
    );
    const i = order.find(
      (j) => bounded[j] + step >= FLOOR_CENTS && bounded[j] + step <= CAP_CENTS
    );
    if (i === undefined) break; // nowhere left to put it; the bounds win
    bounded[i] += step;
    drift += step;
  }

  open.forEach((direction, i) => lastCents.set(lineKey(symbol, direction), bounded[i]));
}

/**
 * The raw ledger, newest first — every fill, exactly as it happened.
 *
 * Deliberately kept even though nothing serves it: what a desk *holds* is a
 * different question from what *traded*, and collapsing the second into the
 * first for the panel's sake must not mean losing it. This is the record that
 * says a price was reached by trading rather than by assertion.
 */
export function recentTrades(limit = 40, symbol?: string): Trade[] {
  const rows = symbol ? tape.filter((t) => t.symbol === symbol) : tape;
  return rows.slice(-limit).reverse();
}

export interface BookLevel {
  direction: Direction;
  cents: number;
  /** Shares traded on this line inside the book window. */
  size: number;
}

/**
 * Depth for one coin, off the same fills that set its price.
 *
 * This is traded interest, not resting orders — there is no matching engine
 * here — but it is real flow rather than the seeded noise the client used to
 * draw, so the bars move when the market does. The price on each level is the
 * ask, i.e. the identical number the board shows and a bet fills at.
 *
 * Read from the rolling aggregate rather than by scanning the tape: the client
 * polls this every two seconds per open coin, and a scan is the one thing here
 * whose cost grows with how hard the desks are trading.
 */
export function book(symbol: string): BookLevel[] {
  const bucket = bucketOf(Date.now());
  return DIRECTIONS.map((direction) => {
    const d = depth.get(lineKey(symbol, direction));
    return {
      direction,
      cents: quoteCents(symbol, direction)?.ask ?? 0,
      size: d ? Math.max(0, Math.round(roll(d, bucket).total)) : 0,
    };
  });
}

export interface Line {
  direction: Direction;
  probability: number;
  /** What a winning unit stake returns, stake included. */
  multiplier: number;
  /** Price per share in cents — the ask. */
  cents: number;
  available: boolean;
}

const closedLine = (direction: Direction): Line => ({
  direction,
  probability: 0,
  multiplier: 0,
  cents: 0,
  available: false,
});

/**
 * The three lines for one coin, quoted off the tape.
 *
 * A round the market isn't making a book on — anything already settled, which is
 * every round in the results panel — comes back closed rather than borrowing the
 * live round's prices. Those rounds resolved; there is nothing left to quote.
 */
export function marketLines(round: { id: string }, symbol: string): Line[] {
  const live = trading() && round.id === openRoundId;
  return DIRECTIONS.map((direction) => {
    const q = live ? quoteCents(symbol, direction) : null;
    if (!q) return closedLine(direction);
    return {
      direction,
      probability: q.mark / 100,
      multiplier: 100 / q.ask,
      cents: q.ask,
      available: true,
    };
  });
}

/**
 * What closing an open position pays right now.
 *
 * The stake bought `stake * odds` shares at entry; each pays one credit if the
 * bet lands. They're worth the tape's bid apiece — the last print less the same
 * margin charged on the way in, so a round trip always costs the spread.
 *
 * Rounded down, not to nearest. On a small stake the spread is worth less than
 * half a credit, and rounding to nearest handed it straight back: 1129 of the
 * (mark, stake) pairs this book can quote — every stake up to 47 at a 94c mark
 * among them — opened and closed for exactly what they cost. Never a profit, but
 * a free option is still an option, and the design says a round trip is not one.
 */
export function closeValue(stake: number, odds: number, bidCents: number): number {
  const shares = stake * odds;
  return Math.max(0, Math.floor((shares * clamp(bidCents, 0, 100)) / 100));
}

/**
 * Open the book for a round: seed every tradable line with an opening print.
 *
 * Idempotent, and the only place the book's membership is decided. Two lines
 * never open. The crown is closed outright — rank 1 over a round resolves as a
 * near-certain DRAW, which mostly rewards knowing which coin trades the most,
 * and taking the wearer off the book leaves the interesting bet intact: backing
 * the challenger at rank 2 to go HIGHER *is* betting the crown changes hands.
 * The other is structural, from the model: a coin that opened at rank 1 cannot
 * finish HIGHER, and one that opened last cannot finish LOWER.
 *
 * A new round wipes the tape and every credit of accumulated flow. Prices are
 * quoted against *this* round's start ranks, so carrying yesterday's buying
 * forward would price the wrong bet.
 */
export function openRound(round: RoundBook): void {
  if (round.id === openRoundId) return;
  if (round.endsAt.getTime() <= Date.now()) return;

  openRoundId = round.id;
  openEndsAt = round.endsAt.getTime();
  tape.length = 0;
  lastCents.clear();
  quoted.clear();
  depth.clear();
  flow.clear();
  opening.clear();
  lastModel.clear();

  // Printed at "now" rather than at the round's start: the process may have come
  // up mid-round, and a print timestamped before the book window would leave the
  // depth bars empty for a line that demonstrably has a price.
  const at = Date.now();
  const fieldSize = round.entries.length;

  for (const entry of round.entries) {
    if (entry.symbol === round.crownSymbol) continue;
    const prior = probabilities(entry.symbol, entry.startRank, fieldSize);
    for (const direction of DIRECTIONS) {
      const p = { HIGHER: prior.higher, DRAW: prior.draw, LOWER: prior.lower }[direction];
      if (!(p > 0)) continue;
      // The two legs that never open, and they are closed for different reasons.
      // A coin that started first cannot finish HIGHER at all — the prior has
      // already moved that mass onto the outcomes that can happen. A coin that
      // started last *can* finish LOWER, by falling off the board, but the round
      // does not offer the bet; its share stays with the outcome and simply has
      // no line, which `remark` prices off the model.
      if (direction === "LOWER" && entry.startRank >= fieldSize) continue;
      const line = lineKey(entry.symbol, direction);
      const cents = clamp(Math.round(p * 100), FLOOR_CENTS, CAP_CENTS);
      quoted.add(line);
      // The auction's stake on this line: credits, in proportion to the prior.
      // This is the model's one and only word on price — from here the mark is
      // this pool's share of the coin's, and every credit traded dilutes it.
      const staked = Math.max(1, Math.round(OPENING_POOL * p));
      opening.set(line, staked);
      lastCents.set(line, cents);
      record({
        id: `open-${round.id}-${entry.symbol}-${direction}`,
        at,
        bot: OPENING_DESK,
        symbol: entry.symbol,
        ticker: entry.ticker,
        imageUrl: null,
        direction,
        size: staked,
        cents,
      });
    }
  }
}

/**
 * Take the book down: there is no live round to make a price on.
 *
 * `openRound` hands the book straight from one round to the next, but a round
 * can also end without a successor — the oracle goes cold, or the next slot
 * already holds a finished round and the market waits for the boundary after it.
 * Nothing used to clear `openRoundId` in that case, so the market went on
 * quoting a round that had already resolved: the depth panel showed live prices
 * and every line in the results panel came back `available`. The tape is left
 * alone — it is the log of what traded — and only the quoting stops.
 */
export function closeBook(): void {
  openRoundId = null;
  openEndsAt = 0;
  quoted.clear();
}

/** Test seam — the tape is process-local and deliberately not persisted. */
export function resetMarket(): void {
  tape.length = 0;
  lastCents.clear();
  flow.clear();
  opening.clear();
  lastModel.clear();
  quoted.clear();
  depth.clear();
  openRoundId = null;
  openEndsAt = 0;
}
