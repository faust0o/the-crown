/**
 * The pricing rule, in the same fixed point the chain uses.
 *
 * This is a transliteration of `crown/programs/crown/src/pricing.rs`, and it
 * exists for one reason: **the price a player is shown and the price the chain
 * charges them must be the same number.** The board quotes off this; `place_bet`
 * charges off the Rust. If the two disagreed by a cent, every bet would be a
 * small lie, and the disagreement would show up as random slippage failures on
 * the desks' orders rather than as anything legible.
 *
 * So this does not use `Math.log`. It cannot: `market.ts` used to, and the
 * original `averageMark` loses most of its significant digits to catastrophic
 * cancellation for a small stake against a large pool — see the note on `ONE` in
 * the Rust. Every operation here is integer arithmetic on `bigint`, chosen so
 * that each intermediate is bit-identical to the one the program computes.
 *
 * Verified against vectors generated from the Rust — see `pricing.test.ts`. If
 * that test fails, this file and the program have drifted and bets are filling
 * at prices the board never showed.
 */

/** Prices are probabilities in cents, never 0 or 100, so a payout stays finite. */
export const FLOOR_CENTS = 1;
export const CAP_CENTS = 99;
/** Half-spread around the last print. `max(1, round(FEE / 3 * 100))`, FEE = 0.04. */
export const SPREAD_CENTS = 1;

export const HIGHER = 0;
export const DRAW = 1;
export const LOWER = 2;

export type Direction = typeof HIGHER | typeof DRAW | typeof LOWER;

/** Q64.64, matching `ONE` in the Rust. */
const ONE = 1n << 64n;
/** ln(2) in Q64.64. */
const LN2 = 12786308645202655660n;

/** Index of the highest set bit — `u128::leading_zeros` inverted. */
function bitLength(x: bigint): number {
  let n = 0;
  let v = x;
  while (v > 0xffffffffn) {
    v >>= 32n;
    n += 32;
  }
  while (v > 0n) {
    v >>= 1n;
    n += 1;
  }
  return n;
}

/**
 * Natural log of `x`, both in Q64.64. Returns 0 for `x <= 1`.
 *
 * Range-reduce to `x = m · 2^e` with `m` in [1, 2), then `ln(x) = e·ln(2) + ln(m)`
 * from the `atanh` series. Twenty-four terms puts the tail below the Q64.64
 * resolution; the loop is bounded rather than convergence-tested so the cost is
 * fixed, exactly as on-chain.
 *
 * The truncating `/` on `bigint` matches Rust's integer division on `u128`,
 * which is what makes the two implementations agree bit for bit rather than
 * merely to within a rounding error.
 */
export function lnQ64(x: bigint): bigint {
  if (x <= ONE) return 0n;

  const e = BigInt(bitLength(x) - 1) - 64n;
  const m = e > 0n ? x >> e : x;

  const num = m - ONE;
  const den = m + ONE;
  const z = (num << 64n) / den;

  const z2 = (z * z) >> 64n;
  let term = z;
  let sum = z;
  for (let k = 1n; k < 24n; k++) {
    term = (term * z2) >> 64n;
    if (term === 0n) break;
    sum += term / (2n * k + 1n);
  }

  return (e > 0n ? e : 0n) * LN2 + 2n * sum;
}

/**
 * What one asset's book looks like — the mirror of `pricing::Book`.
 *
 * `staked` is the opening auction's stake plus every credit traded since, which
 * is what `RoundEntry::book()` assembles on-chain.
 */
export interface Book {
  staked: [bigint, bigint, bigint];
  quoted: [boolean, boolean, boolean];
  target: number;
}

/** Credits behind the asset — the divisor every mark is a share of. */
export function poolOf(book: Book): bigint {
  let pool = 0n;
  for (let d = 0; d < 3; d++) if (book.quoted[d]) pool += book.staked[d];
  return pool;
}

/**
 * The average mark paid while a trade of `stake` walks the pool, in Q64.64.
 *
 * ```text
 *     (1/s) ∫₀ˢ target · (held + u) / (pool + u) du
 *          = target · (1 + ((held - pool) / s) · ln((pool + s) / pool))
 * ```
 */
function averageMarkQ64(held: bigint, pool: bigint, target: number, stake: bigint): bigint {
  if (pool === 0n) return 0n;
  const t = BigInt(target);
  if (stake === 0n) return (t * held * ONE) / pool;

  const d = pool - (held < pool ? held : pool);
  const ratio = ((pool + stake) << 64n) / pool;
  const l = lnQ64(ratio);

  const term = (d * l) / stake;
  if (term >= ONE) return 0n;
  return t * (ONE - term);
}

/** Round a Q64.64 quantity to the nearest whole cent. */
const roundQ64 = (v: bigint): bigint => (v + (ONE >> 1n)) >> 64n;

const clampCents = (v: bigint): number =>
  Number(v < BigInt(FLOOR_CENTS) ? BigInt(FLOOR_CENTS) : v > BigInt(CAP_CENTS) ? BigInt(CAP_CENTS) : v);

/**
 * What a stake fills at, in cents — the ask, inclusive of the price its own size
 * moves the book through. `null` when the leg is not on the book.
 */
export function fillCents(book: Book, direction: Direction, stake: bigint): number | null {
  if (!book.quoted[direction]) return null;
  const pool = poolOf(book);
  if (pool === 0n) return null;
  const avg = averageMarkQ64(book.staked[direction], pool, book.target, stake);
  return clampCents(roundQ64(avg) + BigInt(SPREAD_CENTS));
}

/**
 * What closing `stake` of a position fills at — the bid, over the same stretch of
 * curve the opening trade walked up, so a round trip costs the spread and nothing
 * else at any size.
 */
