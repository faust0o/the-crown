import { useQuery } from "@apollo/client/react";
import { useMemo } from "react";
import { formatCompact } from "../format";
import { Button, Empty, IconButton, Section, Tag } from "../ui";
import { CoinIcon } from "./CoinIcon";
import { FlowFeed } from "./FlowFeed";
import { GameStats, type Mover } from "./GameStats";
import {
  ROUND_REPLAY,
  type CryptoBet,
  type Direction,
  type FlowEvent,
  type RankPoint,
  type ResultEntry,
  type RoundResult,
  type Standing,
} from "./graphql";
import { useRoundVerification } from "./verify";
import { VolumeChart } from "./VolumeChart";

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

/** What a token's start-to-cut move paid, or null if it never got a cut. */
function outcomeOf(startRank: number, cutRank: number | null): Direction | null {
  if (cutRank == null) return null;
  if (cutRank < startRank) return "HIGHER";
  if (cutRank > startRank) return "LOWER";
  return "DRAW";
}

const hhmm = (t: string | number) =>
  new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

const hhmmss = (t: string | number) => new Date(t).toLocaleTimeString();

interface Meta {
  ticker: string;
  name: string;
  imageUrl: string | null;
}

/**
 * The round's rank changes, rebuilt from its samples.
 *
 * The live feed is derived the same way, but server-side and from the oracle's
 * in-memory buffer — which only reaches back an hour or so. A replay has to work
 * off the persisted samples the chart already fetches, and the derivation is
 * cheap enough to redo here rather than adding a second round trip.
 */
function flowFrom(history: RankPoint[], meta: Map<string, Meta>): FlowEvent[] {
  const byTime = new Map<number, RankPoint[]>();
  for (const p of history) {
    const at = byTime.get(p.t);
    if (at) at.push(p);
    else byTime.set(p.t, [p]);
  }

  const out: FlowEvent[] = [];
  let previous: Map<string, number> | null = null;
  for (const t of [...byTime.keys()].sort((a, b) => a - b)) {
    const points = byTime.get(t)!;
    if (previous) {
      for (const p of points) {
        const from = previous.get(p.symbol) ?? null;
        if (from === p.rank) continue;
        out.push({
          at: t,
          symbol: p.symbol,
          ticker: meta.get(p.symbol)?.ticker ?? p.symbol,
          imageUrl: meta.get(p.symbol)?.imageUrl ?? null,
          from,
          to: p.rank,
          quoteVolume: p.quoteVolume,
        });
      }
    }
    previous = new Map(points.map((p) => [p.symbol, p.rank]));
  }
  return out.reverse(); // newest first, like the live feed
}

/**
 * A settled round, replayed in place of the live board.
 *
 * Nothing here is bettable and nothing here polls: the race is over, so every
 * number on the page is the one the round finished on. The buy panel's slot goes
 * to the resolution — how the round ended, whether its cut verifies, and what it
 * did to the player's balance.
 */
