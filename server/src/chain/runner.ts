import type { Keypair } from "@solana/web3.js";

import { CHAIN_MODE } from "../env";
import { BOARD_SIZE, oracle } from "../oracle/index";
import { prisma } from "../prisma";
import { currentRound } from "../rounds";
import { deskArrival, makeDesks, tickFor, type Desk } from "./desks";
import { cutAndReveal, latestRound, openChainRound, recentRounds, rememberSeed, type ChainRound } from "./rounds";
import { readBoard } from "./book";
import { openPositions, sweepSettlements } from "./settle";
import { reclaimRound } from "./reclaim";
import { reportPreflight } from "./preflight";
import { recordChainTrade } from "./tape";
import { DESK_NAMES } from "../bots";
import { keypairFrom, connection, configPda } from "./program";
import { PublicKey } from "@solana/web3.js";

/**
 * The chain, driven.
 *
 * Everything under `chain/` up to now has been callable and nothing has called
 * it. This is what runs: it keeps a chain round in step with the database round
 * that already owns the clock, and it lets the desks arrive.
 *
 * ## Off by default
 *
 * `CHAIN_MODE=off` is the shipping default and the whole reason this is a
 * separate loop rather than an edit to `rounds.ts`. The database game works; the
 * chain game is newer than the database game by a day. A flag means the two can
 * be switched between on a deploy rather than a revert, and it means the thing
 * that breaks at 3am can be turned off by somebody who did not write it.
 *
 * ## Failures are logged, never thrown
 *
 * Every call here is a network call to an RPC that rate-limits, and the honest
 * response to a refused transaction is to try again next tick. A throw inside a
 * timer takes the process down and the database game with it — which would make
 * switching this on strictly more dangerous than leaving it off, and nobody
 * would switch it on.
 */

/**
 * Whether a sync is already in flight.
 *
 * `syncRound` opens a round and then posts its board one transaction at a time,
 * which on a rate-limited RPC takes far longer than the interval that calls it.
 * Without this guard the next tick started a *second* round for the same
 * database round, and the one after that a third: seven chain rounds for one
 * real one, each holding a partial board, each having paid for its own accounts.
 * Every one of them was a correct round in isolation, which is why nothing
 * failed and the duplicates were only visible by counting.
 */
let syncing = false;

/**
 * How many recent rounds to keep working on each tick.
 *
 * Wide enough to cover a backlog rather than just the handover: a round that
 * fails to reveal stays unfinished until something revisits it, and a narrow
 * window means "something" never does. The cost is one batched account read per
 * tick regardless of the number, so the only reason not to widen it further is
 * that rounds older than this are a problem to fix rather than to poll.
 */
const SETTLEMENT_WINDOW = Number(process.env.CHAIN_SETTLEMENT_WINDOW ?? 10);

/**
 * Rounds known to owe nothing, so they are never scanned again.
 *
 * Finding a round's open positions costs a `getProgramAccounts`, which is the
 * most expensive call in the whole system — providers bill it at a large
 * multiple of an ordinary read because it walks the program's accounts. Sweeping
 * the window meant up to ten of them every five seconds, which is what actually
 * exhausted the quota: the 429s were not the desks trading, they were us asking
 * the same settled rounds whether they still owed anything, forever, long after
 * the answer stopped changing.
 *
 * A round that has paid out cannot acquire new positions — it is settled, and
 * `place_bet` refuses a round that is not open — so "drained" is permanent and
 * this set never needs invalidating.
 */
const drained = new Set<string>();

/** Rotates which unfinished round gets the one scan a tick can afford. */
let sweepCursor = 0;

/**
 * How many positions to settle per tick while a round is being traded, and how
 * many once nothing is live.
 *
 * These are two numbers because settlement and the tape want the same scarce
 * thing — requests per second — and only one of them is being watched. A fill is
 * visible within the second; a payout is invisible and has until the player next
 * looks. Measured, settlement at the old flat rate wanted 12 req/s of an 8 req/s
 * budget by itself, which is why the desks were managing a quarter of their
 * intended pace: the invisible work was starving the visible work.
 *
 * So it yields while a round is open and catches up once the round locks, when
 * the desks have stopped and the whole budget is idle anyway.
 */
