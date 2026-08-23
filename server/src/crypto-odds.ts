
/**
 * The model behind "where does this coin's rank end up" — not the price.
 *
 * `market.ts` owns prices: a line is worth whatever it last traded at. This
 * module supplies the two things a traded price cannot supply for itself — the
 * opening print for a line that has never traded (`probabilities`), and the
 * distribution the desks quote against (`rankOutcomeProbability`) — plus the
 * bounds every quote is clamped to.
 *
 * Priors measured over 1000 minutes of real 1m klines, using the shipped 10m
 * volume window, comparing rank at a round's open against rank ~60 minutes
 * later. Overall the field came out HIGHER 37% / DRAW 25% / LOWER 38% — the
 * direction is symmetric because rank is zero-sum, so there is no side to farm.
 *
 * The dispersion is all in DRAW, and it's real: BTC held its rank in 75% of
 * rounds, DOGE in 11%. That is what makes ten rows carry ten different prices
 * for an honest reason rather than a modelling artefact.
 *
 * These are seed priors. Once rounds have accumulated in the DB, refit from
 * observed outcomes and shrink these out.
 */
type Triple = { higher: number; draw: number; lower: number };

/**
 * Starting rank matters on top of coin identity: rank 1 can't go HIGHER, and
 * the bottom of the board mean-reverts upward (measured 53%/24%/22% for coins
 * starting outside the top 10).
 */
function bandPrior(startRank: number): Triple {
  if (startRank <= 3) return { higher: 0.14, draw: 0.5, lower: 0.36 };
  if (startRank <= 6) return { higher: 0.32, draw: 0.17, lower: 0.51 };
  if (startRank <= 10) return { higher: 0.38, draw: 0.14, lower: 0.48 };
  return { higher: 0.53, draw: 0.24, lower: 0.22 };
}

const FIELD: Triple = { higher: 0.37, draw: 0.25, lower: 0.38 };
/** House margin, applied across the three legs. */
export const FEE = 0.04;
/**
 * No leg is ever priced beyond these, so a payout is always finite and capped.
 *
 * Widened from 2c/94c so a signal the desks have been accumulating all round can
 * run the price to where the outcome actually is. The three outcomes sum to a
 * hundred, so with two legs held at the floor a coin with all three lines open
 * tops out at 98c; only a coin whose starting rank closes one leg — rank 1, or
 * last place — can print 99c. Widening cuts both ways and the trade is
 * deliberate: a favourite at the cap now returns 1.01x rather than 1.06x, and a
 * longshot at the floor pays 50x rather than 33x.
 */
export const FLOOR = 0.01;
export const CAP = 0.99;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Abramowitz & Stegun 7.1.26. */
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  return x >= 0 ? y : -y;
}

function normCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/**
 * Inverse normal CDF — Acklam's rational approximation, good to ~1e-9.
 *
 * Here to run `bandPrior` backwards: the priors are measured frequencies, and
 * the rest of this module works in "where will the final rank land", so
 * something has to turn one into the other. See `bandShape`.
 */
function probit(p: number): number {
  const a = [-39.696830286653757, 220.94609842452050, -275.92851044696869,
             138.35775186726900, -30.664798066147160, 2.5066282774592392];
  const b = [-54.476098798224058, 161.58583685804089, -155.69897985988661,
             66.801311887719720, -13.280681552885721];
  const c = [-0.0077848940024302926, -0.32239645804113648, -2.4007582771618381,
             -2.5497325393437338, 4.3746641414649678, 2.9381639826987831];
  const d = [0.0077846957090414622, 0.32246712907003983, 2.4451341684908210,
             3.7544086619074162];
  const lo = 0.02425;
  const q = p < lo || p > 1 - lo ? Math.sqrt(-2 * Math.log(p < 0.5 ? p : 1 - p)) : p - 0.5;

  if (p < lo || p > 1 - lo) {
    const z =
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    return p < 0.5 ? -z : z;
  }
  const r = q * q;
  return (
    ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  );
}

/**
 * The rank distribution a band's measured prior implies: how far a coin in that
 * band is expected to drift, and how wide the landing spread is with a whole
 * round to run.
 *
 * This is the join between the module's two halves, and it exists because they
 * used to disagree. `probabilities` is what the book opens at; `outcomeSigma`
 * and `rankOutcomeProbability` are what the desks quote against all round. Both
 * are functions of starting rank alone at the open, so they were two answers to
 * one question — and they differed by 26c on a top-three coin, which the desks
 * then spent the first minutes of every round arbitraging away. The board moved
 * before the board had moved.
 *
 * Running the prior backwards fixes the direction of the dependency. A Normal
 * over the final rank has two free parameters and the prior pins both:
 *
 *     P(final < start) = higher  and  P(final > start) = lower
 *
 * which solve to `sigma = -1 / (z_higher + z_lower)` and a shift of
 * `sigma * (z_lower - z_higher) / 2`. DRAW then comes out right on its own,
 * because the three are exhaustive. So `fairCents` at the open *is* the opening
 * print, by construction rather than by coincidence, and every cent of daylight
 * between mark and model after that is something that happened in the round.
 *
 * Both parameters keep their measured meaning. The shift is the asymmetry the
 * priors recorded — the bottom of the board drifts upward, the middle downward.
 * The spread is the dispersion, and it really is per-band: a top-three coin
 * holds its rank half the time, so its landing spread is under a place, while a
 * mid-board coin's is over two.
 */
