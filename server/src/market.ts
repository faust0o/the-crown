import { CAP, FEE, FLOOR, probabilities } from "./crypto-odds";

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
 * about price. `openRound` stakes a pool on each line in proportion to the
 * prior, so an untouched book quotes the prior exactly, and every credit traded
 * after that dilutes it. The seeded stake is not a fudge factor standing in for
 * liquidity — it *is* the liquidity, it is denominated in credits like every
 * other number in the book, and it shows up in the depth panel like every other
 * fill.
 *
 * **Players are the only flow.** There is no market maker behind the board and
 * no model chasing it: after the opening print, a line moves when somebody backs
 * it and at no other time. A line nobody trades sits at its opening prior all
 * round, and a line the room is wrong about stays wrong until somebody takes the
 * other side — which is the trade being offered, and the reason reading the
 * board early is worth anything.
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

/**
 * A tunable, read from the environment.
 *
 * Falls back rather than trusting `Number`: a typo in an env var yields NaN,
 * which propagates silently through the arithmetic until every price is NaN and
 * nothing anywhere says why.
 */
const tunable = (name: string, fallback: number): number => {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) ? raw : fallback;
};

export type Direction = "HIGHER" | "DRAW" | "LOWER";

export const DIRECTIONS = ["HIGHER", "DRAW", "LOWER"] as const;

/**
 * A fill: credits joining or leaving a line, and when.
 *
 * Everything the pricing needs and nothing more. What *else* is true of a bet —
 * whose it was, what it filled at, whether it is still open — is a `CryptoBet`
 * row, and the orders panel reads it there rather than from a second copy kept
 * here. There is one ledger.
 */
export interface Fill {
  at: number;
  symbol: string;
  direction: Direction;
  /** Credits staked. This is the flow that moves the price. */
  size: number;
}

/**
 * How far back the depth bars count.
 *
 * A round, near enough. It used to be six minutes, which was the right window
 * when eight desks printed every second and the wrong one the moment they
 * stopped: real players arrive a few times a minute between them, so a six
 * minute window showed an empty book on a coin that had genuinely traded all
 * round. Depth is now the round's traded interest, which is the honest thing for
 * it to be when the round's traded interest is all there is.
 */
const BOOK_WINDOW_MS = tunable("MARKET_BOOK_WINDOW_MS", 30 * 60_000);
/** Depth is bucketed at this resolution. */
const DEPTH_BUCKET_MS = tunable("MARKET_DEPTH_BUCKET_MS", 5_000);
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
 * Credits the opening auction stakes across one coin's three lines.
 *
 * The only number in the pricing, and the one thing a market maker would
 * otherwise be for. In an automated market maker this is the subsidy that
 * bounds how far the first trade can move the price; here it is the same
 * quantity, denominated in credits and sitting in the book where the depth
 * panel can show it, rather than hidden in a coefficient. Split across the legs
 * in proportion to the prior, so an untouched book quotes the prior exactly.
 *
 * It sets one thing, and it is now the *only* thing standing between one player
 * and the whole board: how many credits it takes to argue with the opening
 * prior. It was 300,000 while eight desks put twenty times that through a coin
 * every round — sized against their flow, and so large that a player betting a
 * hundred credits moved a line by nothing at all. With the desks gone the flow
 * is what people actually stake, which is two or three orders of magnitude less,
 * and the pool has to be sized against *that* or the board is a picture.
 *
 * Raise it and the board is stickier and the opening prior harder to argue with;
 * lower it and the first bet of a round swings it. This is the dial.
 */
export const OPENING_POOL = tunable("MARKET_OPENING_POOL", 2_000);

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const lineKey = (symbol: string, d: Direction) => `${symbol}|${d}`;

const lastCents = new Map<string, number>();
/** Credits bought on each line this round. The only thing that moves a price. */
const flow = new Map<string, number>();
/**
 * Credits the opening auction staked on each line — the model's entire say on
 * what it is worth, and the pool a round's buying has to out-weigh to argue.
 */
const opening = new Map<string, number>();
/**
 * What the model says each of an asset's outcomes is worth, in cents.
 *
 * Read for one thing only: an outcome that is real but has no line — a coin that
 * opened last finishing LOWER by falling off the board — still owns its share of
 * the hundred, and the pool cannot price it because nobody can stake it. Seeded
 * once at the open from the same prior the auction stakes, and never touched
 * again; the model has no other say in what anything is worth.
 */
const lastModel = new Map<string, Partial<Record<Direction, number>>>();