export function closeCents(book: Book, direction: Direction, stake: bigint): number | null {
  if (!book.quoted[direction]) return null;
  const pool = poolOf(book);
  if (pool === 0n) return null;
  const ceiling = pool - 1n > 0n ? pool - 1n : 0n;
  let size = stake < book.staked[direction] ? stake : book.staked[direction];
  if (size > ceiling) size = ceiling;
  const avg = averageMarkQ64(
    book.staked[direction] - size,
    pool - size,
    book.target,
    size
  );
  return clampCents(roundQ64(avg) - BigInt(SPREAD_CENTS));
}

/**
 * Re-derive every mark on an asset from the credits standing behind it.
 *
 * Ties break on the exact integer remainder `(target · staked) % pool`, which is
 * what the Rust does — and what the `f64` version in `market.ts` was
 * approximating with `exact - floor(exact)`. Same ordering, no floating point.
 */
export function remark(book: Book): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0];
  const pool = poolOf(book);
  if (pool === 0n) return out;
  const target = BigInt(book.target);

  const open: number[] = [];
  for (let d = 0; d < 3; d++) if (book.quoted[d]) open.push(d);
  if (!open.length) return out;

  const cents: bigint[] = [];
  const remainder: bigint[] = [];
  for (const d of open) {
    const numerator = target * book.staked[d];
    cents.push(numerator / pool);
    remainder.push(numerator % pool);
  }

  // Largest remainder, so the book adds up to the target rather than to the
  // target plus rounding dust.
  const spare = target - cents.reduce((a, b) => a + b, 0n);
  if (spare > 0n) {
    const order = [...cents.keys()].sort((a, b) =>
      remainder[b] === remainder[a] ? 0 : remainder[b] > remainder[a] ? 1 : -1
    );
    for (const i of order.slice(0, Number(spare))) cents[i] += 1n;
  }

  // Bounds beat the sum: a leg outside them prices a payout that is infinite or
  // worthless. Whatever the clamp costs is pushed into a leg with room.
  const lo = BigInt(FLOOR_CENTS);
  const hi = BigInt(CAP_CENTS);
  const bounded = cents.map((c) => (c < lo ? lo : c > hi ? hi : c));
  let drift = bounded.reduce((a, b) => a + b, 0n) - target;
  for (let guard = 0; drift !== 0n && guard < 300; guard++) {
    const step = drift > 0n ? -1n : 1n;
    const order = [...bounded.keys()].sort((a, b) =>
      step < 0n
        ? bounded[b] === bounded[a]
          ? 0
          : bounded[b] > bounded[a]
            ? 1
            : -1
        : bounded[a] === bounded[b]
          ? 0
          : bounded[a] > bounded[b]
            ? 1
            : -1
    );
    const i = order.find((j) => {
      const next = bounded[j] + step;
      return next >= lo && next <= hi;
    });
    if (i === undefined) break;
    bounded[i] += step;
    drift += step;
  }

  open.forEach((d, i) => (out[d] = Number(bounded[i])));
  return out;
}

/**
 * How many credits it takes to move a leg's mark `fraction` of the way from
 * where it is to `fairCents`.
 *
 * The pricing rule run backwards. `m = target · (held + x) / (pool + x)` solves to
 *
 * ```text
 *     x = (m·pool - target·held) / (target - m)
 * ```
 *
 * which is what lets a desk trade *to a price* rather than trade a size and hope.
 * Sizing a clip as a slice of bankroll says nothing about how wrong the price
 * currently is, so a line twenty cents adrift got the same clip as one already
 * right — and a coin that had demonstrably climbed could sit at a third of its
 * worth all round because the arithmetic that set the clip had never looked at
 * the mark.
 *
 * Takes a fraction rather than a target price on purpose. A caller working from
 * the quoted mark is working from an integer that has already been rounded and
 * largest-remaindered, and a target derived from it lands on the wrong side of
 * the true pool share about half the time — asking for a move the book has
 * already made, which solves to zero credits. Everything here is computed from
 * the unrounded share instead.
 *
 * Unlike the rest of this module the arithmetic is `number`, not `bigint`: it
 * sizes an *intention*, and the credits it returns are then floored and clamped
 * by the caller before anything is spent. Nothing here decides a price.
 */
export function creditsToClose(
  book: Book,
  direction: Direction,
  fairCents: number,
  fraction: number
): number {
  const pool = Number(poolOf(book));
  const target = book.target;
  if (!(pool > 0) || !(target > 0) || !book.quoted[direction]) return 0;

  const held = Number(book.staked[direction]);
  const now = (target * held) / pool;
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const wanted = now + (clamp(fairCents, 0, target) - now) * clamp(fraction, 0, 1);
  // A leg cannot own the whole book, and the solve divides by what is left of it.
  const m = clamp(wanted, 0, target - 1);
  if (!(m > now)) return 0; // already there, or past it — nothing to buy

  return Math.max(0, (m * pool - target * held) / (target - m));
}

/**
 * What a winning stake returns, stake included, in credits.
 *
 * Floored, never rounded to nearest — on a small stake the spread is worth less
 * than half a credit, and rounding to nearest hands it back, which makes a round
 * trip a free option.
 */
export function payoutFor(stake: bigint, fill: number): bigint {
  if (fill <= 0) throw new Error("a price of zero cents would price an infinite payout");
  return (stake * 100n) / BigInt(fill);
}

/** What closing an open position pays right now, in credits. Floored likewise. */
export function closeValue(stake: bigint, fill: number, bidCents: number): bigint {
  if (fill <= 0) throw new Error("a price of zero cents would price an infinite payout");
  const shares = (stake * 100n) / BigInt(fill);
  return (shares * BigInt(Math.min(100, Math.max(0, bidCents)))) / 100n;
}
