//! The pricing rule, moved on-chain.
//!
//! This is a port of `server/src/market.ts`, and the port is deliberately
//! partial. Two different kinds of arithmetic live in that file and only one of
//! them belongs in a program:
//!
//! - **What a line is worth** — `fairCents`, and the `erf`/`probit` machinery
//!   under it in `crypto-odds.ts`. That is a *desk's opinion*, computed to decide
//!   which leg to buy. It is nobody's consensus state, it is expensive in
//!   floating point, and two desks are entitled to disagree about it. It stays
//!   off-chain.
//! - **What a line costs** — this module. A leg's mark is its share of the
//!   credits standing behind its asset, so the price is a ratio of two integers
//!   and nothing more. That *is* consensus state: it decides what a bet fills at,
//!   so it has to be computed where it cannot be argued with.
//!
//! Keeping the split honest is what lets the model stay in TypeScript. Nothing
//! here reads a probability; it reads `opening` and `flow`, which are credits.
//!
//! ## Why fixed point
//!
//! One transcendental survives into the fill path: `averageMark` integrates the
//! price curve a trade walks along, and that integral is a logarithm. Floating
//! point on BPF is emulated, slow, and — worse — would make the price a function
//! of which machine computed it. So `ln` is computed here in Q64.64 by
//! `ln_q64`, and `market.ts` is expected to call the *same* algorithm rather
//! than `Math.log`, so that the quote a player is shown and the price the chain
//! charges them cannot disagree. A cent of daylight between those two is the one
//! bug this whole module exists to prevent.

use crate::error::CrownError;
use anchor_lang::prelude::*;

/// Prices are probabilities in cents and never reach 0 or 100, so a payout is
/// always finite and capped. Mirrors `FLOOR`/`CAP` in `crypto-odds.ts`.
pub const FLOOR_CENTS: u16 = 1;
pub const CAP_CENTS: u16 = 99;

/// Half-spread around the last print, in cents.
///
/// `max(1, round(FEE / 3 * 100))` with `FEE = 0.04` — the house margin charged
/// on the way in and again on the way out, so a round trip is never free.
pub const SPREAD_CENTS: u16 = 1;

/// The three outcomes, in the order every `[_; 3]` in this program uses.
pub const DIRECTIONS: usize = 3;

pub const HIGHER: usize = 0;
pub const DRAW: usize = 1;
pub const LOWER: usize = 2;

/// Fixed-point scale: Q64.64.
///
/// Q32.32 is not enough, and the reason is worth recording because it is not a
/// matter of taste. `average_mark_q64` evaluates `1 - (d/s)·ln(1 + s/p)`, and for
/// a small stake against a large pool that product sits just under 1 — so the
/// subtraction is catastrophic cancellation, and whatever error `ln` carries is
/// multiplied by `d/s` before it lands in the answer. At Q32.32 (resolution
/// 2.3e-10) a one-credit clip into a 300k pool came out 107× too large.
///
/// At Q64.64 the resolution is 5.4e-20, so a quantised `ln` amplified by `d/s`
/// costs at most `target · (d/s) · 5.4e-20`, i.e. about `(d/s) · 5.4e-18` cents.
/// Changing a rounded price needs half a cent, so it would take `d/s > 9e16`;
/// with `d` bounded by the pool and `s ≥ 1` the realistic worst case is nearer
/// `1e12`, leaving about five orders of magnitude of headroom.
///
/// Note this makes the on-chain arithmetic *more* accurate than the `f64`
/// original: `Math.log` in `market.ts` meets the same cancellation and is itself
/// only good to about 1e-8 cents on those inputs.
const ONE: u128 = 1 << 64;
/// ln(2) in Q64.64.
const LN2: u128 = 12786308645202655660;