/**
 * Rolling depth for one line: shares traded per bucket, plus the running sum.
 *
 * Depth used to be counted by rescanning a ring of past fills, which made the
 * number the panel showed depend on how many fills the ring happened to be
 * holding — it silently reported a fraction of the window's depth as soon as the
 * fills arrived faster than the ring was sized for. Keeping the total here says
 * what the window actually holds, and turns the book into a constant-time read.
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
 * Write a fill into the depth window.
 *
 * Deliberately does *not* set a price: what a line is worth is a function of all
 * the flow on its asset, which is `remark`'s job. Use `recordFill` to trade;
 * this is the half that only remembers.
 */
export function record(fill: Fill): void {
  const line = lineKey(fill.symbol, fill.direction);

  const bucket = bucketOf(fill.at);
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
    d.shares[bucket % DEPTH_BUCKETS] += fill.size;
    d.total += fill.size;
  }
}

/**
 * Record a fill, and re-mark the rest of that asset's book off the same print.
 *
 * A bet buys one leg, so on its own `record` would leave the other two frozen at
 * their opening print while the credits behind the coin moved underneath them.
 * That is not cosmetic: a player holding a *losing* position could close it at a
 * mark the round's own betting had already argued down, and two of the three
 * chips on the board would stop meaning anything.
 *
 * The three outcomes are mutually exclusive and exhaustive, so their prices were
 * never independent — they sum to a hundred. What the fill did not take, the
 * remaining legs share in proportion to what is staked on them.
 */
export function recordFill(fill: Fill): void {
  record(fill);
  const line = lineKey(fill.symbol, fill.direction);
  flow.set(line, (flow.get(line) ?? 0) + Math.max(0, fill.size));
  remark(fill.symbol, lastModel.get(fill.symbol) ?? {});
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
 * Take a position back out of the pool when it is closed early.
 *
 * The inverse of the buy, and it has to exist. A mark is a line's share of the
 * credits behind its coin, so buying moves it up; if closing did not move it
 * back down, a large enough position could bid its own line up, sell into the
 * bid it had just created and book the difference. Removing exactly what was
 * staked makes the round trip cost precisely the spread, which is the price the
 * design puts on it.
 *
 * It is also what lets a mark come back down at all. Nothing sells short here, so
 * the only two ways a line falls are somebody backing another leg of the same
 * coin, and somebody closing this one.
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
 * Reversible, which is what lets the room change its mind: nobody can sell short,
 * but when the flow turns and the other leg starts taking credits, its share
 * overtakes and the first one comes back down.
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
 * Read from the rolling aggregate rather than by walking a list of fills: the
 * client polls this every couple of seconds per open coin, and a walk is the one
 * thing here whose cost grows with how hard the board is being traded.
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
 * The three lines for one coin, quoted off the book.
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
 * bet lands. They're worth the book's bid apiece — the last mark less the same
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
 * A new round wipes the depth window and every credit of accumulated flow.
 * Prices are quoted against *this* round's start ranks, so carrying yesterday's
 * buying forward would price the wrong bet.
 */
export function openRound(round: RoundBook): void {
  if (round.id === openRoundId) return;
  if (round.endsAt.getTime() <= Date.now()) return;

  openRoundId = round.id;
  openEndsAt = round.endsAt.getTime();
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
    const model: Partial<Record<Direction, number>> = {};
    for (const direction of DIRECTIONS) {
      const p = { HIGHER: prior.higher, DRAW: prior.draw, LOWER: prior.lower }[direction];
      if (!(p > 0)) continue;
      model[direction] = clamp(Math.round(p * 100), FLOOR_CENTS, CAP_CENTS);
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
      record({ at, symbol: entry.symbol, direction, size: staked });
    }
    // Every outcome the coin has, priced, whether or not it is offered. Used for
    // exactly one thing — the share of the hundred an unbettable-but-real
    // outcome owns — and it has to be recorded here because there is nothing
    // else in the round that would ever compute it. Before, a desk brought a
    // fresh one on every fill; now the prior is the whole of it.
    lastModel.set(entry.symbol, model);
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
 * and every line in the results panel came back `available`. The depth window is
 * left alone — it is what traded — and only the quoting stops.
 */
export function closeBook(): void {
  openRoundId = null;
  openEndsAt = 0;
  quoted.clear();
}

/** Test seam — the book is process-local and deliberately not persisted. */
export function resetMarket(): void {
  lastCents.clear();
  flow.clear();
  opening.clear();
  lastModel.clear();
  quoted.clear();
  depth.clear();
  openRoundId = null;
  openEndsAt = 0;
}