export function RoundReplay({
  round,
  standings,
  justEnded = false,
  onExit,
}: {
  round: RoundResult;
  /** Live board. Only a backstop now that the round carries its own logos. */
  standings: Standing[];
  /** The round ended under the player, rather than being picked off the list. */
  justEnded?: boolean;
  onExit: () => void;
}) {
  const { data, loading } = useQuery(ROUND_REPLAY, {
    variables: { roundId: round.id },
    fetchPolicy: "cache-and-network",
  });

  const history = useMemo(() => data?.roundReplay ?? [], [data]);
  const tokens = useMemo(() => data?.roundTokens ?? [], [data]);
  const bets = useMemo(() => data?.myCryptoBets ?? [], [data]);

  const meta = useMemo(() => {
    // Widest source first, narrowest last. `roundTokens` covers every coin the
    // round touched — including ones that only climbed onto the board mid-round,
    // which appear in the samples and so in the flow without ever being entries.
    // The live board is only a stand-in for a token seen for the first time
    // since the server last wrote its identity down, and the entries win
    // outright because their tickers are the ones the round was scored under.
    const m = new Map<string, Meta>();
    for (const s of standings) {
      m.set(s.symbol, { ticker: s.ticker, name: s.name, imageUrl: s.imageUrl });
    }
    for (const t of tokens) {
      m.set(t.symbol, { ticker: t.ticker, name: t.name, imageUrl: t.imageUrl });
    }
    for (const e of round.entries) {
      const known = m.get(e.symbol);
      m.set(e.symbol, {
        ticker: e.ticker,
        name: known?.name ?? e.ticker,
        imageUrl: e.imageUrl ?? known?.imageUrl ?? null,
      });
    }
    return m;
  }, [round.entries, standings, tokens]);

  // Volume as of the last sample of the round, not the token's volume now —
  // this is a replay, so every figure on the page belongs to the round.
  const cutVolume = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of history) m.set(p.symbol, p.quoteVolume); // oldest first
    return m;
  }, [history]);

  const finished = useMemo(
    () => [...round.entries].sort((a, b) => (a.cutRank ?? 99) - (b.cutRank ?? 99)),
    [round.entries]
  );

  // The chart plots each coin's share of the field, so the field has to be the
  // round's ten — the samples also carry whatever climbed onto the board while
  // the round ran, and counting those into the total would shrink every share.
  const chartHistory = useMemo(() => {
    const field = new Set(round.entries.map((e) => e.symbol));
    return history.filter((p) => field.has(p.symbol));
  }, [history, round.entries]);

  // The chart wants standings; the round's final ordering is what it gets.
  const asStandings = useMemo<Standing[]>(
    () =>
      finished.map((e) => ({
        symbol: e.symbol,
        ticker: e.ticker,
        name: meta.get(e.symbol)?.name ?? e.ticker,
        imageUrl: meta.get(e.symbol)?.imageUrl ?? null,
        rank: e.cutRank ?? e.startRank,
        previousRank: e.startRank,
        quoteVolume: cutVolume.get(e.symbol) ?? 0,
        price: 0,
        trades1h: 0,
        wallets1h: 0,
        priceChange1hPercent: 0,
      })),
    [finished, meta, cutVolume]
  );

  // The live board's stats, as the round finished: open to cut, and the
  // volume at the last sample. A coin with no cut is counted where it opened.
  const movers = useMemo<Mover[]>(
    () =>
      finished.map((e) => ({
        symbol: e.symbol,
        ticker: e.ticker,
        imageUrl: meta.get(e.symbol)?.imageUrl ?? null,
        from: e.startRank,
        to: e.cutRank ?? e.startRank,
        volume: cutVolume.get(e.symbol) ?? 0,
      })),
    [finished, meta, cutVolume]
  );
  const stats = <GameStats movers={movers} />;

  const flow = useMemo(() => flowFrom(history, meta), [history, meta]);

  return (
    <div className="flex flex-col gap-5">
      <ReplayBar round={round} justEnded={justEnded} onExit={onExit} />

      {/*
        Two columns where there is room. Narrower, the columns dissolve
        (`contents`) and their sections stack in the order a phone wants them:
        how the round ended first — the reason anyone opens a replay — then the
        race that got there, then the player's own fills. The flow is left out
        there: it is the same rank changes the final board already states.
      */}
      <div className="flex flex-col gap-5 lg:grid lg:grid-cols-[1fr_320px]">
        <div className="contents lg:flex lg:min-w-0 lg:flex-col lg:gap-5">
          <div className="min-w-0 max-lg:order-2">
            {chartHistory.length ? (
              // Keyed so picking another round from the list remounts it: a
              // paused chart holds the data it first drew, and its clock with it.
              <VolumeChart
                key={round.id}
                title={stats}
                history={chartHistory}
                standings={asStandings}
                window="round"
                replay
              />
            ) : (
              <Section title={stats}>
                <Empty>
                  {loading ? "loading the round…" : "No samples were recorded for this round."}
                </Empty>
              </Section>
            )}
          </div>
          <div className="min-w-0 max-lg:order-3">
            <FinalBoard entries={finished} meta={meta} cutVolume={cutVolume} />
          </div>
        </div>

        <div className="contents lg:flex lg:min-w-0 lg:flex-col lg:gap-5">
          <div className="min-w-0 max-lg:order-1">
            <Resolution round={round} bets={bets} meta={meta} cutVolume={cutVolume} />
          </div>
          <div className="min-w-0 max-lg:order-4">
            <TxLog bets={bets} meta={meta} />
          </div>
          <div className="min-w-0 max-lg:hidden">
            <FlowFeed events={flow} note="replay" />
          </div>
        </div>
      </div>
    </div>
  );
}

