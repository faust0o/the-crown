import { createHash, randomBytes, createHmac } from "node:crypto";
import { prisma } from "./prisma";
import { closeBook, openRound, type RoundBook } from "./market";
import { oracle, BOARD_SIZE, type Standing } from "./oracle/index";

/**
 * Round length. Rounds are wall-clock aligned, so at 30 minutes they open on
 * the hour and the half hour. Set ROUND_MINUTES low to demo settlement without
 * waiting — but note a change only takes effect once the in-flight round ends.
 */
export const ROUND_MINUTES = Number(process.env.ROUND_MINUTES ?? 30);
/** Betting closes this long before the round ends; the cut lands inside it. */
export const CUT_WINDOW_SECONDS = Number(process.env.CUT_WINDOW_SECONDS ?? 60);

const ROUND_MS = ROUND_MINUTES * 60_000;
const CUT_MS = CUT_WINDOW_SECONDS * 1_000;

/**
 * How long a cut may wait, past its committed instant, for a live reading of
 * the market taken at or after that instant. Past this the round is refunded.
 */
export const CUT_GRACE_MS = Number(process.env.CUT_GRACE_SECONDS ?? 120) * 1_000;

/**
 * What a round whose cut is due should do with the board the oracle holds.
 *
 * **Record** only from a live reading that describes the market at or after the
 * committed instant. The cut used to take whatever `standings()` returned, with
 * no question asked of it: a frozen feed settled the round on numbers from
 * before betting closed — which a player could have read while betting — and an
 * empty board scored every coin as relegated, paying every LOWER bet on the
 * board. Neither is a result.
 *
 * **Wait** while one may still arrive. The upstream publishes every fifteen
 * seconds or so, describing the market as of a few seconds before, so the
 * reading that settles a round is normally the first or second one after its
 * instant.
 *
 * **Void** once it has had `CUT_GRACE_MS` to arrive and has not. The round is
 * cut with no ranks at all, which settlement already refunds: a round decided
 * by nobody is better paid back than decided by a stale guess.
 */
export function cutDecision(
  now: number,
  cutAt: number,
  feed: { live: boolean; describes: number }
): "record" | "wait" | "void" {
  if (now < cutAt) return "wait";
  if (feed.live && feed.describes >= cutAt) return "record";
  return now - cutAt >= CUT_GRACE_MS ? "void" : "wait";
}

/** Rounds start on wall-clock boundaries so the schedule is predictable. */
export function roundStartFor(now: number): Date {
  return new Date(Math.floor(now / ROUND_MS) * ROUND_MS);
}

/**
 * Where inside the cut window this round settles, derived from the seed.
 *
 * Deterministic given (seed, roundId) and therefore verifiable after the reveal:
 * anyone can recompute this and check it against the published commitHash.
 */
export function cutOffsetMs(
  seed: string,
  roundId: string,
  windowMs: number = CUT_MS
): number {
  const mac = createHmac("sha256", seed).update(roundId).digest();
  return mac.readUInt32BE(0) % windowMs;
}

export const commitmentOf = (seed: string) =>
  createHash("sha256").update(seed).digest("hex");

/**
 * Who wears the crown: the coin that finished #1 at the most recent settled cut.
 *
 * Null before any round has been cut, which leaves the whole board bettable for
 * the very first round.
 *
 * Asked of the rounds that crowned somebody, not of the rounds that were cut: a
 * refunded round is cut with no ranks, and taking the latest cut would have
 * handed the crown to nobody — and the whole board back to the bettors — every
 * time the feed failed at a cut.
 */
export async function reigningCrown(): Promise<string | null> {
  const last = await prisma.round.findFirst({
    where: { entries: { some: { cutRank: 1 } } },
    orderBy: { startsAt: "desc" },
    include: { entries: { where: { cutRank: 1 }, take: 1 } },
  });
  return last?.entries[0]?.symbol ?? null;
}

