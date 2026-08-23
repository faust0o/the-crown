import { useMutation, useQuery } from "@apollo/client/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { SessionProvider, useSession } from "../session/SessionProvider";
import { BetFlow } from "./BetFlow";
import { BetPanel } from "./BetPanel";
import { BetResult } from "./BetResult";
import { BotTape } from "./BotTape";
import { FlowFeed } from "./FlowFeed";
import {
  BOARD,
  CASH_OUT,
  PLACE_BET,
  ROUNDS,
  type Direction,
  type Round,
  type Standing,
} from "./graphql";
import { HowItWorks } from "./HowItWorks";
import { InviteDialog } from "./InviteDialog";
import { Portfolio } from "./Portfolio";
import { PreviousRounds } from "./PreviousRounds";
import { RankBoard } from "./RankBoard";
import { RoundBar } from "./RoundBar";
import { RoundReplay } from "./RoundReplay";
import { VolumeChart } from "./VolumeChart";
import { WalletButton } from "./WalletButton";

/** Matches the oracle's own re-rank cadence — no point polling faster. */
const POLL_MS = 2_000;

type Tab = "board" | "portfolio";

/** Set the document title while this page is mounted, restoring it on exit. */
function useTitle(title: string) {
  useEffect(() => {
    const previous = document.title;
    document.title = title;
    return () => {
      document.title = previous;
    };
  }, [title]);
}

/**
 * Fly the crown in the tab while this page is mounted.
 *
 * index.html already ships the crown icon, so a cold load needs nothing from
 * this. It stays for the same reason the title effect does: the icon is a
 * property of the page being mounted, not of the document it happened to
 * arrive in.
 */
function useFavicon(href: string, type: string) {
  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) return;
    const previous = { href: link.href, type: link.type };
    link.href = href;
    link.type = type;
    return () => {
      link.href = previous.href;
      link.type = previous.type;
    };
  }, [href, type]);
}

/**
 * The crown: the ten most-traded trending assets, competing on volume.
 *
 * One page. The board is the market, the flow feed lists every rank change this
 * round, and every token's three-way book sits on its own row.
 */
export default function CryptoPage() {
  return (
    <SessionProvider>
      <CrownInner />
    </SessionProvider>
  );
}