const SETTLE_WHILE_LIVE = Number(process.env.CHAIN_SETTLE_LIVE ?? 2);
const SETTLE_WHILE_IDLE = Number(process.env.CHAIN_SETTLE_IDLE ?? 5);

let timer: ReturnType<typeof setInterval> | null = null;
/**
 * Each desk's *pending* next turn, keyed by desk.
 *
 * A map rather than the array this used to be: every turn appended to that array
 * and nothing ever emptied it, so a day of running left tens of thousands of
 * dead handles behind it. There is only ever one timer per desk outstanding.
 */
const deskTimers = new Map<number, ReturnType<typeof setTimeout>>();
let running = false;

/**
 * How long to wait for a desk's turn before giving up on it and moving on.
 *
 * A backstop for the transport's own deadline rather than a second copy of it —
 * a turn is several requests, and a fill waits out `sendChainTx`'s confirmation
 * poll on top of them, so this has to be generous. What it catches is a turn
 * that has stopped making progress for a reason nothing underneath it noticed.
 */
const DESK_TURN_TIMEOUT_MS = Number(process.env.CHAIN_DESK_TURN_TIMEOUT_MS ?? 90_000);

/** What the runner needs, resolved once at start. */
interface Wiring {
  authority: Keypair;
  relayer: Keypair;
  desks: Desk[];
  /** The mint credits are denominated in — needed to address a payout. */
  mint: PublicKey;
}
let wiring: Wiring | null = null;

const complain = (what: string, err: unknown) =>
  console.warn(`⚠  chain/${what}:`, err instanceof Error ? err.message : err);

/**
 * Bring the rows indexing settled positions in line with what the chain paid.
 *
 * The row is an index, not the truth — the money moved when `settle_bet` landed,
 * and this only stops the history panel claiming a position is still open after
 * it has been paid. Reading the outcome back from the account rather than
 * recomputing it means the row cannot disagree with the payout even in
 * principle.
 *
 * The accounts are gone by now: `settle_bet` closes each one to refund its rent.
 * So the outcome comes from the entry's cut rank against the position's start
 * rank — the same comparison the program made, on data that outlives the
 * position.
 */
async function syncSettledRows(addresses: string[], round: ChainRound): Promise<void> {
  const rows = await prisma.cryptoBet.findMany({
    where: { chainAddress: { in: addresses }, status: "OPEN" },
    select: { id: true, symbol: true, direction: true, startRank: true, stake: true, odds: true },
  });
  if (!rows.length) return;

  const entries = await readBoard(round.index, round.entryCount);
  const cutOf = new Map(entries.map((e) => [e.symbol, e.cutRank]));

  for (const row of rows) {
    const cut = cutOf.get(row.symbol) ?? null;

    // Mirrors `outcome_of` in `settle_bet.rs` exactly, including that a smaller
    // rank is a better finish. Recomputed rather than read because the position
    // account is already gone — `settle_bet` closes it to refund the rent — and
    // the entry's cut rank, which outlives it, is the same input the program used.
    //
    // A cut of zero is how "never recorded" is spelled, and the program treats it
    // as a void that refunds the stake rather than as a loss.
    const status =
      cut == null
        ? "VOID"
        : cut < row.startRank
          ? row.direction === "HIGHER" ? "WON" : "LOST"
          : cut > row.startRank
            ? row.direction === "LOWER" ? "WON" : "LOST"
            : row.direction === "DRAW" ? "WON" : "LOST";

    await prisma.cryptoBet.update({
      where: { id: row.id },
      data: {
        status,
        cutRank: cut,
        // Shares when it lands, stake back when it voids — the same two cases
        // the program pays, so the row and the transfer agree.
        payout: status === "WON" ? Math.round(row.stake * row.odds) : status === "VOID" ? row.stake : 0,
        resolvedAt: new Date(),
      },
    });
  }
}

/**
 * Keep a chain round open for the round the database is on.
 *
 * The database round is authoritative about *when*: it is wall-clock aligned,
 * it already holds the seed, and the UI reads it. This only ever mirrors that
 * decision onto the chain, so the two cannot drift about which round is live.
 */