/**
 * Whether the crown a new round would wear is known yet.
 *
 * The crown is the previous round's result, and that result can land after the
 * slot it hands over to has already begun: the cut waits for a reading of the
 * market taken at or after its instant, the upstream publishes one every
 * fifteen seconds or so, and the instant can fall in the round's last seconds.
 * The next round used to open on its boundary regardless, and took its crown
 * from the round before last — so the coin that had just been beaten wore it
 * for a whole round, and the coin that beat it was on the board with a book.
 *
 * Not decided while the previous round is still waiting on its cut. The wait is
 * bounded: `cutDecision` records or voids a cut within `CUT_GRACE_MS` of an
 * instant no later than the round's end. A round with no seed is the exception —
 * `tickRounds` never cuts one, so waiting on it would wait forever.
 */
export function crownDecided(
  previous: { status: "OPEN" | "LOCKED" | "CUT" | "SETTLED"; seed: string | null } | null
): boolean {
  if (!previous?.seed) return true;
  return previous.status === "CUT" || previous.status === "SETTLED";
}

/**
 * Open the market's book on a round before handing it out.
 *
 * Every price in the game is quoted off the tape, and the tape only knows a
 * round once its book is open. Doing it here — the one call every price-reading
 * path already makes — is what guarantees no caller ever meets a line that has
 * never traded. Idempotent, so the once-a-second round loop costs a map lookup.
 *
 * The null case matters just as much: no live round means every line has already
 * resolved, and a book left open on a dead round keeps quoting prices for bets
 * nobody can place.
 */
function withBook<T extends RoundBook | null>(round: T): T {
  if (round) openRound(round);
  else closeBook();
  // And tell the oracle which coins it owes a trail to.
  //
  // The oracle measures the top of the market; a round is a promise to follow
  // ten named coins until it ends, and the two stop agreeing the moment one of
  // them is relegated. Everything about that coin — its volume on the board, its
  // line on the chart, its row in the history the replay reads — used to stop
  // there, reported as "$0", which says the market died when what happened is
  // the thing the round is scored on. Asserted here for the same reason the book
  // is: this is the one call every path that cares about the live round already
  // makes, so an API poll, the round loop and the chain runner all keep it true.
  oracle.track(round?.entries.map((e) => e.symbol) ?? []);
  return round;
}

/**
 * Fetch the live round, opening it (and snapshotting the starting board) if the
 * current wall-clock slot doesn't have one yet.
 */
