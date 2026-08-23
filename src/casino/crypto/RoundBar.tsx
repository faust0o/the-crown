import { formatCredits } from "../format";
import { useClock } from "../hooks/useClock";
import type { Round } from "./graphql";

function mmss(ms: number): string {
  if (ms <= 0) return "0:00";
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Round state and the countdown.
 *
 * Betting closes at `lockAt`; the round then settles at a random instant inside
 * the cut window rather than at a fixed deadline, so volume bought at a known
 * settlement time can't decide the outcome. The instant is committed up front
 * (sha256 of a seed) and the seed is published afterwards, so the cut is
 * verifiable rather than merely unpredictable.
 */
export function RoundBar({ round, credits }: { round: Round | null; credits: number | null }) {
  useClock(); // re-render once a second so the countdown ticks
  if (!round) {
    return (
      <div className="px-1 py-1 text-sm text-muted">waiting for the first round…</div>
    );
  }

  const now = Date.now();
  const toLock = new Date(round.lockAt).getTime() - now;
  const toEnd = new Date(round.endsAt).getTime() - now;
  const open = round.status === "OPEN" && toLock > 0;

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-1">
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className={`inline-block h-2 w-2 rounded-full ${open ? "" : "casino-pulse"}`}
          style={{ background: open ? "var(--up)" : "var(--gold)" }}
        />
        <span className="text-sm font-semibold text-foreground">
          {open ? "Betting open" : round.status === "SETTLED" ? "Settled" : "Cutting"}
        </span>
      </div>

      <div className="flex items-baseline gap-2">
        <span className="text-[11px] uppercase tracking-wider text-muted">
          {open ? "closes in" : "round ends"}
        </span>
        <span className="font-mono text-lg tabular-nums text-foreground">
          {mmss(open ? toLock : toEnd)}
        </span>
      </div>

      {!open && round.status !== "SETTLED" && (
        <span className="text-xs text-secondary">
          cut lands at a random point in this {round.cutWindowSeconds}s window
        </span>
      )}

      <div className="ml-auto flex items-center gap-4">
        {credits != null && (
          <span className="font-mono text-sm tabular-nums text-foreground">
            {formatCredits(credits)}
          </span>
        )}
        <span
          className="hidden font-mono text-[11px] text-muted sm:inline"
          title={
            round.seed
              ? `seed ${round.seed}\nsha256(seed) must equal the commitment shown before the cut`
              : "sha256(seed) — published before the cut, seed revealed after"
          }
        >
          {round.seed ? "revealed " : "commit "}
          {round.commitHash.slice(0, 10)}…
        </span>
      </div>
    </div>
  );
}