function CrownInner() {
  useTitle("The Crown · Utopian Contributors");
  useFavicon("/crown-icon.svg", "image/svg+xml");
  const { user, login, logout } = useSession();
  const { disconnect: disconnectWallet } = useWallet();
  const [tab, setTab] = useState<Tab>("board");
  const [howOpen, setHowOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [pastOpen, setPastOpen] = useState(false);
  // A settled round — picked out of the list, or the one they were just
  // watching. Either way the board tab replays it until they come back.
  const [replay, setReplay] = useState<Round | null>(null);
  const [replayIsFresh, setReplayIsFresh] = useState(false);
  /** The round that ended under the player, waiting on its settlement. */
  const [ended, setEnded] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [direction, setDirection] = useState<Direction>("HIGHER");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const { data, loading, error, refetch } = useQuery(BOARD, {
    // Ask for the full buffer, not just this round: the chart should always
    // be a continuous line filling its container, so it draws whatever we hold
    // — including data from before the round opened.
    variables: { tape: 200, minutes: 90 },
    pollInterval: POLL_MS,
    fetchPolicy: "cache-and-network",
    // Keep whatever resolved, even when a field in the same document did not.
    //
    // This query asks for the board, the tape, the oracle *and* `myCryptoBets`,
    // and that last one throws for a caller with no session. Under Apollo's
    // default policy one erroring field discards `data` for the whole document,
    // so a logged-out visitor got `undefined` for all of it — a blank board, an
    // "oracle down" tape and "waiting for the first round…" on a round that was
    // demonstrably open. Nothing was broken; the page simply threw away the
    // answer because it had also asked a question it was not entitled to.
    //
    // The guard stays as it is. A composite document polled every couple of
    // seconds should degrade field by field, not all at once, and that is a
    // property worth having whichever field fails next.
    errorPolicy: "all",
  });
  const [placeBet] = useMutation(PLACE_BET);
  const [cashOut] = useMutation(CASH_OUT);
  const [closing, setClosing] = useState<string | null>(null);

  const standings = useMemo(() => data?.cryptoStandings ?? [], [data?.cryptoStandings]);
  const round = data?.cryptoRound ?? null;
  const status = data?.oracleStatus;

  // Hand the player the replay of the round they were just watching, rather
  // than rolling them silently into the next one.
  //
  // The trigger is the live round's id changing: rounds are back-to-back, so
  // the next one opens within a tick of the old one ending. Waiting for the
  // *next* round rather than for `endsAt` to pass also means the round we want
  // is by then a real settled row, seed and all.
  const watching = useRef<string | null>(null);
  useEffect(() => {
    const id = round?.id;
    if (!id) return; // briefly between rounds — nothing has changed hands yet
    if (watching.current && watching.current !== id) setEnded(watching.current);
    watching.current = id;
  }, [round?.id]);

  // Settlement lands a tick or two after the round ends, so the round is asked
  // for until it comes back SETTLED — and given up on if it never does.
  const { data: recent } = useQuery(ROUNDS, {
    variables: { limit: 3 },
    skip: !ended,
    pollInterval: POLL_MS,
    fetchPolicy: "cache-and-network",
  });
  useEffect(() => {
    if (!ended) return;
    if (replay) {
      setEnded(null); // already reading some other round — don't yank them out of it
      return;
    }
    const settled = (recent?.cryptoRounds ?? []).find(
      (r) => r.id === ended && r.status === "SETTLED"
    );
    if (!settled) return;
    setReplay(settled);
    setReplayIsFresh(true);
    setEnded(null);
  }, [ended, replay, recent]);
  useEffect(() => {
    if (!ended) return;
    const timer = setTimeout(() => setEnded(null), 120_000);
    return () => clearTimeout(timer);
  }, [ended]);

  // Only moves from this round. Filtered client-side on purpose — deriving a
  // query variable from the query's own result is what caused the render loop.
  const roundStart = round ? new Date(round.startsAt).getTime() : 0;
  const roundFlow = useMemo(
    () => (data?.cryptoFlow ?? []).filter((e) => e.at >= roundStart),
    [data?.cryptoFlow, roundStart]
  );

  const entries = useMemo(
    () => new Map((round?.entries ?? []).map((e) => [e.symbol, e])),
    [round]
  );

  /**
   * The field: every coin the board has to show, which is not the same set as
   * the live top ten.
   *
   * A coin that opened in the round and has since been pushed off the board is
   * still in the race — it can still be bet, it still holds positions, and
   * falling off the board is exactly the outcome its LOWER line describes. It
   * used to vanish from the board the moment it dropped, which took the one row
   * a player most needed to act on and removed it. It now stays, standing where
   * the cut will score it: one below the last visible slot, the same place the
   * server and the market both put it.
   *
   * A coin that trended in after the round opened is the mirror case and belongs
   * here too, but as a spectator — the row explains it is in from the next round
   * and carries no book. Only the chart excludes it, because a line drawn in a
   * race the coin is not running is a claim rather than a caption.
   *
   * Between rounds there is no field, and the live board is all there is.
   */
  const field = useMemo<Standing[]>(() => {
    if (!round?.entries.length) return standings;
    const live = new Map(standings.map((s) => [s.symbol, s]));
    const inRound = round.entries.map(
      (e): Standing =>
        live.get(e.symbol) ?? {
          symbol: e.symbol,
          ticker: e.ticker,
          name: e.ticker,
          // `liveRank` is where the server stands a dropped coin, which is below
          // every visible slot. Several can share it, and that is not a glitch —
          // settlement scores them all at the same place.
          rank: e.liveRank ?? e.startRank,
          previousRank: null,
          // Still trading, just not on the board — so the row carries its real
          // numbers rather than the "$0 · —" that made a live coin look dead.
          quoteVolume: e.liveVolume,
          price: e.livePrice,
          imageUrl: e.imageUrl,
          trades1h: 0,
          wallets1h: 0,
          priceChange1hPercent: 0,
        }
    );
    const entered = new Set(round.entries.map((e) => e.symbol));
    const newcomers = standings.filter((s) => !entered.has(s.symbol));
    return [...inRound, ...newcomers].sort((a, b) => a.rank - b.rank);
  }, [round, standings]);
  const allBets = useMemo(() => data?.myCryptoBets ?? [], [data?.myCryptoBets]);

  // Credits come from the polled query, not the session's one-shot ME — the
  // balance changes server-side the moment a round settles, and reading it from
  // a query fetched once at login meant the header never moved.
  const credits = data?.me?.credits ?? user?.credits ?? null;

  // Surface each bet's outcome exactly once, as it flips out of OPEN.
  const [result, setResult] = useState<(typeof allBets)[number] | null>(null);
  const seen = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    const queue: typeof allBets = [];
    for (const b of allBets) {
      const was = seen.current.get(b.id);
      if (was && was === "OPEN" && b.status !== "OPEN") queue.push(b);
      seen.current.set(b.id, b.status);
    }
    if (queue.length) setResult((cur) => cur ?? queue[0]);
  }, [allBets]);
  const roundBets = useMemo(
    () => allBets.filter((b) => b.roundId === round?.id),
    [allBets, round?.id]
  );

  const open = round?.status === "OPEN" && new Date(round.lockAt).getTime() > Date.now();
  const bettable = Boolean(user) && open;
  const disabledReason = !user
    ? "Redeem an invite code to place a bet."
    : !open
      ? "Betting is closed for this round."
      : null;

  // Default the ticket to whoever leads, so the panel is never empty.
  const activeSymbol = selected ?? field[0]?.symbol ?? null;
  const activeStanding = field.find((s) => s.symbol === activeSymbol) ?? null;
  const activeEntry = activeSymbol ? (entries.get(activeSymbol) ?? null) : null;
  const activeBets = roundBets.filter((b) => b.symbol === activeSymbol);

  /**
   * Is there anything for the buy panel to do?
   *
   * A balance is the usual answer, but not the only one: the panel also carries
   * the position list and its Close controls, so a player who has spent their
   * last dollar into a position still needs it. Keying purely on the balance
   * would take the exit away from the one person guaranteed to be looking for it.
   */
  const charged = (credits ?? 0) > 0 || roundBets.length > 0;

  const onSelect = useCallback((symbol: string, dir?: Direction) => {
    setSelected(symbol);
    if (dir) setDirection(dir);
  }, []);

  const onPlace = useCallback(
    async (stake: number) => {
      if (!user) {
        setInviteOpen(true);
        return;
      }
      if (!activeSymbol) return;
      setBusy(true);
      try {
        await placeBet({ variables: { symbol: activeSymbol, direction, stake } });
        await refetch();
      } catch (err) {
        setToast(err instanceof Error ? err.message : "Could not place that bet.");
        setTimeout(() => setToast(null), 4000);
      } finally {
        setBusy(false);
      }
    },
    [user, placeBet, activeSymbol, direction, refetch]
  );

  const onClosePosition = useCallback(
    async (id: string) => {
      setClosing(id);
      try {
        await cashOut({ variables: { id } });
        await refetch();
      } catch (err) {
        setToast(err instanceof Error ? err.message : "Could not close that position.");
        setTimeout(() => setToast(null), 4000);
      } finally {
        setClosing(null);
      }
    },
    [cashOut, refetch]
  );

  return (
    <div className="casino flex min-h-dvh flex-col">
      <header className="border-b border-hairline">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-3">
          <a href="/" className="flex items-center gap-2.5 no-underline">
            <img
              src="/crown-icon.svg"
              alt=""
              aria-hidden="true"
              width={28}
              height={28}
              className="h-7 w-7 shrink-0 rounded"
            />
            <span className="flex flex-col leading-tight">
              <span className="text-lg font-semibold text-foreground">The Crown</span>
              <span className="hidden text-xs text-muted sm:block">ten trending assets, one ranking</span>
            </span>
          </a>

          <nav role="tablist" aria-label="Section" className="flex items-center gap-1 rounded-lg border border-hairline bg-inset p-1">
            {(["board", "portfolio"] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={`rounded px-2.5 py-1 text-xs capitalize transition-colors ${
                  tab === t ? "bg-surface font-semibold text-foreground" : "text-muted"
                }`}
              >
                {t}
              </button>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-4">
            <button
              type="button"
              onClick={() => setPastOpen(true)}
              className="hidden text-xs text-secondary hover:text-foreground sm:block"
            >
              Previous rounds
            </button>
            <button
              type="button"
              onClick={() => setHowOpen(true)}
              aria-label="How it works"
              title="How it works"
              className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-muted transition-colors hover:text-foreground"
            >
              <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true" fill="none">
                <circle cx="12" cy="12" r="9.25" stroke="currentColor" strokeWidth="1.5" />
                <path
                  d="M9.6 9.2a2.5 2.5 0 1 1 3.2 2.4c-.6.2-.9.7-.9 1.3v.5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
                <circle cx="11.9" cy="16.4" r="0.95" fill="currentColor" />
              </svg>
            </button>
            {/*
              Beside the invite button, never instead of it. A wallet is a second
              identity that removes the prompt from every bet; the code is still
              what makes an account.
            */}
            <WalletButton />
            {user ? (
              <>
                <span className="font-mono text-sm tabular-nums text-foreground">
                  {(credits ?? 0).toLocaleString()}
                  <span className="ml-1 text-muted">cr</span>
                </span>
                {/*
                  The only way out, and it takes the wallet with it.

                  There used to be a second one — "Disconnect", in the wallet
                  menu — which left the account signed in with its credits
                  on-chain and no wallet to reach them through: every control
                  live, nothing workable, and no way to tell from the screen that
                  the two exits meant different things. A player's wallet is how
                  they play, so ending the session ends both.
                */}
                <button
                  type="button"
                  onClick={() => {
                    void disconnectWallet().catch(() => {});
                    logout();
                  }}
                  className="text-xs text-muted hover:text-foreground"
                >
                  Log out
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setInviteOpen(true)}
                className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-white"
              >
                Enter invite code
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-5">
        {tab === "portfolio" ? (
          <Portfolio bets={allBets} credits={credits} standings={standings} />
        ) : replay ? (
          <RoundReplay
            round={replay}
            standings={standings}
            justEnded={replayIsFresh}
            onExit={() => setReplay(null)}
          />
        ) : (
          <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
            <div className="flex min-w-0 flex-col gap-5">
              <RoundBar round={round} credits={credits} />
              <VolumeChart
                history={data?.cryptoRankHistory ?? []}
                standings={field}
                window={status?.window ?? "1h"}
              />
              {loading && !field.length ? (
                <div className="rounded-lg border border-hairline bg-surface p-8 text-center text-sm text-muted">
                  seeding the trailing-volume window…
                </div>
              ) : (
                <RankBoard
                  standings={field}
                  entries={entries}
                  selected={activeSymbol}
                  onSelect={onSelect}
                  window={status?.window ?? "1h"}
                />
              )}
            </div>

            <div className="flex min-w-0 flex-col gap-5">
              {/*
                Hidden until there is something to do with it — see `charged`.

                A buy panel that cannot buy is worse than no buy panel: every
                control in it is live, the stake chips add up, and the only thing
                that says it will not work is a refusal on the button at the end.
                Someone with no balance would compose a whole bet before the app
                told them. Withholding it puts the wallet card directly under the
                board instead, which is what they actually need next.
              */}
              {charged && (
                <BetPanel
                  standing={activeStanding}
                  entry={activeEntry}
                  bets={activeBets}
                  bettable={bettable}
                  disabledReason={disabledReason}
                  direction={direction}
                  onDirection={setDirection}
                  busy={busy}
                  credits={credits}
                  onPlace={onPlace}
                  onClose={onClosePosition}
                  closing={closing}
                />
              )}
              <BetFlow standing={activeStanding} entry={activeEntry} />
              <FlowFeed
                events={roundFlow}
                status={error ? "error" : status?.status}
                updatedAt={status?.updatedAt}
              />
              <BotTape onSelect={onSelect} />
            </div>
          </div>
        )}
      </main>

      <footer className="border-t border-hairline">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-4 text-xs text-muted">
          <span>
            Play money. Ranked by traded volume from tokens.xyz, refreshed about once
            a minute. Not financial advice.
          </span>
          <a href="/" className="hover:text-foreground">← Utopian Contributors</a>
        </div>
      </footer>

      <PreviousRounds
        open={pastOpen}
        onClose={() => setPastOpen(false)}
        onReplay={(picked) => {
          setReplay(picked);
          setReplayIsFresh(false);
          setPastOpen(false);
          setTab("board");
        }}
        bets={allBets}
      />
      <BetResult
        bet={result}
        imageUrl={
          standings.find((s) => s.symbol === result?.symbol)?.imageUrl ??
          // A position can resolve on a coin that has since fallen off the
          // board, and the round it was taken on still knows its mark.
          (result ? entries.get(result.symbol)?.imageUrl : null) ??
          null
        }
        onDismiss={() => setResult(null)}
      />
      <HowItWorks open={howOpen} onClose={() => setHowOpen(false)} />
      <InviteDialog
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        onSubmit={login}
      />

      {toast && (
        <div
          role="status"
          className="fixed bottom-6 left-1/2 -translate-x-1/2 rounded-md border border-hairline bg-surface px-4 py-2 text-sm text-foreground shadow-lg"
        >
          {toast}
        </div>
      )}
    </div>
  );
}