export async function currentRound() {
  const now = Date.now();
  const include = { entries: { orderBy: { startRank: "asc" } } } as const;

  // Any round that hasn't ended is *the* round, whether or not it sits on a slot
  // boundary. Looking this up by end time rather than by slot is what keeps a
  // recovery round (below) findable on the next tick — keying only on startsAt
  // meant an unaligned round was never found again and a new one was opened
  // every second.
  const live = await prisma.round.findFirst({
    where: { endsAt: { gt: new Date(now) } },
    orderBy: { startsAt: "desc" },
    include,
  });
  if (live) return withBook(live);
  // No round is live, so no coin is still being scored — and the field this
  // round is about to snapshot must be chosen on eligibility alone. Left
  // tracked, the round that just ended would carry its coins' exemption from
  // the liquidity floor straight into the next one's field.
  oracle.track([]);

  const startsAt = roundStartFor(now);
  // Rounds always begin on a wall-clock boundary — on the hour at the default
  // length — so the schedule is predictable and every player sees the same
  // round open at the same moment. If this slot already holds a finished round
  // (a length change, since a shorter round's boundaries land on a longer
  // one's), we wait for the next boundary rather than starting an unaligned
  // one. There is briefly no live round, which the UI already handles.
  const taken = await prisma.round.findUnique({ where: { startsAt } });
  if (taken) return withBook(null);

  const standings = oracle.standings(BOARD_SIZE);
  // Not warm yet, or not current. An empty board opens an empty round, and a
  // stale one — the last board on disk, after a restart that cannot reach the
  // upstream — opens a round whose starting ranks nobody can check, priced off
  // a market that has since moved. The next tick tries again.
  if (!standings.length || !oracle.isLive()) return withBook(null);

  // Nor before the round this one follows has been cut, since that cut is what
  // decides the crown. See `crownDecided`.
  const previous = await prisma.round.findFirst({
    where: { startsAt: { lt: startsAt } },
    orderBy: { startsAt: "desc" },
    select: { status: true, seed: true },
  });
  if (!crownDecided(previous)) return withBook(null);

  const crownSymbol = await reigningCrown();
  const seed = randomBytes(32).toString("hex");
  const lockAt = new Date(startsAt.getTime() + ROUND_MS - CUT_MS);
  const endsAt = new Date(startsAt.getTime() + ROUND_MS);

  try {
    const opened = await prisma.round.create({
      data: {
        startsAt,
        lockAt,
        endsAt,
        crownSymbol,
        cutWindowSeconds: CUT_WINDOW_SECONDS,
        seed, // held back from the API until settlement
        commitHash: commitmentOf(seed),
        entries: {
          create: standings.map((s) => ({
            symbol: s.symbol,
            ticker: s.ticker,
            startRank: s.rank,
            startVolume: s.quoteVolume,
          })),
        },
      },
      include: { entries: { orderBy: { startRank: "asc" } } },
    });
    return withBook(opened);
  } catch (err) {
    // Losing the race with a concurrent opener is the expected failure here —
    // `startsAt` is unique, so the loser is the one that throws and the
    // winner's round is already there to take.
    const theirs = await prisma.round.findUnique({
      where: { startsAt },
      include: { entries: { orderBy: { startRank: "asc" } } },
    });
    // Nothing there means it wasn't a race: the round genuinely failed to open,
    // and the next tick will fail the same way. Say so. Swallowing this is what
    // turned a bad field into an hour of silence — the pool had arrived
    // carrying one symbol twice, every create died on RoundEntry's
    // (roundId, symbol) key, and the game simply stopped opening rounds with
    // nothing in the log to say why.
    if (!theirs) {
      console.warn("⚠  could not open round:", err instanceof Error ? err.message : err);
    }
    return withBook(theirs);
  }
}

/**
 * Advance every round that isn't finished: close betting, record the board at
 * the cut instant, then settle and reveal.
 *
 * Recording at the cut (rather than reconstructing it later) is what makes the
 * result durable — the ranking only lives in memory, so if the process restarts
 * between the cut and settlement there would be nothing to settle against.
 */
export async function tickRounds(): Promise<void> {
  const now = new Date();
  const live = await prisma.round.findMany({
    where: { status: { in: ["OPEN", "LOCKED", "CUT"] } },
    include: { entries: true },
  });

  for (const round of live) {
    if (round.status === "OPEN" && now >= round.lockAt) {
      await prisma.round.update({
        where: { id: round.id },
        data: { status: "LOCKED" },
      });
      round.status = "LOCKED";
    }

    if (round.status === "LOCKED") {
      if (!round.seed) continue;
      // Derived with the round's own window, not the current env's.
      const cutAt = new Date(
        round.lockAt.getTime() +
          cutOffsetMs(round.seed, round.id, round.cutWindowSeconds * 1000)
      );
      const decision = cutDecision(now.getTime(), cutAt.getTime(), {
        live: oracle.isLive(),
        describes: oracle.updatedAt,
      });
      if (decision === "wait") continue;
      if (decision === "void") {
        console.warn(
          `⚠  round ${round.id}: no live reading of the market within ` +
            `${CUT_GRACE_MS / 1000}s of its cut — every bet on it is refunded`
        );
      }
      await recordCut(round.id, cutAt, decision === "record" ? oracle.standings(BOARD_SIZE) : null);
      round.status = "CUT";
    }

    if (round.status === "CUT" && now >= round.endsAt) {
      await settleRound(round.id);
    }
  }
}

