import type { Keypair } from "@solana/web3.js";

import { CHAIN_MODE } from "../env";
import { oracle } from "../oracle/index";
import { prisma } from "../prisma";
import { currentRound } from "../rounds";
import {
  cutAndReveal,
  latestRound,
  openChainRound,
  recentRounds,
  rememberSeed,
  voidRound,
  VOID_AFTER_SECONDS,
  type ChainRound,
} from "./rounds";
import { readBoard } from "./book";
import { openPositions, sweepSettlements } from "./settle";
import { roundsInArrears } from "./arrears";
import { reclaimRound } from "./reclaim";
import { reportPreflight } from "./preflight";
import { keypairFrom, connection, configPda } from "./program";
import { PublicKey } from "@solana/web3.js";

/**
 * The chain, driven.
 *
 * This is what runs: it keeps a chain round in step with the database round that
 * already owns the clock, cuts and reveals it, and settles what it owes.
 *
 * ## Nothing bets on it yet
 *
 * The only thing that ever placed an on-chain bet was the market-making desks,
 * and the desks are gone — the board is priced by players now and by nothing
 * else. What is left here is the half that was always the point: rounds mirrored
 * onto the program, the cut committed and revealed on chain, positions settled
 * and rent reclaimed. It is correct and it is idle, and it stays until a player
 * can place a bet through the program rather than through Postgres.
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
 * exhausted the quota: the 429s were us asking the same settled rounds whether
 * they still owed anything, forever, long after the answer stopped changing.
 *
 * A round that has paid out cannot acquire new positions — it is settled, and
 * `place_bet` refuses a round that is not open — so "drained" is permanent and
 * this set never needs invalidating.
 */
const drained = new Set<string>();

/** Rotates which unfinished round gets the one scan a tick can afford. */
let sweepCursor = 0;

/**
 * How often to ask the cluster what is still owed, anywhere.
 *
 * The window above is a calendar and debts are not on a calendar. A round that
 * fails to reveal, or whose sweep is interrupted, keeps its open positions while
 * the window moves past it — and then nothing looks at it again, ever. Measured
 * on devnet: 173 positions and about 3.4 million credits of stake behind rounds
 * 0, 20 and 198, while the runner swept 401-410. The oldest had been payable for
 * twelve days, and no log line anywhere said so.
 *
 * `roundsInArrears` asks the question the window cannot: which rounds still hold
 * an open position. It costs the expensive scan, so it runs on a slow timer and
 * its answer is folded into the window until the next one.
 */
const ARREARS_EVERY_MS = Number(process.env.CHAIN_ARREARS_EVERY_MS ?? 5 * 60_000);
let arrearsAt = 0;
let arrears: ChainRound[] = [];

/** Rounds whose seed is gone for good — warned about once, not every tick. */
const unrevealable = new Set<string>();

/**
 * The rounds this tick should work on: the recent ones, plus anything that still
 * owes however old it is.
 *
 * Merged into one list rather than handled separately, so every stage below —
 * sweeping, revealing, reclaiming — covers a forgotten round by construction
 * instead of each having to remember to.
 */
async function workList(w: Wiring): Promise<ChainRound[]> {
  const recent = await recentRounds(SETTLEMENT_WINDOW);

  if (Date.now() - arrearsAt >= ARREARS_EVERY_MS) {
    arrearsAt = Date.now();
    try {
      const owed = await roundsInArrears(w.relayer);
      arrears = owed.map((a) => a.round);
      const forgotten = owed.filter((a) => !recent.some((r) => r.index === a.round.index));
      if (forgotten.length) {
        console.log(
          `⛓  arrears: ${forgotten.reduce((n, a) => n + a.positions, 0)} position(s) owed on ` +
            `round(s) ${forgotten.map((a) => a.round.index).join(", ")} — outside the window, picking them up`
        );
      }
    } catch (err) {
      // A failed scan is a stale work list, not a broken tick.
      console.warn("⛓  arrears scan:", err instanceof Error ? err.message : err);
    }
  }

  const seen = new Set(recent.map((r) => r.index.toString()));
  return [...recent, ...arrears.filter((r) => !seen.has(r.index.toString()))];
}

/**
 * How many positions to settle per tick while a round is open, and how many once
 * nothing is live.
 *
 * Two numbers because settlement competes for requests per second with anything
 * the round itself needs, and only one of the two is being watched: a payout is
 * invisible and has until the player next looks. So it yields while a round is
 * open and catches up once the round locks and the whole budget is idle anyway.
 */
