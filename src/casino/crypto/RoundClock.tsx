import { useClock } from "../hooks/useClock";
import type { Round } from "./graphql";

function mmss(ms: number): string {
  if (ms <= 0) return "0:00";
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * The round, in the header.
 *
 * This used to be a bar across the top of the board, which meant it scrolled
 * away and it was possible to be composing a bet with no idea how long was
 * left to place it. The countdown is the one number that is relevant on every
 * screen of the app, so it lives in the case rather than on the page.
 *
 * Betting closes at `lockAt`; the round then settles at a random instant inside
 * the cut window rather than at a fixed deadline, so volume bought at a known
 * settlement time can't decide the outcome. The commitment that makes that
 * verifiable is not shown here — it is a proof, not a reading, and it belongs
 * with the settled round rather than in the chrome of a live one.
 */
export function RoundClock({ round }: { round: Round | null }) {
  useClock(); // re-render once a second so the countdown ticks

  if (!round) {
    return <span className="hidden text-xs text-muted sm:inline">no round yet</span>;
  }

  const now = Date.now();
  const toLock = new Date(round.lockAt).getTime() - now;
  const toEnd = new Date(round.endsAt).getTime() - now;
  const open = round.status === "OPEN" && toLock > 0;

  return (
    <span
      className="flex shrink-0 items-center gap-2"
      title={
        open
          ? "Betting closes when this reaches zero"
          : round.status === "SETTLED"
            ? "This round has settled"
            : `The cut lands at a random point in this ${round.cutWindowSeconds}s window`
      }
    >
      {/* The one genuine display in the chrome, so it is the one thing cut into
          it. Tabular figures because it rewrites every second. */}
      <span className="mat-inset rounded px-2 py-0.5 font-mono text-lg tabular-nums text-foreground">
        {mmss(open ? toLock : toEnd)}
      </span>
    </span>
  );
}