function ReplayBar({
  round,
  justEnded,
  onExit,
}: {
  round: RoundResult;
  justEnded: boolean;
  onExit: () => void;
}) {
  return (
    <div className="casino-animate-in flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-hairline pb-3">
      <Tag tone="gold">{justEnded ? "round over" : "replay"}</Tag>
      <span className="font-mono text-sm tabular-nums text-foreground">
        {hhmm(round.startsAt)} – {hhmm(round.endsAt)}
      </span>
      {/* Said once, where there is room to. On a phone the tag already says it,
          and the sentence took three lines above the thing it described. */}
      <span className="text-xs text-muted max-sm:hidden">
        {justEnded
          ? "That round just settled — here is how it finished. The next one is already running."
          : "This round is over — the board below is where it finished, and nothing on it can be backed."}
      </span>
      <Button size="sm" onClick={onExit} className="ml-auto">
        <span className="sm:hidden">{justEnded ? "New round" : "Back to live"}</span>
        <span className="max-sm:hidden">
          {justEnded ? "Go to the new round" : "Back to the live round"}
        </span>
      </Button>
    </div>
  );
}

/**
 * The round that just settled, announced over the live board.
 *
 * It used to take the board over outright — the next round was already running
 * and the page froze on the last one's numbers. Now the board stays live and the
 * finished round is one press away, with the one fact most people want from it
 * on the bar itself.
 */
