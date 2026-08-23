import { CoinIcon } from "./CoinIcon";
import type { CryptoBet, Direction, Standing } from "./graphql";
import { TopUpCard } from "./TopUp";

const TONE: Record<Direction, { label: string; color: string }> = {
  HIGHER: { label: "Higher", color: "var(--up)" },
  DRAW: { label: "Same", color: "var(--gold)" },
  LOWER: { label: "Lower", color: "var(--down)" },
};

const STATUS: Record<string, string> = {
  OPEN: "open",
  WON: "won",
  LOST: "lost",
  VOID: "void",
  CASHED_OUT: "closed",
};

/** Open positions and settled history for the signed-in player. */
export function Portfolio({
  bets,
  credits,
  standings = [],
}: {
  bets: CryptoBet[];
  credits: number | null;
  /** Live board, used to resolve a logo for each bet's token. */
  standings?: Standing[];
}) {
  const logoFor = new Map(standings.map((s) => [s.symbol, s.imageUrl]));
  const open = bets.filter((b) => b.status === "OPEN");
  const done = bets.filter((b) => b.status !== "OPEN");
  const staked = open.reduce((n, b) => n + b.stake, 0);
  const atRisk = open.reduce((n, b) => n + Math.round(b.stake * b.odds), 0);
  const net = done.reduce((n, b) => n + b.payout - b.stake, 0);

  return (
    <div className="flex flex-col gap-4">
      {/*
        First thing on the page, above the numbers it changes. A player opening
        the portfolio is either checking what they have or adding to it, and the
        second used to require finding a card about allowances and relayers on a
        different tab.
      */}
      <TopUpCard credits={credits} />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="credits" value={credits?.toLocaleString() ?? "—"} />
        <Stat label="open stake" value={staked.toLocaleString()} />
        <Stat label="to win" value={atRisk.toLocaleString()} />
        <Stat
          label="settled P/L"
          value={`${net >= 0 ? "+" : ""}${net.toLocaleString()}`}
          color={net > 0 ? "var(--up)" : net < 0 ? "var(--down)" : undefined}
        />
      </div>

      <Table title="Open positions" bets={open} empty="No open positions this round." logoFor={logoFor} />
      <Table title="History" bets={done} empty="Nothing settled yet." logoFor={logoFor} />
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="rounded-lg border border-hairline bg-surface px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-muted">{label}</div>
      <div className="font-mono text-lg tabular-nums" style={{ color: color ?? "var(--foreground)" }}>
        {value}
      </div>
    </div>
  );
}

function Table({ title, bets, empty, logoFor }: { title: string; bets: CryptoBet[]; empty: string; logoFor: Map<string, string | null> }) {
  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-hairline bg-surface">
      <div className="border-b border-hairline px-4 py-2.5">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      </div>
      {!bets.length ? (
        <p className="px-4 py-6 text-center text-xs text-muted">{empty}</p>
      ) : (
        <ul className="m-0 max-h-[420px] list-none overflow-y-auto overflow-x-hidden p-0">
          {bets.map((b) => {
            const tone = TONE[b.direction];
            const won = b.status === "WON";
            return (
              <li
                key={b.id}
                className="grid w-full items-center gap-2 overflow-hidden border-b border-hairline/60 px-3 py-2 last:border-b-0"
                style={{ gridTemplateColumns: "22px minmax(0,1fr) minmax(0,auto) 56px 62px" }}
              >
                <CoinIcon ticker={b.ticker} src={logoFor.get(b.symbol) ?? null} size={22} />
                <span className="min-w-0">
                  <span className="block truncate text-xs font-semibold text-foreground">
                    {b.ticker}
                    <span className="ml-1.5 font-normal" style={{ color: tone.color }}>
                      {tone.label}
                    </span>
                  </span>
                  <span className="block truncate font-mono text-[10px] tabular-nums text-muted">
                    rank {b.startRank}
                    {b.cutRank != null ? ` → ${b.cutRank}` : " → …"} @ {b.odds.toFixed(2)}x
                  </span>
                </span>
                <span className="font-mono text-[11px] tabular-nums text-muted">{b.stake}</span>
                <span
                  className="truncate text-right font-mono text-[11px]"
                  style={{ color: won ? "var(--up)" : b.status === "LOST" ? "var(--down)" : "var(--text-muted)" }}
                >
                  {STATUS[b.status] ?? b.status}
                </span>
                <span
                  className="text-right font-mono text-xs tabular-nums"
                  style={{ color: won ? "var(--up)" : "var(--text-secondary)" }}
                >
                  {b.status === "OPEN" ? "—" : `${b.payout > 0 ? "+" : ""}${b.payout - b.stake}`}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
