
/**
 * The model behind "where does this coin's rank end up" — not the price.
 *
 * `market.ts` owns prices: a line is worth its share of the credits staked on
 * its coin. This module supplies the one thing a traded price cannot supply for
 * itself — what a line is worth before anybody has traded it — plus the bounds
 * every quote is clamped to. That is now the model's entire say in the game.
 *
 * It used to be more. A second half of this module projected where a rank would
 * land, and the market-making desks quoted against it all round; with the desks
 * gone nothing consults a fair value, because there is nothing left that would
 * act on the difference between one and the market. What the room will pay is
 * what a line is worth.
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
 * Widened from 2c/94c so a line the room has been buying all round can run to
 * where the outcome actually is. The three outcomes sum to a
 * hundred, so with two legs held at the floor a coin with all three lines open
 * tops out at 98c; only a coin whose starting rank closes one leg — rank 1, or
 * last place — can print 99c. Widening cuts both ways and the trade is
 * deliberate: a favourite at the cap now returns 1.01x rather than 1.06x, and a
 * longshot at the floor pays 50x rather than 33x.
 */
export const FLOOR = 0.01;
export const CAP = 0.99;


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
  // Normalised unconditionally, not only on the rank-1 branch below.
  //
  // Three of the four bands were measured to sum to exactly one and one was not:
  // the outside-the-top-ten band is 53/24/22, which is ninety-nine. Every band
  // the board can currently produce sums to 1.0 *exactly* in IEEE754, so this
  // changes no price the game quotes today — but "the coin's three prices sum to
  // a hundred" is an invariant `market.ts` states and `openRound` relies on, and
  // a band that quietly breaks it should not be one board-size change away from
  // being reachable.
  const t: Triple = normalise(bandPrior(startRank));

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
  // third outcome was worth. Which legs open is `openRound`'s decision; this
  // only says what each outcome is worth.
  return t;
}