/**
 * Freeze the board into the round's entries.
 *
 * With no board, freeze nothing: the round is still cut, so it moves on to
 * settlement like any other, but every entry is left unranked — and settlement
 * refunds a bet whose coin has no cut rank. See `cutDecision`.
 */
async function recordCut(roundId: string, cutAt: Date, standings: Standing[] | null): Promise<void> {
  const bySymbol = new Map((standings ?? []).map((s) => [s.symbol, s]));

  await prisma.$transaction(async (tx) => {
    const claimed = await tx.round.updateMany({
      where: { id: roundId, status: "LOCKED" },
      data: { status: "CUT", cutAt },
    });
    if (claimed.count !== 1) return; // another worker got there first
    if (!standings) return;

    const entries = await tx.roundEntry.findMany({ where: { roundId } });
    for (const e of entries) {
      const now = bySymbol.get(e.symbol);
      await tx.roundEntry.update({
        where: { id: e.id },
        // Dropping off the board counts as falling below its last visible slot.
        data: {
          cutRank: now?.rank ?? BOARD_SIZE + 1,
          // Rank and volume are not the same kind of number, and falling off the
          // board only settles the first of them. `BOARD_SIZE + 1` is a rule
          // about what a relegated coin is scored at; the volume is a
          // measurement of a coin that is still trading, and taking it off the
          // board wrote 0 for precisely the coins whose demotion the round was
          // about — the cut's own record of the race then said they had stopped.
          cutVolume: now?.quoteVolume ?? oracle.tokenFor(e.symbol)?.volume ?? 0,
        },
      });
    }
  });
}

function outcomeOf(startRank: number, cutRank: number): "HIGHER" | "DRAW" | "LOWER" {
  if (cutRank < startRank) return "HIGHER";
  if (cutRank > startRank) return "LOWER";
  return "DRAW";
}

/**
 * Pay out every bet on the round, then publish the seed.
 *
 * Decided in memory and written in a fixed number of statements, whatever the
 * size of the round. It used to be a transaction per bet, which is fine for a
 * round holding a handful of bets and stops being fine at a busy one: at 0.3ms a
 * bet, two thousand bets spent six-tenths of a second of round-trips inside a
 * loop that runs every second. The shape has to hold at the size a round can
 * reach, not at the size most of them do.
 *
 * The round's own CUT → SETTLED flip is the claim, taken first and inside the
 * transaction, so two workers cannot both pay the same round and a crash
 * half-way rolls the whole thing back rather than leaving it half-paid.
 *
 * **Credits follow the rows that actually moved.** The status updates are
 * guarded on `status = 'OPEN'`, so a bet that was closed between the read and
 * the write is correctly skipped — but the amount to credit used to be summed
 * from the *read*, which meant a skipped bet was still paid for. That is a bet
 * settled and cashed out, one stake, two payouts. Summing from `RETURNING`
 * instead makes the credit a consequence of the update rather than a parallel
 * belief about it, and the two cannot drift apart no matter what raced.
 */