async function syncRound(w: Wiring): Promise<void> {
  if (syncing) return;
  syncing = true;
  try {
    await syncRoundInner(w);
  } finally {
    syncing = false;
  }
}

async function syncRoundInner(w: Wiring): Promise<void> {
  // `currentRound()` rather than a query of our own, even though the query was
  // the same one. "Which round is live" is a question the game already answers,
  // and it answers it with more than a `where` clause — there is recovery logic
  // behind it for a round that does not sit on a slot boundary. A second copy
  // here would agree until the day it did not, and the disagreement would be a
  // chain round mirroring a round the rest of the app had stopped serving.
  const dbRound = await currentRound();

  const onChain = await latestRound();

  // **Every unfinished round in the window, not merely the newest.**
  //
  // Both halves of this used to look at `latestRound()` alone, and both were
  // wrong the same way: a round is revealed and *then* paid, and each takes more
  // than one tick, so the moment a new round opened, whatever the previous one
  // still needed became nobody's job. Two rounds sat at `Cut` with two hundred
  // positions between them, unrevealed and therefore unpayable, while the loop
  // reported no errors — it was busily doing nothing to the only round it could
  // see.
  const window = await recentRounds(SETTLEMENT_WINDOW);

  // **One settlement scan per tick, rotating.**
  //
  // Sweeping every settled round each tick was the quota problem: the scan is
  // the expensive call, and running it ten times over rounds that had already
  // paid out bought nothing. Rotating means a backlog of N rounds takes N ticks
  // to revisit instead of N scans every tick, which is the same work spread out
  // rather than the same work repeated.
  const owing = window.filter((r) => r.status === "Settled" && !drained.has(r.index.toString()));
  if (owing.length) {
    const round = owing[sweepCursor++ % owing.length];
    // Yield to the desks while anything is actually being traded.
    const live = window.some((r) => r.status === "Open" && Date.now() < r.lockAt.getTime());
    const swept = await sweepSettlements({
      round,
      payer: w.relayer,
      mint: w.mint,
      limit: live ? SETTLE_WHILE_LIVE : SETTLE_WHILE_IDLE,
      // Bring the rows indexing these positions in line with what was paid.
      onSettled: (addresses) => syncSettledRows(addresses, round),
    });
    // Reported before the completion check, not instead of it. These used to be
    // the two halves of an if/else, so the sweep that settled the *last* batch
    // printed only "paid out in full" — and the log jumped from "16 still owed"
    // to "paid out in full" with nothing in between, which reads exactly like
    // sixteen payouts going missing. They were paid; the line saying so was the
    // one branch that could not print it.
    if (swept.settled || swept.failed) {
      console.log(
        `⛓  settled ${swept.settled}/${swept.attempted} on round ${round.index}` +
          (swept.remaining ? `, ${swept.remaining} still owed` : "")
      );
    }

    if (swept.remaining === 0) {
      // **Confirmed by a second, independent scan before it becomes permanent.**
      //
      // `remaining` comes from one `getProgramAccounts`, and a scan that returns
      // a short list — a slow node, a partial response, positions newer than the
      // commitment it read at — produces `remaining === 0` for a round that
      // still owes real payouts. Written into a permanent set on that evidence,
      // the round stops being swept forever while the log says it paid out in
      // full: the money is owed, nothing is trying to pay it, and the one line
      // anybody would grep for says the opposite.
      //
      // One extra scan per round, once, is a cheap price for not making a
      // permanent decision from a single read.
      const confirm = await openPositions(round, w.relayer);
      if (confirm.length === 0) {
        drained.add(round.index.toString());
        console.log(`⛓  round ${round.index} paid out in full`);
      } else {
        console.log(
          `⛓  round ${round.index} looked settled but a second look found ${confirm.length} still owed`
        );
      }
    }
  }

  // Give back the storage of a round that is completely finished with. One per
  // tick and only after everything above has had its turn: reclaiming is the
  // least urgent thing here — the rent is already spent and waiting another five
  // seconds costs nothing, where a payout delayed is a player unpaid.
  const finished = window.find(
    (r) => r.status === "Settled" && drained.has(r.index.toString())
  );
  if (finished) {
    const back = await reclaimRound({ round: finished, authority: w.authority });
    if (back?.roundClosed) {
      console.log(
        `⛓  reclaimed round ${back.round}: ${back.entriesClosed} entries, ` +
          `${(back.lamports / 1e9).toFixed(4)} SOL back`
      );
      // It no longer exists, so stop counting it as a round that owes nothing.
      drained.delete(finished.index.toString());
    }
  }

  for (const round of window) {
    if (round.status === "Settled") continue;

    // Not settled: it needs cutting, revealing, or is simply still running.
    const outcome = await cutAndReveal({ authority: w.authority, round });
    if (outcome === "settled") console.log(`⛓  revealed round ${round.index}`);
    if (outcome === "no-seed") {
      // Matched on `startsAt`, which is what ties a chain round to the database
      // round it mirrors. Taking "the most recent round that has a seed" instead
      // looks like recovery and is not: the seed would belong to a different
      // round, its hash would not match this round's commitment, and the reveal
      // would be refused — correctly — on every attempt, forever.
      const stored = await prisma.round.findFirst({
        where: { startsAt: round.startsAt, seed: { not: null } },
      });
      if (stored?.seed) rememberSeed(round.index, stored.seed);
      else console.warn(`⚠  chain: round ${round.index} has no recoverable seed and cannot be revealed`);
    }
  }

  if (!dbRound?.seed) return;

  // Already mirrored — matched on `startsAt`, which is the only thing that
  // actually identifies *which* database round a chain round stands for.
  //
  // The previous test was "is there an open chain round", and that is a
  // different question with the same answer most of the time. It said no while a
  // round was mid-cut, so a new one was opened for a database round that already
  // had one; and it said no again on the next tick, and the next. Comparing the
  // instants makes a duplicate impossible rather than unlikely.
  if (onChain && onChain.startsAt.getTime() === dbRound.startsAt.getTime()) return;

  // **The board comes from the database round, not from a fresh oracle read.**
  //
  // This used to call `oracle.standings()` again here. The two are usually the
  // same and are not the same thing: the database round was opened from a
  // snapshot taken some seconds earlier, and the oracle moves. A coin that
  // entered or left the top ten in between, or simply swapped rank with its
  // neighbour, gave the chain round a different field from the round it is
  // supposed to be mirroring.
  //
  // Everything downstream joins the two by `symbol` — the board view, the
  // position list, the cut. A symbol on one side and not the other is a coin
  // with no book, or a position on a coin the round has never heard of. Building
  // from `dbRound.entries` makes the two identical by construction rather than
  // by luck.
  const standings = dbRound.entries
    .slice()
    .sort((a, b) => a.startRank - b.startRank)
    .map((e) => ({
      symbol: e.symbol,
      ticker: e.ticker,
      name: oracle.metaFor(e.symbol)?.name ?? e.ticker,
      imageUrl: oracle.metaFor(e.symbol)?.imageUrl ?? null,
      rank: e.startRank,
      previousRank: e.startRank,
      quoteVolume: e.startVolume,
      price: oracle.tokenFor(e.symbol)?.price ?? 0,
      trades1h: 0,
      wallets1h: 0,
      priceChange1hPercent: 0,
    }));
  if (!standings.length) return;

  await openChainRound({
    authority: w.authority,
    startsAt: dbRound.startsAt,
    seedHex: dbRound.seed,
    crownSymbol: dbRound.crownSymbol,
    standings,
  });
  console.log(`⛓  opened chain round for ${dbRound.startsAt.toISOString()}`);
}