/// Natural log of `x`, both in Q64.64. Returns 0 for `x <= 1`.
///
/// Range-reduce to `x = m · 2^e` with `m` in [1, 2), then
/// `ln(x) = e·ln(2) + ln(m)`, and take `ln(m)` from the `atanh` series
///
/// ```text
///     ln(m) = 2 · (z + z³/3 + z⁵/5 + …),  z = (m - 1) / (m + 1)
/// ```
///
/// which converges fast because `m < 2` bounds `z < 1/3`: each term is smaller
/// than the last by more than a factor of nine, so twenty-four of them put the
/// tail below the Q64.64 resolution. The loop is bounded rather than
/// convergence-tested — a fixed cost is worth more than a tight one here, since
/// an unbounded loop in a program is a compute-budget failure waiting for the
/// right input.
///
/// Every intermediate is a value below 1 in Q64.64, i.e. below `2^64`, so the
/// products stay inside `u128` without a widening step.
pub fn ln_q64(x: u128) -> u128 {
    if x <= ONE {
        return 0;
    }

    // e = floor(log2(x)) - 64, and m = x >> e, which lands m in [1, 2).
    let e = (127 - x.leading_zeros()) as i32 - 64;
    let m = if e > 0 { x >> e } else { x };

    // z = (m - 1) / (m + 1). m < 2 bounds the numerator below 2^64 and the
    // denominator at or above 2^65, so the shift cannot overflow and z < 1/3.
    let num = m - ONE;
    let den = m + ONE;
    let z = (num << 64) / den;

    let z2 = (z * z) >> 64;
    let mut term = z; // z^(2k+1)
    let mut sum = z;
    for k in 1..24u32 {
        term = (term * z2) >> 64;
        if term == 0 {
            break;
        }
        sum += term / (2 * k as u128 + 1);
    }

    (e.max(0) as u128) * LN2 + 2 * sum
}

/// What one asset's book looks like: what is staked on each leg, which legs are
/// tradable, and how much of the hundred those legs divide between them.
///
/// `target` is the whole hundred unless a leg is real but has no line — the crown,
/// or an outcome the round does not offer — in which case that leg's share is
/// taken out first. It is posted by the authority when the entry is created
/// rather than derived here, because deriving it needs the model.
#[derive(Clone, Copy, Debug)]
pub struct Book {
    pub staked: [u64; DIRECTIONS],
    pub quoted: [bool; DIRECTIONS],
    pub target: u16,
}

impl Book {
    /// Credits standing behind the asset as a whole — the divisor every mark on
    /// it is a share of. Only tradable legs count; an untradable leg's share of
    /// the hundred was already removed from `target`.
    pub fn pool(&self) -> u64 {
        let mut pool: u64 = 0;
        for d in 0..DIRECTIONS {
            if self.quoted[d] {
                pool = pool.saturating_add(self.staked[d]);
            }
        }
        pool
    }
}

/// The average mark paid while a trade of `stake` credits walks the pool from
/// `held`/`pool` to `held + stake`/`pool + stake`, in cents scaled by 2^64.
///
/// A mark is `target * held / pool`, so the price is not constant across a fill —
/// it is the curve the trade itself moves along, and the honest price for the
/// whole clip is its average:
///
/// ```text
///     (1/s) ∫₀ˢ target * (held + u) / (pool + u) du
///          = target * (1 + ((held - pool) / s) * ln((pool + s) / pool))
/// ```
///
/// Quoting the pre-trade mark and letting the fill move it would hand a trade the
/// whole of its own impact: a clip large enough to move the book would be worth
/// more than it cost the instant it landed, so buying and closing immediately was
/// free money. Charging the average makes a trade pay for the room it takes.
///
/// Returned unrounded (Q64.64) so callers can add their spread before rounding
/// once — rounding here and again at the caller would cost a cent twice.
fn average_mark_q64(held: u64, pool: u64, target: u16, stake: u64) -> u128 {
    if pool == 0 {
        return 0;
    }
    let target = target as u128;
    if stake == 0 {
        return (target * held as u128 * ONE) / pool as u128;
    }

    // held <= pool always, so the correction term is a subtraction and the whole
    // computation stays in unsigned arithmetic.
    let d = (pool - held.min(pool)) as u128;
    let ratio = ((pool as u128 + stake as u128) << 64) / pool as u128;
    let l = ln_q64(ratio);

    // (d / stake) · ln(...), in Q64.64. Multiply before dividing so the ratio
    // keeps its precision.
    let term = (d * l) / stake as u128;
    if term >= ONE {
        return 0;
    }
    target * (ONE - term)
}

/// Round a Q64.64 quantity to the nearest whole cent.
fn round_q64(v: u128) -> u128 {
    (v + (ONE >> 1)) >> 64
}

fn clamp_cents(v: i64) -> u16 {
    v.clamp(FLOOR_CENTS as i64, CAP_CENTS as i64) as u16
}

/// What a stake actually fills at on this line, in cents — the ask a bet is
/// written at, inclusive of the price its own size moves the book through.
///
/// `None` when the leg is not on the book.
pub fn fill_cents(book: &Book, direction: usize, stake: u64) -> Option<u16> {
    if !book.quoted[direction] {
        return None;
    }
    let pool = book.pool();
    if pool == 0 {
        return None;
    }
    let avg = average_mark_q64(book.staked[direction], pool, book.target, stake);
    Some(clamp_cents(round_q64(avg) as i64 + SPREAD_CENTS as i64))
}

