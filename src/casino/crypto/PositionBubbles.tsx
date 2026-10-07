import { useMemo } from "react";
import { CoinIcon } from "./CoinIcon";

export interface Bubble {
  key: string;
  ticker: string;
  imageUrl: string | null;
  /** What the bubble is sized by. */
  stake: number;
  won: boolean;
  /** Read out in place of the picture, and shown on hover. */
  label: string;
}

/** The narrowest a phone leaves inside the result card. */
const WIDTH = 240;
const HEIGHT = 144;
const MAX_DIAMETER = 96;
/**
 * The smallest bubble's radius, as a share of the largest. Below this a coin
 * mark is a speck and the position might as well not be there, so a stake many
 * times smaller than the biggest one is drawn at this floor instead.
 */
const FLOOR = 0.3;
const GAP = 4;
/** Candidate positions tried around each placed bubble. */
const STEPS = 48;
/**
 * The card is wider than it is tall, so distance from the centre counts
 * vertical drift for more — the cluster spreads sideways rather than up.
 */
const SQUASH = 1.7;

interface Placed {
  x: number;
  y: number;
  r: number;
}

/**
 * Greedy circle packing: largest first, each one tucked in tangent to one
 * already placed, at the free spot nearest the centre. Quadratic-ish, and fine
 * for the handful of positions one player holds in a round.
 */
function pack(radii: number[]): Placed[] {
  const order = radii.map((r, i) => ({ r, i })).sort((a, b) => b.r - a.r);
  const out: Placed[] = new Array(radii.length);
  const placed: Placed[] = [];
  for (const { r, i } of order) {
    let best: Placed = { x: 0, y: 0, r };
    if (placed.length) {
      let bestD = Infinity;
      for (const p of placed) {
        const reach = p.r + r + GAP;
        for (let k = 0; k < STEPS; k++) {
          const a = (k / STEPS) * Math.PI * 2;
          const x = p.x + Math.cos(a) * reach;
          const y = p.y + Math.sin(a) * reach;
          const d = Math.hypot(x, y * SQUASH);
          if (d >= bestD) continue;
          const clear = placed.every(
            (q) => Math.hypot(q.x - x, q.y - y) >= q.r + r + GAP - 1e-6
          );
          if (clear) {
            best = { x, y, r };
            bestD = d;
          }
        }
      }
    }
    placed.push(best);
    out[i] = best;
  }
  return out;
}

/**
 * Every position a settlement closed, as one cluster of coins.
 *
 * Area, not radius, is proportional to stake — a bubble twice as wide reads as
 * four times the bet, so sizing by radius would overstate the big ones.
 * Winners are lit in the up colour; losers sit back, greyed.
 */
export function PositionBubbles({ bubbles }: { bubbles: Bubble[] }) {
  // Memoised because the card re-renders every frame while its total counts up.
  const { radii, placed, minX, minY, width, height, scale } = useMemo(() => {
    const largest = Math.max(...bubbles.map((b) => Math.sqrt(b.stake)), 1);
    const radii = bubbles.map((b) => Math.max(Math.sqrt(b.stake), largest * FLOOR));
    const placed = pack(radii);
    const minX = Math.min(...placed.map((p) => p.x - p.r));
    const minY = Math.min(...placed.map((p) => p.y - p.r));
    const width = Math.max(...placed.map((p) => p.x + p.r)) - minX;
    const height = Math.max(...placed.map((p) => p.y + p.r)) - minY;
    const scale = Math.min(WIDTH / width, HEIGHT / height, MAX_DIAMETER / (2 * largest));
    return { radii, placed, minX, minY, width, height, scale };
  }, [bubbles]);

  return (
    <div
      role="img"
      aria-label={bubbles.map((b) => b.label).join(". ")}
      className="relative mx-auto"
      style={{ width: width * scale, height: height * scale }}
    >
      {bubbles.map((b, i) => {
        const p = placed[i];
        const d = 2 * p.r * scale;
        return (
          <div
            key={b.key}
            title={b.label}
            className="casino-result-pop absolute grid place-items-center rounded-full"
            style={{
              left: (p.x - p.r - minX) * scale,
              top: (p.y - p.r - minY) * scale,
              width: d,
              height: d,
              // Biggest first, matching the order they were packed in.
              animationDelay: `${80 + order(radii, i) * 70}ms`,
              background: b.won
                ? "color-mix(in oklch, var(--up) 16%, transparent)"
                : "color-mix(in oklch, var(--foreground) 5%, transparent)",
              boxShadow: b.won
                ? "inset 0 0 0 1px color-mix(in oklch, var(--up) 55%, transparent), 0 0 18px -6px color-mix(in oklch, var(--up) 70%, transparent)"
                : "inset 0 0 0 1px var(--hairline)",
            }}
          >
            <span className={b.won ? "grid" : "grid opacity-50 grayscale"}>
              {/* A square tile at 0.6 of the diameter clears the circle's edge. */}
              <CoinIcon ticker={b.ticker} src={b.imageUrl} size={Math.round(d * 0.6)} />
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** How many bubbles are bigger than this one — its turn to pop. */
function order(radii: number[], i: number): number {
  return radii.filter((r, j) => r > radii[i] || (r === radii[i] && j < i)).length;
}