/**
 * One desk's turn.
 *
 * Balance is re-read per arrival rather than cached. The cached version in
 * `bots.ts` existed because a balance read was a Postgres round trip on a path
 * that ran eight times a second; here the desks arrive once a second between
 * them and the read is one `getTokenAccountBalance`, so the staleness is not
 * worth the arithmetic it would put behind every clip.
 */
/**
 * Every desk's credit balance, read in one request for all of them.
 *
 * This was a `getTokenAccountBalance` per desk turn — eight separate reads of
 * eight accounts, once a second between them, and never cached. On a budget of
 * eight requests a second that is an eighth of everything, spent asking the same
 * question eight ways.
 *
 * One `getMultipleAccountsInfo` answers it for all of them, and the answer keeps
 * for a couple of seconds: a desk's balance moves when that desk trades, which
 * is at most once per tick, and the amount it moves by is known locally. Being
 * a little behind costs a desk a slightly stale idea of its own bankroll; the
 * program is what actually refuses an overspend, and it reads the account
 * itself inside the transaction.
 */
const DESK_BALANCE_TTL_MS = Number(process.env.CHAIN_DESK_BALANCE_TTL_MS ?? 2_500);
let deskBalances: { until: number; byDesk: Map<number, number> } | null = null;

async function balancesFor(desks: Desk[]): Promise<Map<number, number>> {
  if (deskBalances && Date.now() < deskBalances.until) return deskBalances.byDesk;

  const infos = await connection().getMultipleAccountsInfo(desks.map((d) => d.tokens));
  const byDesk = new Map<number, number>();
  infos.forEach((info, i) => {
    // The SPL token amount is a u64 at offset 64 of a token account.
    if (info?.data?.length && info.data.length >= 72) {
      byDesk.set(desks[i].id, Number((info.data as Buffer).readBigUInt64LE(64)));
    }
  });
  deskBalances = { until: Date.now() + DESK_BALANCE_TTL_MS, byDesk };
  return byDesk;
}