/// What closing `stake` credits of a position fills at, in cents — the bid, over
/// the same stretch of curve the opening trade walked up.
///
/// Deliberately the mirror of `fill_cents`: the average is taken over the
/// interval the pool is about to move back down through, which is the identical
/// integral. The two therefore agree to the cent before the spread is applied,
/// and the spread is the entire cost of a round trip at any size.
pub fn close_cents(book: &Book, direction: usize, stake: u64) -> Option<u16> {
    if !book.quoted[direction] {
        return None;
    }
    let pool = book.pool();
    if pool == 0 {
        return None;
    }
    // A leg cannot give back more than is staked on it, and the pool cannot be
    // emptied — the mark is a share of it.
    let size = stake.min(book.staked[direction]).min(pool.saturating_sub(1));
    let avg = average_mark_q64(book.staked[direction] - size, pool - size, book.target, size);
    Some(clamp_cents(round_q64(avg) as i64 - SPREAD_CENTS as i64))
}

/// Re-derive every mark on an asset from the credits standing behind it.
///
/// A leg's weight is what is staked on it; the marks are those weights as
/// percentages of the asset's whole pool. That is the entire pricing rule — no
/// coefficient, no exponent, nothing to calibrate. Buying a leg raises it and
/// lowers the others by exactly what it gained, and the book always sums to
/// `target`.
///
/// **Ties are broken on exact integer remainders, not on floating-point ones.**
/// `market.ts` sorts by `exact - floor(exact)` in `f64`; here the same ordering
/// comes from `(target * staked) % pool`, which is the quantity that difference
/// is *approximating*. It agrees with the TypeScript everywhere the TypeScript is
/// exact and is deterministic where floating point would not be — which a program
/// needs and a server does not.
pub fn remark(book: &Book) -> [u16; DIRECTIONS] {
    let mut out = [0u16; DIRECTIONS];
    let pool = book.pool();
    if pool == 0 {
        return out;
    }
    let pool = pool as u128;
    let target = book.target as u128;

    let open: Vec<usize> = (0..DIRECTIONS).filter(|&d| book.quoted[d]).collect();
    if open.is_empty() {
        return out;
    }

    // Floor of each leg's exact share, plus the remainder that floor discarded.
    let mut cents: Vec<i64> = Vec::with_capacity(open.len());
    let mut remainder: Vec<u128> = Vec::with_capacity(open.len());
    for &d in &open {
        let numerator = target * book.staked[d] as u128;
        cents.push((numerator / pool) as i64);
        remainder.push(numerator % pool);
    }

    // Largest remainder, so the book adds up to the target rather than to the
    // target plus rounding dust.
    let spare = target as i64 - cents.iter().sum::<i64>();
    if spare > 0 {
        let mut order: Vec<usize> = (0..open.len()).collect();
        order.sort_by(|&a, &b| remainder[b].cmp(&remainder[a]));
        for &i in order.iter().take(spare as usize) {
            cents[i] += 1;
        }
    }

    // Bounds beat the sum: a leg outside them prices a payout that is infinite or
    // worthless, which is the one thing FLOOR and CAP exist to prevent. Whatever
    // the clamp costs is pushed into a leg with room, largest first, so the shape
    // survives and the total still holds wherever it can.
    let mut bounded: Vec<i64> = cents
        .iter()
        .map(|&c| c.clamp(FLOOR_CENTS as i64, CAP_CENTS as i64))
        .collect();
    let mut drift = bounded.iter().sum::<i64>() - target as i64;
    let mut guard = 0;
    while drift != 0 && guard < 300 {
        let step: i64 = if drift > 0 { -1 } else { 1 };
        let mut order: Vec<usize> = (0..bounded.len()).collect();
        if step < 0 {
            order.sort_by(|&a, &b| bounded[b].cmp(&bounded[a]));
        } else {
            order.sort_by(|&a, &b| bounded[a].cmp(&bounded[b]));
        }
        match order.into_iter().find(|&j| {
            let next = bounded[j] + step;
            next >= FLOOR_CENTS as i64 && next <= CAP_CENTS as i64
        }) {
            Some(i) => {
                bounded[i] += step;
                drift += step;
            }
            // Nowhere left to put it; the bounds win.
            None => break,
        }
        guard += 1;
    }

    for (i, &d) in open.iter().enumerate() {
        out[d] = bounded[i] as u16;
    }
    out
}