const SETTLE_WHILE_LIVE = Number(process.env.CHAIN_SETTLE_LIVE ?? 2);
const SETTLE_WHILE_IDLE = Number(process.env.CHAIN_SETTLE_IDLE ?? 5);

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

/** What the runner needs, resolved once at start. */
interface Wiring {
  authority: Keypair;
  relayer: Keypair;
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

  // A voided round pays nothing but refunds. `settle_bet` says so explicitly —
  // "no rank on it decides anything, including the ranks `record_cut` may have
  // written before the seed went missing" — so scoring these rows off the cut
  // would book winners and losers against a chain that had paid everybody back.
  const voided = round.status === "Voided";

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
      voided || cut == null
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
  const window = await workList(w);

  // **One settlement scan per tick, rotating.**
  //
  // Sweeping every settled round each tick was the quota problem: the scan is
  // the expensive call, and running it ten times over rounds that had already
  // paid out bought nothing. Rotating means a backlog of N rounds takes N ticks
  // to revisit instead of N scans every tick, which is the same work spread out
  // rather than the same work repeated.
  // **Voided rounds owe money too.**
  //
  // `settle_bet` takes `Settled || Voided`, and on a voided round it refunds
  // every stake — that is the whole point of `void_round`, which exists so a
  // round whose seed was lost does not strand its positions forever. Filtering
  // to `Settled` alone left the one kind of round that was voided *for* being
  // stuck permanently stuck, with nothing sweeping the refunds it had just been
  // made eligible for.
  const payable = (r: ChainRound) => r.status === "Settled" || r.status === "Voided";
  const owing = window.filter((r) => payable(r) && !drained.has(r.index.toString()));
  if (owing.length) {
    const round = owing[sweepCursor++ % owing.length];
    // Yield while a round is open; catch up once nothing is live.
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
  //
  // `Settled` and not `payable` here, deliberately: `close_round` requires
  // `Settled`, so a voided round's rent stays locked up on chain however drained
  // it is. That is the program's rule, not an oversight in this list — asking to
  // close one would just spend a transaction on a `WrongStatus`.
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
    // Voided as well as Settled: a voided round is finished being decided.
    // Passing it to `cutAndReveal` sent a `record_cut` per entry into a program
    // that refuses one — and then took the `no-seed` branch and asked to void it
    // again — every tick, forever.
    if (payable(round)) continue;

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
      if (stored?.seed) {
        rememberSeed(round.index, stored.seed);
        unrevealable.delete(round.index.toString());
      } else {
        // Nothing anywhere holds this round's seed, so it can never be revealed
        // and its positions can never resolve normally. After a long wait, the
        // program lets it be given up on instead, which refunds every stake —
        // the only outcome available once the result is unverifiable.
        const gave = await voidRound({ authority: w.authority, round }).catch((err) => {
          console.warn(`⚠  chain: voiding round ${round.index}:`, err?.message ?? err);
          return "too-early" as const;
        });
        if (gave === "voided") {
          console.log(
            `⛓  round ${round.index} had no recoverable seed and was voided — its stakes refund on the next sweep`
          );
          unrevealable.delete(round.index.toString());
        } else if (!unrevealable.has(round.index.toString())) {
          // Once per round. This is now reachable for rounds the window had
          // abandoned — including ones whose database row is long gone — and a
          // line per round per tick would bury everything else in the log.
          unrevealable.add(round.index.toString());
          console.warn(
            `⚠  chain: round ${round.index} has no recoverable seed and can never be revealed. ` +
              (gave === "unsupported"
                ? "The deployed program predates `void_round`; deploy it and the stakes refund automatically."
                : `Its stakes refund once it can be voided, ${VOID_AFTER_SECONDS / 3600}h after it ended.`)
          );
        }
      }
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
 * Start mirroring rounds.
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

  wiring = { authority, relayer, mint };
  running = true;

  console.log(
    `⛓  chain mode on — authority ${authority.publicKey.toBase58().slice(0, 8)}…, ` +
      `relayer ${relayer.publicKey.toBase58().slice(0, 8)}…`
  );

  const tick = () => {
    if (!wiring) return;
    void syncRound(wiring).catch((err) => complain("round", err));
  };
  timer = setInterval(tick, 5_000);
  tick();
}

/** Stop. Safe to call twice, and safe to call before `startChain`. */
export function stopChain(): void {
  running = false;
  if (timer) clearInterval(timer);
  timer = null;
  wiring = null;
}