export function RoundOverBar({
  round,
  onOpen,
  onDismiss,
}: {
  round: RoundResult;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  const winner = round.entries.find((e) => e.cutRank === 1) ?? null;

  return (
    <div className="casino-animate-in flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-hairline pb-3">
      <Tag tone="gold">round over</Tag>
      <span className="font-mono text-sm tabular-nums text-foreground max-sm:hidden">
        {hhmm(round.startsAt)} – {hhmm(round.endsAt)}
      </span>
      {winner ? (
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
          <CoinIcon ticker={winner.ticker} src={winner.imageUrl} size={18} />
          <span className="font-semibold text-foreground">{winner.ticker}</span> took the crown
        </span>
      ) : (
        <span className="text-xs text-muted">No cut was recorded for that round.</span>
      )}
      <span className="ml-auto flex items-center gap-2">
        <Button size="sm" onClick={onOpen}>
          <span className="sm:hidden">Replay</span>
          <span className="max-sm:hidden">See how it finished</span>
        </Button>
        <IconButton label="Dismiss" size="sm" onClick={onDismiss}>
          <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true" fill="none">
            <path
              d="M7 7l10 10M17 7L7 17"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </IconButton>
      </span>
    </div>
  );
}

/**
 * Where the field finished.
 *
 * Deliberately not `RankBoard`: that board exists to be traded on, and every
 * price it quotes is a live one. Here the only honest thing to show in the
 * column the price chips occupy is which side the token's move actually paid.
 */
function FinalBoard({
  entries,
  meta,
  cutVolume,
}: {
  entries: ResultEntry[];
  meta: Map<string, Meta>;
  cutVolume: Map<string, number>;
}) {
  const total = entries.reduce((n, e) => n + (cutVolume.get(e.symbol) ?? 0), 0);

  return (
    <Section
      title="The Field at the cut"
      aside={
        <span className="font-mono tabular-nums">
          ${formatCompact(total)} · open → cut
        </span>
      }
    >
      <ol className="m-0 list-none p-0">
        {entries.map((e) => {
          const outcome = outcomeOf(e.startRank, e.cutRank);
          const delta = e.cutRank == null ? 0 : e.startRank - e.cutRank;
          const dropped = e.cutRank != null && e.cutRank > entries.length;
          // A token can fall off the board before the first sample of the round
          // catches it, and "$0" would read as a token that stopped trading.
          const volume = cutVolume.get(e.symbol);
          return (
            <li
              key={e.symbol}
              className="grid grid-cols-[20px_12px_28px_minmax(0,1fr)_64px] items-center gap-2 border-b border-[var(--bevel-lo)] px-1.5 py-2.5 last:border-b-0 sm:grid-cols-[24px_12px_28px_minmax(0,1fr)_76px] sm:gap-3 sm:px-4"
            >
              <span className="grid place-items-center font-mono text-lg tabular-nums leading-none text-muted">
                {dropped ? "—" : (e.cutRank ?? "—")}
              </span>
              <span
                aria-hidden="true"
                className="text-xs"
                style={{
                  color: delta > 0 ? "var(--up)" : delta < 0 ? "var(--down)" : "transparent",
                }}
              >
                {delta > 0 ? "▲" : delta < 0 ? "▼" : "•"}
              </span>
              <CoinIcon ticker={e.ticker} src={meta.get(e.symbol)?.imageUrl ?? null} size={28} />
              <span className="min-w-0">
                <span className="block truncate font-semibold text-foreground">
                  {e.ticker}
                  {e.cutRank === 1 && (
                    <span title="Took the crown" className="ml-1.5">
                      👑
                    </span>
                  )}
                </span>
                <span className="block truncate font-mono text-[11px] tabular-nums text-muted">
                  rank {e.startRank} → {dropped ? "off the board" : (e.cutRank ?? "—")}
                  {volume != null && ` · $${formatCompact(volume)}`}
                  {e.isCrown && <span className="ml-1.5">· crowned at the open, no book</span>}
                </span>
              </span>
              <span
                className="w-full justify-self-end rounded-md border px-1 py-1 text-center text-[10px] font-semibold uppercase tracking-wide sm:px-2"
                style={{
                  color: outcome ? TONE[outcome].color : "var(--text-muted)",
                  borderColor: outcome
                    ? `color-mix(in oklch, ${TONE[outcome].color} 35%, transparent)`
                    : "var(--hairline)",
                  backgroundColor: outcome
                    ? `color-mix(in oklch, ${TONE[outcome].color} 7%, transparent)`
                    : "transparent",
                }}
                title={outcome ? `${TONE[outcome].label} paid on ${e.ticker}` : "No cut recorded"}
              >
                {outcome ? TONE[outcome].label : "—"}
              </span>
            </li>
          );
        })}
      </ol>
    </Section>
  );
}

/** How the round ended, whether its cut verifies, and what it paid the player. */
function Resolution({
  round,
  bets,
  meta,
  cutVolume,
}: {
  round: RoundResult;
  bets: CryptoBet[];
  meta: Map<string, Meta>;
  cutVolume: Map<string, number>;
}) {
  const verdict = useRoundVerification(round);
  const winner = round.entries.find((e) => e.cutRank === 1) ?? null;
  const staked = bets.reduce((n, b) => n + b.stake, 0);
  const returned = bets.reduce((n, b) => n + b.payout, 0);
  const net = returned - staked;

  return (
    // Uncaptioned: the winner's line at its top already says what it is. Still
    // named for a screen reader, which has no line to read it from.
    <section aria-label="Resolution" className="mb-4 flex min-w-0 flex-col">
      <div className="flex items-center gap-3 border-b border-hairline pb-3">
        {winner ? (
          <>
            <CoinIcon
              ticker={winner.ticker}
              src={meta.get(winner.symbol)?.imageUrl ?? null}
              size={32}
            />
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-foreground">
                {winner.ticker} <span className="font-normal text-muted">took the crown</span>
              </div>
              <div className="font-mono text-[11px] tabular-nums text-muted">
                rank {winner.startRank} → 1 · ${formatCompact(cutVolume.get(winner.symbol) ?? 0)}
              </div>
            </div>
          </>
        ) : (
          <span className="text-sm text-muted">No cut was recorded for this round.</span>
        )}
      </div>

      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 border-b border-hairline py-3 font-mono text-[11px] tabular-nums">
        <dt className="text-muted">opened</dt>
        <dd className="m-0 text-right text-secondary">{hhmm(round.startsAt)}</dd>
        <dt className="text-muted">locked</dt>
        <dd className="m-0 text-right text-secondary">{hhmm(round.lockAt)}</dd>
        <dt className="text-muted">cut</dt>
        <dd className="m-0 text-right text-secondary">
          {round.cutAt ? hhmmss(round.cutAt) : "—"}
        </dd>
        <dt className="text-muted">commitment</dt>
        <dd
          className="m-0 truncate text-right"
          title={
            round.seed
              ? `seed ${round.seed}\nsha256(seed) must equal ${round.commitHash}`
              : "the seed is published once the round settles"
          }
          style={{
            color:
              verdict === "verified"
                ? "var(--up)"
                : verdict === "mismatch"
                  ? "var(--down)"
                  : "var(--text-muted)",
          }}
        >
          {verdict === "pending"
            ? "verifying…"
            : verdict === "verified"
              ? "verified ✓"
              : "mismatch"}
        </dd>
      </dl>

      <div className="pt-3">
        <div className="mat-engrave mb-1.5 text-[10px] uppercase tracking-wider text-muted">
          your round
        </div>
        {bets.length ? (
          <div className="flex items-baseline justify-between gap-2 font-mono text-xs tabular-nums">
            <span className="text-muted">
              {bets.length} {bets.length === 1 ? "position" : "positions"} · staked {staked}
            </span>
            <span
              style={{
                color: net > 0 ? "var(--up)" : net < 0 ? "var(--down)" : "var(--text-muted)",
              }}
              title={`returned ${returned} credits`}
            >
              {net > 0 ? "+" : ""}
              {net}
            </span>
          </div>
        ) : (
          <p className="m-0 text-xs text-muted">You had no positions in this round.</p>
        )}
      </div>
    </section>
  );
}

/** Every lot the player took on this round, oldest first — the round as a log. */
function TxLog({ bets, meta }: { bets: CryptoBet[]; meta: Map<string, Meta> }) {
  const ordered = useMemo(
    () =>
      [...bets].sort(
        (a, b) => new Date(a.openedAt).getTime() - new Date(b.openedAt).getTime()
      ),
    [bets]
  );

  return (
    <Section
      title="Tx log"
      aside={ordered.length ? `${ordered.length} filled` : "your bets"}
    >
      <ul className="m-0 max-h-[300px] min-w-0 list-none overflow-y-auto overflow-x-hidden p-0">
        {ordered.map((b) => {
          const tone = TONE[b.direction];
          const pnl = b.payout - b.stake;
          return (
            <li
              key={b.id}
              className="grid w-full items-center gap-2 overflow-hidden rounded border-b border-[var(--bevel-lo)] px-2 py-1.5 last:border-b-0"
              style={{ gridTemplateColumns: "18px minmax(0,1fr) minmax(0,auto)" }}
            >
              <CoinIcon ticker={b.ticker} src={meta.get(b.symbol)?.imageUrl ?? null} size={18} />
              <span className="min-w-0">
                <span className="flex min-w-0 items-baseline gap-1.5">
                  <span className="truncate font-mono text-xs font-semibold text-foreground">
                    {b.ticker}
                  </span>
                  <span className="shrink-0 text-[11px]" style={{ color: tone.color }}>
                    {tone.label}
                  </span>
                </span>
                <span className="block truncate font-mono text-[10px] tabular-nums text-muted">
                  {hhmmss(b.openedAt)} · {b.stake} @ {b.odds.toFixed(2)}x
                </span>
              </span>
              <span className="min-w-0 text-right">
                <span
                  className="block font-mono text-xs tabular-nums"
                  style={{
                    color:
                      b.status === "WON"
                        ? "var(--up)"
                        : b.status === "LOST"
                          ? "var(--down)"
                          : "var(--text-secondary)",
                  }}
                >
                  {b.status === "OPEN" ? "—" : `${pnl > 0 ? "+" : ""}${pnl}`}
                </span>
                <span className="block font-mono text-[10px] text-muted">
                  {STATUS[b.status] ?? b.status}
                </span>
              </span>
            </li>
          );
        })}
        {!ordered.length && (
          <li>
            <Empty>no positions on this round</Empty>
          </li>
        )}
      </ul>
    </Section>
  );
}