/** Spend against the cached figure, so a desk's next turn sees its own fill. */
function debitCached(deskId: number, stake: number): void {
  if (!deskBalances) return;
  const held = deskBalances.byDesk.get(deskId);
  if (held != null) deskBalances.byDesk.set(deskId, Math.max(0, held - stake));
}

async function deskTurn(w: Wiring, desk: Desk): Promise<void> {
  const round = await latestRound();
  if (!round || round.status !== "Open" || Date.now() >= round.lockAt.getTime()) return;

  const credits = (await balancesFor(w.desks)).get(desk.id) ?? 0;
  if (credits < 1) return; // no account yet, or traded flat

  const fill = await deskArrival({
    desk,
    relayer: w.relayer,
    round: {
      id: round.address.toBase58(),
      index: round.index,
      entryCount: round.entryCount,
      startsAt: round.startsAt,
      endsAt: round.endsAt,
      lockAt: round.lockAt,
      crownSymbol: round.crownSymbol,
      entries: [],
    },
    standings: oracle.standings(BOARD_SIZE),
    credits,
  });

  if (fill) {
    debitCached(desk.id, fill.stake);
    // The tape is a view of this, and it has no other source while the desks
    // bet through the program — `botTape` groups Postgres rows that no longer
    // exist, so the panel goes blank while the market is demonstrably running.
    recordChainTrade({
      bot: desk.name,
      symbol: fill.symbol,
      ticker: fill.ticker,
      direction: fill.direction,
      size: fill.stake,
      cents: fill.cents,
    });
    console.log(
      `⛓  ${desk.name} ${fill.direction} ${fill.symbol} ${fill.stake} @ ${fill.cents}c`
    );
  }
}

/**
 * Put a desk back on the clock a tick after the one it just finished.
 *
 * **A watchdog guarantees the next turn, not the last one finishing.**
 * Rescheduling out of `.finally()` alone made a desk's whole future depend on
 * its current turn settling — and a turn that never settles is not a
 * hypothetical, it is what an RPC call with no deadline *is*. When it happened
 * the desk simply stopped: nothing threw, so nothing logged, and the round loop
 * carried on beside it because an interval does not wait on its own last tick.
 * All eight died inside one cycle, the market ran empty for four days, and the
 * only line anybody would have grepped for said every round had paid out in
 * full — which was true, and only because nothing had bet on them.
 *
 * So the timer owns the schedule and the promise does not. A turn that outstays
 * `DESK_TURN_TIMEOUT_MS` is abandoned — it may still be in flight and there is
 * no way to cancel it, but the desk stops waiting on it — and it says so on the
 * way past, because a desk that has quietly stopped trading is precisely the
 * thing this system had no way of telling anyone.
 */