/// What a winning stake returns, stake included, in credits.
///
/// The stake bought `stake / cents` shares' worth at entry — expressed here as
/// `stake * 100 / cents` so the whole computation stays in integers. Each share
/// pays one credit if the bet lands.
///
/// Rounded **down**, never to nearest. On a small stake the spread is worth less
/// than half a credit and rounding to nearest hands it straight back, which makes
/// a round trip a free option. The design says it is not one.
pub fn payout_for(stake: u64, fill_cents: u16) -> Result<u64> {
    require!(fill_cents > 0, CrownError::BadPrice);
    Ok((stake as u128 * 100 / fill_cents as u128) as u64)
}

/// What closing an open position pays right now, in credits.
///
/// The shares bought at entry are worth the tape's bid apiece — the last print
/// less the same margin charged on the way in, so a round trip always costs the
/// spread. Floored for the same reason `payout_for` is.
pub fn close_value(stake: u64, fill_cents: u16, bid_cents: u16) -> Result<u64> {
    require!(fill_cents > 0, CrownError::BadPrice);
    let shares = stake as u128 * 100 / fill_cents as u128;
    Ok((shares * bid_cents.min(100) as u128 / 100) as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Q64.64 back to f64, for comparing against the reference implementation.
    fn to_f64(v: u128) -> f64 {
        v as f64 / ONE as f64
    }

    #[test]
    fn ln_matches_the_reference_to_twelve_places() {
        // Spot values across the range `averageMark` actually asks for: the
        // argument is (pool + stake) / pool, which is >= 1 and rarely above 2.
        // The bound is set by `to_f64` and by `f64::ln` itself, not by us — the
        // fixed-point value carries far more precision than this can measure.
        for &x in &[1.0f64, 1.000001, 1.5, 2.0, 3.0, 10.0, 1000.0, 1e6] {
            let fixed = to_f64(ln_q64((x * ONE as f64) as u128));
            let want = x.ln();
            assert!(
                (fixed - want).abs() < 1e-12,
                "ln({x}): fixed {fixed} vs {want}"
            );
        }
    }

    /// The reference implementation from `market.ts`, in f64.
    fn average_mark_reference(held: u64, pool: u64, target: u16, stake: u64) -> f64 {
        if pool == 0 {
            return 0.0;
        }
        let (h, p, t, s) = (held as f64, pool as f64, target as f64, stake as f64);
        if stake == 0 {
            return t * h / p;
        }
        (t * (1.0 + ((h - p) / s) * ((p + s) / p).ln())).clamp(0.0, 100.0)
    }

    #[test]
    fn average_mark_agrees_with_the_typescript() {
        let cases = [
            (0u64, 300_000u64, 100u16, 1u64),
            (100_000, 300_000, 100, 1),
            (100_000, 300_000, 100, 50_000),
            (150_000, 300_000, 100, 1_000_000),
            (1, 3, 100, 1),
            (250_000, 300_000, 63, 10_000),
            (0, 1_000_000_000, 100, 999_999),
        ];
        for (held, pool, target, stake) in cases {
            let got = to_f64(average_mark_q64(held, pool, target, stake));
            let want = average_mark_reference(held, pool, target, stake);
            // Loose on purpose, and the looseness is the *reference's*. For a
            // small stake against a large pool the f64 version loses most of its
            // significant digits to the same cancellation described at `ONE`, so
            // it is only good to about 1e-8 cents here. Tightening this would be
            // asserting that we reproduce its error, which is the opposite of
            // what we want.
            assert!(
                (got - want).abs() < 1e-6,
                "averageMark({held},{pool},{target},{stake}): {got} vs {want}"
            );
        }
    }

    /// The cancellation case, checked against a value computed exactly.
    ///
    /// `held = 0` reduces the integral to `target · (1 - (p/s)·ln(1 + s/p))`,
    /// whose series is `target · (u/2 - u²/3 + u³/4 - …)` with `u = s/p` — all
    /// positive leading terms and no subtraction, so it can be evaluated to full
    /// precision and used as an oracle for the formula that does subtract.
    #[test]
    fn the_cancellation_case_is_right_to_the_last_place() {
        for (pool, stake) in [(300_000u64, 1u64), (1_000_000_000, 1), (300_000, 7)] {
            let u = stake as f64 / pool as f64;
            // u/2 - u²/3 + u³/4 - … converges immediately for u this small.
            let mut series = 0.0f64;
            let mut power = u;
            for k in 0..8u32 {
                let term = power / (k as f64 + 2.0);
                series += if k % 2 == 0 { term } else { -term };
                power *= u;
            }
            let want = 100.0 * series;
            let got = to_f64(average_mark_q64(0, pool, 100, stake));

            // Checked against the bound derived at `ONE` rather than a constant,
            // because the error here is not a defect to be tuned away — it is the
            // quantisation of a Q64.64 `ln` amplified by `d/s`, and it grows with
            // `d/s` by construction. A few ulps of slack covers the three places
            // that quantise (the ratio, the series, the final division).
            //
            // At pool 1e9 that bound is ~5e-9 cents against an answer of 5e-8, so
            // the *relative* error is large and entirely irrelevant: what the
            // caller does with this is round it to a whole cent, and both numbers
            // round to zero. Precision matters here only where it could move a
            // price, and a half-cent is eight orders of magnitude away.
            let amplification = (pool - 0) as f64 / stake as f64;
            let bound = 8.0 * 100.0 * amplification / (ONE as f64);
            assert!(
                (got - want).abs() < bound,
                "averageMark(0,{pool},100,{stake}): {got} vs {want} (bound {bound:e})"
            );
            assert_eq!(
                round_q64(average_mark_q64(0, pool, 100, stake)),
                want.round() as u128,
                "the rounded cent must agree however small the raw difference"
            );
        }
    }

    fn book_of(staked: [u64; 3], target: u16) -> Book {
        Book {
            staked,
            quoted: [true; 3],
            target,
        }
    }

    #[test]
    fn marks_sum_to_the_target() {
        for staked in [
            [100_000u64, 100_000, 100_000],
            [1, 1, 300_000],
            [123_456, 7, 999_999],
            [1, 1, 1],
        ] {
            let marks = remark(&book_of(staked, 100));
            assert_eq!(
                marks.iter().sum::<u16>(),
                100,
                "marks {marks:?} for staked {staked:?}"
            );
        }
    }

    #[test]
    fn no_mark_ever_leaves_the_bounds() {
        // A leg holding essentially the whole pool must still not print 100, or a
        // payout would be worthless; the other legs must still not print 0, or a
        // payout would be infinite.
        let marks = remark(&book_of([1, 1, 100_000_000], 100));
        for m in marks {
            assert!(
                (FLOOR_CENTS..=CAP_CENTS).contains(&m),
                "mark {m} outside bounds in {marks:?}"
            );
        }
    }

    #[test]
    fn an_untradable_leg_keeps_its_share_out_of_the_pool() {
        // The crown case: LOWER is real but has no line, so the two open legs
        // divide a target below a hundred and the closed leg prints nothing.
        let book = Book {
            staked: [50_000, 50_000, 0],
            quoted: [true, true, false],
            target: 70,
        };
        let marks = remark(&book);
        assert_eq!(marks[LOWER], 0);
        assert_eq!(marks[HIGHER] + marks[DRAW], 70);
    }

    #[test]
    fn a_round_trip_costs_the_spread_and_nothing_else() {
        // Buy, then immediately close the same size: the two averages are taken
        // over the identical stretch of curve, so what separates them is the
        // spread charged twice and nothing else.
        let mut book = book_of([100_000, 100_000, 100_000], 100);
        let stake = 25_000u64;

        let ask = fill_cents(&book, HIGHER, stake).unwrap();
        book.staked[HIGHER] += stake;
        let bid = close_cents(&book, HIGHER, stake).unwrap();

        assert_eq!(
            ask - bid,
            2 * SPREAD_CENTS,
            "ask {ask} bid {bid} should differ by exactly the round-trip spread"
        );
    }

    #[test]
    fn a_bigger_clip_pays_a_worse_price() {
        // The whole point of charging the average rather than the mark: size pays
        // for the room it takes, monotonically.
        let book = book_of([100_000, 100_000, 100_000], 100);
        let mut last = 0u16;
        for stake in [1u64, 1_000, 10_000, 100_000, 1_000_000] {
            let cents = fill_cents(&book, HIGHER, stake).unwrap();
            assert!(
                cents >= last,
                "stake {stake} filled at {cents}, cheaper than the smaller clip at {last}"
            );
            last = cents;
        }
    }

    #[test]
    fn closing_is_floored_so_it_is_never_a_free_option() {
        // 47 credits at a 94c mark is one of the pairs that used to round-trip
        // for exactly what it cost.
        let value = close_value(47, 94, 93).unwrap();
        let cost = 47u64;
        assert!(value < cost, "closed for {value} against a cost of {cost}");
    }

    #[test]
    fn an_unquoted_leg_has_no_price() {
        let book = Book {
            staked: [100_000, 100_000, 0],
            quoted: [true, true, false],
            target: 70,
        };
        assert!(fill_cents(&book, LOWER, 100).is_none());
        assert!(close_cents(&book, LOWER, 100).is_none());
    }
}
