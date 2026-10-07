import { useMutation, useQuery } from "@apollo/client/react";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { SessionProvider, useSession } from "../session/SessionProvider";
import {
  Button,
  IconButton,
  Panel,
  Rail,
  Segmented,
  ThemeToggle,
} from "../ui";
import { BetPanel } from "./BetPanel";
import { BetResult } from "./BetResult";
import { FlowFeed } from "./FlowFeed";
import { GameStats, type Mover } from "./GameStats";
import {
  BOARD,
  PLACE_BET,
  ROUNDS,
  SELL_POSITION,
  type Direction,
  type RoundResult,
  type Standing,
} from "./graphql";
import { HowItWorks } from "./HowItWorks";
import { Orders } from "./Orders";
import { Portfolio } from "./Portfolio";
import { PreviousRounds } from "./PreviousRounds";
import { RankBoard } from "./RankBoard";
import { RoundClock } from "./RoundClock";
import { RoundOverBar, RoundReplay } from "./RoundReplay";
import { useSignInPrompt } from "./useSignIn";
import { VolumeChart } from "./VolumeChart";
import { SignInButton, WalletButton } from "./WalletButton";

/** Matches the oracle's own re-rank cadence — no point polling faster. */
const POLL_MS = 2_000;

type Tab = "board" | "portfolio";

const TABS = [
  { value: "board", label: "Board" },
  { value: "portfolio", label: "Portfolio" },
] as const satisfies readonly { value: Tab; label: string }[];

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
 * Publish the sticky header's height as `--header-h` on the page, so the ticket
 * column can stick flush under it. Measured rather than assumed: the header
 * wraps on a narrow screen and changes with what the account side shows.
 */
