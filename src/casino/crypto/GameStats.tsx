import type { ReactNode } from "react";
import { formatCompact } from "../format";
import { CoinIcon } from "./CoinIcon";

/** One coin in the race, as the stats count it. */
export interface Mover {
  symbol: string;
  ticker: string;
  imageUrl: string | null;
  /** Rank at the open. */
  from: number;
  /** Rank now — or, for a finished round, at the cut. */
  to: number;
  volume: number;
}

/** Places gained since the open; negative for places lost. */
const moved = (m: Mover) => m.from - m.to;

/**
 * The race in three figures, set in the chart's caption row.
 *
 * The caption used to just say what the chart was, which nobody needed telling.
 * What a glance at the top of the board does want is how big the race is and
 * who is moving in it.
 *
 * Movers are expected in board order, so a tie goes to the coin standing higher.
 */
export function GameStats({ movers }: { movers: Mover[] }) {
  const total = movers.reduce((n, m) => n + m.volume, 0);
  const climber = movers.reduce<Mover | null>(
    (best, m) => (moved(m) > (best ? moved(best) : 0) ? m : best),
    null
  );
  const loser = movers.reduce<Mover | null>(
    (worst, m) => (moved(m) < (worst ? moved(worst) : 0) ? m : worst),
    null
  );

  return (
    <span className="flex flex-wrap items-center gap-x-4 gap-y-1 sm:gap-x-6">
      <Stat label="Total volume" short="Vol">
        ${formatCompact(total)}
      </Stat>
      <Stat label="Biggest climber" short={null}>
        <MoverValue mover={climber} />
      </Stat>
      <Stat label="Biggest loser" short={null}>
        <MoverValue mover={loser} />
      </Stat>
    </span>
  );
}

/**
 * A caption and its figure. The caption takes the section heading's own style.
 *
 * On a phone the three would not share a line under their full captions, so
 * each says `short` instead — or nothing, for a mover, whose arrow already says
 * which way it went. The full caption stays for a screen reader either way.
 */
function Stat({
  label,
  short,
  children,
}: {
  label: string;
  short: string | null;
  children: ReactNode;
}) {
  return (
    <span className="flex items-center gap-2">
      <span className="max-sm:sr-only">{label}</span>
      {short && (
        <span aria-hidden="true" className="sm:hidden">
          {short}
        </span>
      )}
      <span className="flex items-center gap-1.5 font-mono text-sm font-normal normal-case tracking-normal tabular-nums text-foreground">
        {children}
      </span>
    </span>
  );
}

function MoverValue({ mover }: { mover: Mover | null }) {
  // Nobody has changed places yet — early in a round, that is the usual answer.
  if (!mover) return <span className="text-muted">—</span>;
  const d = moved(mover);
  return (
    <span className="flex items-center gap-1.5" title={`rank ${mover.from} → ${mover.to}`}>
      <CoinIcon ticker={mover.ticker} src={mover.imageUrl} size={16} />
      <span className="font-sans font-semibold">{mover.ticker}</span>
      <span style={{ color: d > 0 ? "var(--up)" : "var(--down)" }}>
        <span aria-hidden="true">{d > 0 ? "▲" : "▼"}</span> {Math.abs(d)}
      </span>
    </span>
  );
}