/** Test seam — settlement is otherwise only reachable from the round loop. */
export async function settleRoundForTest(id: string) {
  return settleRound(id);
}
async function settleRound(roundId: string): Promise<void> {
  const round = await prisma.round.findUnique({
    where: { id: roundId },
    include: { entries: true, bets: { where: { status: "OPEN" } } },
  });
  if (!round || round.status === "SETTLED") return;

  const cutBySymbol = new Map(round.entries.map((e) => [e.symbol, e.cutRank]));
  const resolvedAt = new Date();

  const won: { id: string; payout: number; cutRank: number }[] = [];
  const lost: { id: string; cutRank: number }[] = [];
  const voided: string[] = [];

  for (const bet of round.bets) {
    const cutRank = cutBySymbol.get(bet.symbol);
    // No cut was recorded for that coin, and none ever will be — the cut is an
    // instant that has passed. Leaving the bet OPEN used to strand it forever:
    // the round settles around it, nothing ever revisits it, and the stake is
    // simply gone. It is refunded instead, which is what VOID is for.
    if (cutRank == null) {
      voided.push(bet.id);
    } else if (outcomeOf(bet.startRank, cutRank) === bet.direction) {
      won.push({ id: bet.id, payout: Math.round(bet.stake * bet.odds), cutRank });
    } else {
      lost.push({ id: bet.id, cutRank });
    }
  }

  await prisma.$transaction(
    async (tx) => {
      const claimed = await tx.round.updateMany({
        where: { id: roundId, status: "CUT" },
        data: { status: "SETTLED" },
      });
      if (claimed.count !== 1) return; // another worker is paying this one

      // `unnest` turns each list into a table to join against, so the number of
      // statements is fixed even when the number of bets is not. `RETURNING`
      // reports which rows the guard actually let through — the only sound basis
      // for crediting anyone.
      const owed = new Map<string, number>();
      const credit = (rows: { userId: string; amount: number }[]) => {
        for (const { userId, amount } of rows) {
          owed.set(userId, (owed.get(userId) ?? 0) + amount);
        }
      };

      if (won.length) {
        credit(
          await tx.$queryRaw<{ userId: string; amount: number }[]>`
            UPDATE "CryptoBet" AS b
               SET status = 'WON'::"BetStatus", payout = v.payout,
                   "cutRank" = v.cut, "resolvedAt" = ${resolvedAt}
              FROM (SELECT unnest(${won.map((w) => w.id)}::text[]) AS id,
                           unnest(${won.map((w) => w.payout)}::int[]) AS payout,
                           unnest(${won.map((w) => w.cutRank)}::int[]) AS cut) AS v
             WHERE b.id = v.id AND b.status = 'OPEN'::"BetStatus"
         RETURNING b."userId" AS "userId", v.payout AS amount`
        );
      }
      if (voided.length) {
        credit(
          await tx.$queryRaw<{ userId: string; amount: number }[]>`
            UPDATE "CryptoBet" AS b
               SET status = 'VOID'::"BetStatus", payout = b.stake,
                   "resolvedAt" = ${resolvedAt}
             WHERE b.id = ANY(${voided}::text[]) AND b.status = 'OPEN'::"BetStatus"
         RETURNING b."userId" AS "userId", b.stake AS amount`
        );
      }
      if (lost.length) {
        await tx.$executeRaw`
          UPDATE "CryptoBet" AS b
             SET status = 'LOST'::"BetStatus", payout = 0,
                 "cutRank" = v.cut, "resolvedAt" = ${resolvedAt}
            FROM (SELECT unnest(${lost.map((l) => l.id)}::text[]) AS id,
                         unnest(${lost.map((l) => l.cutRank)}::int[]) AS cut) AS v
           WHERE b.id = v.id AND b.status = 'OPEN'::"BetStatus"`;
      }
      if (owed.size) {
        const ids = [...owed.keys()];
        await tx.$executeRaw`
          UPDATE "User" AS u
             SET credits = u.credits + v.amount
            FROM (SELECT unnest(${ids}::text[]) AS id,
                         unnest(${ids.map((id) => owed.get(id)!)}::int[]) AS amount) AS v
           WHERE u.id = v.id`;
      }
    },
    { timeout: 30_000 }
  );
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Drive the round lifecycle. 1s cadence so the cut lands within a second of true. */
export function startRoundLoop(): void {
  if (timer) return;
  const run = () => {
    void currentRound()
      .then(() => tickRounds())
      .catch((err) => console.warn("⚠  round loop:", err?.message ?? err));
  };
  timer = setInterval(run, 1_000);
  run();
}

export function stopRoundLoop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
