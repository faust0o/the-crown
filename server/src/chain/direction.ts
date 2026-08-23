import type { Direction } from "../market";

/**
 * The correspondence between a named direction and its slot in the program's
 * `[_; 3]` arrays.
 *
 * Its own module because both directions of the map are needed in several places
 * — the desks translate a name to an index to price a clip, and anything reading
 * a position translates an index back to a name to describe it — and because the
 * one time this was expressed as a cast instead of a lookup, `"HIGHER" as 0`
 * compiled cleanly, subscripted to `undefined`, read as "this leg is not on the
 * book", and made every desk decline to trade with nothing logging a reason.
 */
export const DIRECTION_INDEX: Record<Direction, 0 | 1 | 2> = {
  HIGHER: 0,
  DRAW: 1,
  LOWER: 2,
};

/** The inverse: an on-chain index back to the name the API and UI use. */
export const DIRECTION_NAME = ["HIGHER", "DRAW", "LOWER"] as const satisfies readonly Direction[];