function useHeaderHeight(header: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = header.current;
    const page = el?.parentElement;
    if (!el || !page) return;
    const observer = new ResizeObserver(() =>
      page.style.setProperty("--header-h", `${el.offsetHeight}px`)
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [header]);
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
  const headerRef = useRef<HTMLElement>(null);
  useHeaderHeight(headerRef);
  const { user } = useSession();
  // The same door the header opens, reachable from the ticket — see `onPlace`.
  const { promptSignIn, picker } = useSignInPrompt();
  const [tab, setTab] = useState<Tab>("board");
  const [howOpen, setHowOpen] = useState(false);
  const [pastOpen, setPastOpen] = useState(false);
  // A settled round — picked out of the list, or the one they were just
  // watching. Either way the board tab replays it until they come back.
  // `RoundResult`, not `Round`: a replay is drawn from a finished round's
  // results, and the history panel hands over exactly those.
  const [replay, setReplay] = useState<RoundResult | null>(null);
  const [replayIsFresh, setReplayIsFresh] = useState(false);
  /** The round that ended under the player, waiting on its settlement. */
  const [ended, setEnded] = useState<string | null>(null);
  /** That round once settled, offered from the live board rather than replacing it. */
  const [justSettled, setJustSettled] = useState<RoundResult | null>(null);
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
  const [sellPosition] = useMutation(SELL_POSITION);
  const [selling, setSelling] = useState(false);

  const standings = useMemo(() => data?.cryptoStandings ?? [], [data?.cryptoStandings]);
  const round = data?.cryptoRound ?? null;
  const status = data?.oracleStatus;

  // Tell the player the round they were just watching has settled, rather than
  // rolling them silently into the next one — but over the live board, not in
  // place of it. It used to switch straight into the replay, which froze the
  // page on the old round's numbers while the next one was already trading.
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
    const settled = (recent?.cryptoRounds ?? []).find(
      (r) => r.id === ended && r.status === "SETTLED"
    );
    if (!settled) return;
    setJustSettled(settled);
    setEnded(null);
  }, [ended, recent]);
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
   * and carries no book. The chart draws its line from the poll it arrives on,
   * so the picture over the board never leaves out a row the board is showing.
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

  // The game, for the stats over the chart: the round's own coins, measured
  // from where each opened. A coin that trended in since is not in this race,
  // so its volume is not in the race's total. Between rounds the board is all
  // there is, and nothing has moved yet.
  const movers = useMemo<Mover[]>(
    () =>
      (entries.size ? field.filter((s) => entries.has(s.symbol)) : field).map((s) => ({
        symbol: s.symbol,
        ticker: s.ticker,
        imageUrl: s.imageUrl,
        from: entries.get(s.symbol)?.startRank ?? s.rank,
        to: s.rank,
        volume: s.quoteVolume,
      })),
    [field, entries]
  );

  // Credits come from the polled query, not the session's one-shot ME — the
  // balance changes server-side the moment a round settles, and reading it from
  // a query fetched once at login meant the header never moved.
  const credits = data?.me?.credits ?? user?.credits ?? null;

  // Surface each settlement exactly once, as its bets flip out of OPEN — all of
  // them in one receipt, not the first and silence for the rest. Only a win or
  // a loss: a sale already has its own receipt on the ticket, and showing one
  // here as well called a profitable exit a lost bet.
  const [result, setResult] = useState<typeof allBets | null>(null);
  const seen = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    const queue: typeof allBets = [];
    for (const b of allBets) {
      const was = seen.current.get(b.id);
      if (was === "OPEN" && (b.status === "WON" || b.status === "LOST")) queue.push(b);
      seen.current.set(b.id, b.status);
    }
    if (queue.length) setResult((cur) => cur ?? queue);
  }, [allBets]);
  // A position can resolve on a coin that has since fallen off the board, and
  // the round it was taken on still knows its mark.
  const imageUrl = useCallback(
    (symbol: string) =>
      standings.find((s) => s.symbol === symbol)?.imageUrl ??
      entries.get(symbol)?.imageUrl ??
      null,
    [standings, entries]
  );
  const roundBets = useMemo(
    () => allBets.filter((b) => b.roundId === round?.id),
    [allBets, round?.id]
  );

  const open = round?.status === "OPEN" && new Date(round.lockAt).getTime() > Date.now();
  /**
   * Being signed out is no longer a refusal.
   *
   * It used to be the first thing the ticket said, which made "sign in" read as
   * the reason a bet had failed rather than as the next step in placing one.
   * The panel now takes the composition either way and the Buy key opens the
   * wallet dialog, so the only thing left to refuse a *whole panel* over is the
   * round itself.
   */
  const disabledReason = open ? null : "Betting is closed for this round.";

  /**
   * Whether a coin can be backed this round — and so whether it can be picked.
   *
   * Two rows on the board can't: the coin wearing the crown, which has no book,
   * and a coin that trended in after the open, which is only in from the next
   * round. Both used to take a click and fill the ticket with a coin it could do
   * nothing with, and the crown, standing first, was what the ticket opened on.
   */
  const bettable = useCallback(
    (symbol: string) => {
      const entry = entries.get(symbol);
      return Boolean(entry && !entry.isCrown);
    },
    [entries]
  );

  // Open the ticket on the first coin that can be backed, then keep it there:
  // following the board instead swapped the coin out from under a stake being
  // typed whenever two rows traded places. A pick the round stops offering —
  // the coin took the crown, or is not in the next round — falls back the same
  // way. Set during render, not in an effect, so the ticket never draws the old
  // coin first.
  const activeSymbol =
    selected && bettable(selected)
      ? selected
      : (field.find((s) => bettable(s.symbol))?.symbol ?? null);
  if (activeSymbol && activeSymbol !== selected) setSelected(activeSymbol);
  const activeStanding = field.find((s) => s.symbol === activeSymbol) ?? null;
  const activeEntry = activeSymbol ? (entries.get(activeSymbol) ?? null) : null;
  const activeBets = roundBets.filter((b) => b.symbol === activeSymbol);

  /**
   * Is there anything for the buy panel to do?
   *
   * A balance is the usual answer, but not the only one: the panel's Sell tab
   * is the exit from an open position, so a player who has spent their last
   * dollar into one still needs it. Keying purely on the balance would take the
   * exit away from the one person guaranteed to be looking for it — and keying
   * on *any* position would keep the panel up for someone whose lots have all
   * been sold, which is the portfolio's story now, not the ticket's.
   */
  const charged = (credits ?? 0) > 0 || roundBets.some((b) => b.status === "OPEN");

  const onSelect = useCallback(
    (symbol: string, dir?: Direction) => {
      if (!bettable(symbol)) return;
      setSelected(symbol);
      if (dir) setDirection(dir);
    },
    [bettable]
  );

  const onPlace = useCallback(
    async (stake: number) => {
      // No account yet: the key is a door. `promptSignIn` puts the wallet
      // picker up as well as arming the signature, because `signIn()` alone
      // waits for a key that a visitor with no wallet connected never supplies
      // — so the tap did nothing visible at all.
      if (!user) {
        promptSignIn();
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
    [user, promptSignIn, placeBet, activeSymbol, direction, refetch]
  );

  /**
   * Sell part or all of one line's position.
   *
   * Addressed by line rather than by lot: the panel sells `(coin, direction,
   * amount)` and the server takes it out of the rows it is spread across, oldest
   * first. One call however many bets it reaches into — a client looping a
   * mutation per lot would walk the book down once per call and get a worse
   * price for a position that happened to be assembled in pieces.
   */
  const onSellPosition = useCallback(
    async (dir: Direction, stake: number) => {
      if (!activeSymbol) return;
      setSelling(true);
      try {
        await sellPosition({ variables: { symbol: activeSymbol, direction: dir, stake } });
        await refetch();
      } catch (err) {
        setToast(err instanceof Error ? err.message : "Could not sell that position.");
        setTimeout(() => setToast(null), 4000);
      } finally {
        setSelling(false);
      }
    },
    [sellPosition, activeSymbol, refetch]
  );

  return (
    <div className="casino flex min-h-dvh flex-col">
      {/*
        The case, top to bottom: a walnut rail, the machined header, the work
        surface, and the same rail again to close it off. The wood is the only
        place in the app it appears — it is what separates the instrument from
        the room, and repeating it inside the panels would be trim on trim.
      */}
      <header
        ref={headerRef}
        className="mat-panel-flush mat-grain sticky top-0 z-30 rounded-none border-x-0 border-t-0"
      >
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-6 py-3">
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
              <span className="mat-engrave text-lg font-semibold text-foreground">
                The Crown
              </span>
            </span>
          </a>

          <Segmented
            tabs
            label="Section"
            value={tab}
            onChange={setTab}
            options={TABS}
          />

          {/*
            Always on screen. It used to be a bar at the top of the board, which
            scrolled away — so it was possible to be composing a bet with no
            idea how long was left to place it.
          */}
          <RoundClock round={round} />

          <div className="ml-auto flex items-center gap-3">
            <Button
              variant="ghost"
              onClick={() => setPastOpen(true)}
              className="hidden text-xs sm:block"
            >
              Previous rounds
            </Button>
            <ThemeToggle />
            {/*
              Signed out, exactly one door — and now it is the wallet.

              There used to be two side by side, "Connect wallet" and "Enter
              invite code", and then only the code, because a wallet could not
              make an account. It can: a signature over a nonce the server chose
              is proof of the key, which is all an account here ever was. So the
              header asks for the one thing a visitor already has.
            */}
            {user ? (
              <>
                <WalletButton />
                {/* Just the balance. Leaving is an account action and lives in
                    the account menu beside it — see `WalletButton`. */}
                <span className="mat-inset mat-engrave rounded-md px-2.5 py-1 font-mono text-sm tabular-nums text-foreground">
                  {(credits ?? 0).toLocaleString()}
                  <span className="ml-1 text-muted">cr</span>
                </span>
              </>
            ) : (
              <SignInButton />
            )}
            <IconButton label="How it works" size="sm" onClick={() => setHowOpen(true)}>
              <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" aria-hidden="true" fill="none">
                <circle cx="12" cy="12" r="9.25" stroke="currentColor" strokeWidth="1.5" />
                <path
                  d="M9.6 9.2a2.5 2.5 0 1 1 3.2 2.4c-.6.2-.9.7-.9 1.3v.5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
                <circle cx="11.9" cy="16.4" r="0.95" fill="currentColor" />
              </svg>
            </IconButton>
          </div>
        </div>
        <Rail groove />
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
          <div className="flex flex-col gap-5">
            {justSettled && (
              <RoundOverBar
                round={justSettled}
                onOpen={() => {
                  setReplay(justSettled);
                  setReplayIsFresh(true);
                  setJustSettled(null);
                }}
                onDismiss={() => setJustSettled(null)}
              />
            )}
            <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
              <div className="flex min-w-0 flex-col gap-5">
                <VolumeChart
                  title={<GameStats movers={movers} />}
                  history={data?.cryptoRankHistory ?? []}
                  standings={field}
                  window={status?.window ?? "1h"}
                />
                {loading && !field.length ? (
                  <p className="px-2 py-8 text-center text-sm text-muted">
                    seeding the trailing-volume window…
                  </p>
                ) : (
                  <RankBoard
                    standings={field}
                    entries={entries}
                    selected={activeSymbol}
                    onSelect={onSelect}
                  />
                )}
              </div>

              {/*
                Pinned under the header while the board scrolls past, so the
                ticket is in reach of whichever row is picked. Bounded to the
                viewport: the ticket keeps its height and the feeds under it
                give up theirs, scrolling inside what is left.
              */}
              <div className="flex min-w-0 flex-col gap-5 lg:sticky lg:top-[calc(var(--header-h,0px)+1.25rem)] lg:max-h-[calc(100dvh-var(--header-h,0px)-1.25rem)] lg:self-start">
                {/*
                  Always up for a visitor; withheld from an account with nothing
                  to spend — see `charged`.

                  Those look like the same case and are opposites. A signed-in
                  player with no balance and no position has already been let in
                  and has nothing the panel can do for them: every control is
                  live, the stake chips add up, and the only thing that says it
                  will not work is a refusal on the key at the end. Withholding it
                  puts what they need next — the wallet — directly under the
                  board.

                  A signed-out visitor is the reverse. The prices are the product,
                  composing a bet is how they decide they want one, and the Buy key
                  is the door. Hiding the ticket hid the entire reason to sign in
                  behind having signed in.
                */}
                {(!user || charged) && (
                  <BetPanel
                    standing={activeStanding}
                    entry={activeEntry}
                    bets={activeBets}
                    roundOpen={open}
                    signedIn={Boolean(user)}
                    disabledReason={disabledReason}
                    direction={direction}
                    onDirection={setDirection}
                    busy={busy}
                    credits={credits}
                    onPlace={onPlace}
                    onSell={onSellPosition}
                    selling={selling}
                  />
                )}
                {/*
                  Under the ticket, but only once the player has traded this
                  round. Before that the room's orders are someone else's game,
                  and the empty feed took the spot right under the ticket from
                  panels that had something to say.
                */}
                {roundBets.length > 0 && <Orders onSelect={onSelect} />}
                <FlowFeed events={roundFlow} status={error ? "error" : status?.status} />
              </div>
            </div>
          </div>
        )}
      </main>

      {/* The bottom of the case. The footer that used to sit under it is gone;
          its "play money" note lives in How it works, which is where someone
          asking what the credits are will actually be looking. */}
      <Rail groove className="mt-auto" />

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
      <BetResult bets={result} imageUrl={imageUrl} onDismiss={() => setResult(null)} />
      <HowItWorks open={howOpen} onClose={() => setHowOpen(false)} />
      {picker}

      {toast && (
        <Panel
          role="status"
          className="casino-animate-in fixed bottom-6 left-1/2 z-40 -translate-x-1/2 px-4 py-2 text-sm text-foreground"
        >
          {toast}
        </Panel>
      )}
    </div>
  );
}