function bandShape(startRank: number): { shift: number; sigma: number } {
  const { higher, lower } = bandPrior(startRank);
  const zHigher = probit(higher);
  const zLower = probit(lower);
  const sigma = -1 / (zHigher + zLower);
  return { shift: (sigma * (zLower - zHigher)) / 2, sigma };
}

function normalise(t: Triple): Triple {
  const z = t.higher + t.draw + t.lower;
  if (!(z > 0)) return { ...FIELD };
  return { higher: t.higher / z, draw: t.draw / z, lower: t.lower / z };
}

/**
 * Blend coin identity with starting rank. Rank 1 is a hard structural constraint
 * rather than a prior — it genuinely cannot move HIGHER — so that mass is moved
 * onto DRAW/LOWER instead of being priced as a near-miss.
 */
export function probabilities(_symbol: string, startRank: number, _fieldSize: number): Triple {
  // The field is whatever is trending, so there are no stable per-token priors
  // to lean on — position in the board is the whole signal. Refit from observed
  // round outcomes once enough have accumulated.
  const t: Triple = { ...bandPrior(startRank) };

  // Finishing better than first is not a thing that can happen, so that mass has
  // to go to the outcomes that can, and the coin's three prices still sum to a
  // hundred without it.
  if (startRank <= 1) {
    return normalise({ higher: 0, draw: t.draw + t.higher * 0.6, lower: t.lower + t.higher * 0.4 });
  }

  // The bottom of the board is not the same case and used to be treated as if it
  // were. A coin that opened last *can* finish LOWER — dropping off the board is
  // exactly that, and `recordCut` settles it that way — it simply isn't offered
  // as a bet. Handing its share to HIGHER and DRAW priced two lines at what a
  // third outcome was worth, and left the opening print 15c and 29c away from
  // what the desks made those same two lines. Which legs open is `openRound`'s
  // decision; this only says what each outcome is worth.
  return t;
}

/**
 * How wide the final rank can still land, given where the coin started and how
 * much time is left.
 *
 * At the open the spread is whatever that coin's band was measured to have; by
 * the cut it is nothing. Shrinking as the square root of the time left is what
 * makes a quote converge on the realised outcome as the round runs out — a
 * position that is winning with ten minutes to go is worth less than the same
 * position winning with ten seconds to go, which is what makes closing early a
 * decision rather than a formality.
 *
 * Per-band rather than one number for the whole field, because the dispersion
 * genuinely is: the top of the board holds its rank half the time and the middle
 * almost never. A single sigma had to be wrong for most of the board, and it was
 * wrong in the expensive direction — it priced DRAW on a top-three coin at 21c
 * against a measured 50c.
 */
export function outcomeSigma(remaining: number, startRank: number): number {
  return Math.max(0.12, bandShape(startRank).sigma * Math.sqrt(clamp(remaining, 0, 1)));
}

/**
 * Where a coin's final rank is expected to land before any live evidence — the
 * drift its band was measured to have, faded out as the round runs out.
 *
 * Scaled by the time left for the same reason the volume drift is: nothing that
 * has not happened yet can happen in no time at all. At the cut the expectation
 * is simply where the coin stands.
 */
export function bandDrift(startRank: number, remaining: number): number {
  return bandShape(startRank).shift * clamp(remaining, 0, 1);
}

/**
 * Chance a coin that opened at `startRank` resolves `direction`, given where its
 * final rank is expected to land and how much it can still move.
 *
 * A bet is a claim about the coin's rank at the cut *relative to where it
 * started the round*, so model the final rank as Normal(expectedRank, sigma) and
 * read the three outcomes off that. Splitting the expectation out from the
 * spread is what lets `market.ts` push the mean around with live volume while
 * keeping the same convergence: as sigma collapses the three legs go to the
 * indicator of the standing that actually happened.
 */
export function rankOutcomeProbability(
  startRank: number,
  expectedRank: number,
  sigma: number,
  direction: "HIGHER" | "DRAW" | "LOWER"
): number {
  const cdf = (x: number) => normCdf((x - expectedRank) / Math.max(1e-6, sigma));

  // Ranks are integers, so "below startRank" is "at most startRank - 1".
  const higher = cdf(startRank - 0.5);
  const lower = 1 - cdf(startRank + 0.5);
  const draw = Math.max(0, 1 - higher - lower);
  return clamp({ HIGHER: higher, DRAW: draw, LOWER: lower }[direction], 0, 1);
}