function scheduleDesk(w: Wiring, desk: Desk, delayMs: number): void {
  const t = setTimeout(() => {
    // Whichever of the two gets here first wins; the other becomes a no-op, so
    // an abandoned turn that later completes cannot double up the schedule.
    let handled = false;
    const next = () => {
      if (handled) return;
      handled = true;
      if (running) scheduleDesk(w, desk, tickFor(w.desks.length));
    };

    const watchdog = setTimeout(() => {
      if (handled) return;
      complain(
        `desk ${desk.name}`,
        `a turn has run ${Math.round(DESK_TURN_TIMEOUT_MS / 1000)}s without finishing — abandoning it`
      );
      next();
    }, DESK_TURN_TIMEOUT_MS);
    watchdog.unref?.();

    void deskTurn(w, desk)
      .catch((err) => complain(`desk ${desk.name}`, err))
      .finally(() => {
        clearTimeout(watchdog);
        next();
      });
  }, delayMs);
  // Chained rather than an interval: a tick does several network round trips and
  // an interval would stack the next one on top of a slow RPC.
  t.unref?.();
  deskTimers.set(desk.id, t);
}

/**
 * Start mirroring rounds and running the desks.
 *
 * Idempotent, and it refuses rather than half-starts: a missing key or an
 * unseeded program is a configuration problem, and a runner that limped along
 * logging one failure a second would bury it.
 */
export async function startChain(): Promise<void> {
  if (CHAIN_MODE === "off" || running) return;

  // **Preflight first, before anything that can throw.**
  //
  // Loading the keys here would fail on the first bad one and report only that,
  // which is how a deploy gets fixed one restart at a time. The preflight
  // catches its own failures and reports every one of them together, so the
  // person reading the log sees the whole list.
  //
  // It warns and stays off rather than exiting: a chain that cannot start is a
  // reason to serve the database game, not a reason to serve nothing.
  console.log("⛓  chain preflight:");
  if (!(await reportPreflight())) {
    console.warn("⚠  on-chain play is not runnable here — staying off. Fix the ✗ lines above.");
    return;
  }

  const home = process.env.HOME ?? "~";
  const authority = keypairFrom("CROWN_AUTHORITY_KEY", `${home}/.config/solana/crown-devnet/treasury.json`);
  const relayer = keypairFrom("CROWN_RELAYER_KEY", `${home}/.config/solana/crown-devnet/relayer.json`);

  const cfgInfo = await connection().getAccountInfo(configPda());
  if (!cfgInfo) {
    console.warn("⚠  CHAIN_MODE is on but the program has no config — run `bun run chain:seed`. Staying off.");
    return;
  }
  const mint = new PublicKey(cfgInfo.data.subarray(8 + 32, 8 + 64));

  wiring = { authority, relayer, desks: makeDesks(DESK_NAMES, mint), mint };
  running = true;

  console.log(
    `⛓  chain mode on — authority ${authority.publicKey.toBase58().slice(0, 8)}…, ` +
      `relayer ${relayer.publicKey.toBase58().slice(0, 8)}…, ${wiring.desks.length} desks`
  );

  const tick = () => {
    if (!wiring) return;
    void syncRound(wiring).catch((err) => complain("round", err));
  };
  timer = setInterval(tick, 5_000);
  tick();

  // Staggered, so the desks interleave rather than eight of them waking on the
  // same millisecond — a load spike with no purpose, since what a desk pays is
  // set by what it buys and not by the order it arrives in.
  const spacing = tickFor(wiring.desks.length) / wiring.desks.length;
  wiring.desks.forEach((desk, i) => scheduleDesk(wiring!, desk, spacing * i));
}

/** Stop. Safe to call twice, and safe to call before `startChain`. */
export function stopChain(): void {
  running = false;
  if (timer) clearInterval(timer);
  timer = null;
  for (const t of deskTimers.values()) clearTimeout(t);
  deskTimers.clear();
  wiring = null;
}

/** Test seam — whether the chain loop is live. */
export const chainRunning = (): boolean => running;
