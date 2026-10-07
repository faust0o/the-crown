import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";

// Type-only, so it is erased rather than evaluated — the runtime import that
// picks up the RPC below has to be the first time this module is loaded.
import type { ChainRound, RoundStatus } from "./rounds";

/**
 * The guards in front of closing a round's accounts.
 *
 * Reclaiming is the one irreversible thing the runner does. `settle_bet` reads
 * the entry account to decide an outcome, so an entry closed while a position
 * still expects to settle against it strands that position **for good** — there
 * is no second attempt, because the account it needed is gone and the rent is
 * spent. `reclaim.ts` puts two independent guards in front of that, and both are
 * decided before any network call, which is what makes them checkable here.
 *
 * The ordering is as much the subject as the return values are. A round that is
 * refused on its status or its clock must be refused *without asking a cluster*:
 * this runs against every round in the window on every tick, and a guard that
 * reached the network first would put the most expensive call in the program in
 * front of the cheapest decision it makes.
 *
 * So the RPC is pointed at a closed port. A case that gets past the guards fails
 * to connect, deterministically and on any machine — including one with a local
 * validator running, which would otherwise quietly answer and let a broken guard
 * look like a working one.
 */
process.env.SOLANA_RPC_URL = "http://127.0.0.1:1";
const { reclaimRound } = await import("./reclaim");

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function round(status: RoundStatus, endedMsAgo: number): ChainRound {
  const ended = Date.now() - endedMsAgo;
  return {
    index: 77n,
    address: PublicKey.unique(),
    startsAt: new Date(ended - 30 * MINUTE),
    lockAt: new Date(ended - 5 * MINUTE),
    endsAt: new Date(ended),
    status,
    entryCount: 10,
    crownSymbol: "cbBTC",
    commitHash: "00".repeat(32),
  };
}

const reclaim = (r: ChainRound, graceSeconds?: number) =>
  reclaimRound({ round: r, authority: Keypair.generate(), graceSeconds });

/** Refused on a guard: a null, and no cluster was asked. */
const refused = async (r: ChainRound, graceSeconds?: number) =>
  assert.equal(await reclaim(r, graceSeconds), null);

/**
 * Past the guards: the decision now needs the debts, so it reaches for the
 * cluster that is not there. Not a happy path — it is how "the guard let this
 * one through" is observed without standing up a validator.
 */
const reachesForTheCluster = async (r: ChainRound, graceSeconds?: number) =>
  assert.rejects(() => reclaim(r, graceSeconds), "expected this round to get past the guards");

describe("what may not be reclaimed", () => {
  it("refuses a round that is still open", async () => {
    await refused(round("Open", 2 * HOUR));
  });

  it("refuses a round that has been cut but never revealed", async () => {
    // The dangerous one: its positions are unsettled and still payable, and its
    // entries are the only record of the ranks they would settle against.
    await refused(round("Cut", 2 * HOUR));
  });

  it("refuses a voided round, whose positions are still owed refunds", async () => {
    // `void_round` makes every stake on the round refundable and `settle_bet`
    // pays them out, so a voided round is *more* likely to owe money than a
    // settled one, not less — however long ago it ended. `close_round` requires
    // `Settled` on chain as well; this guard is what stops the runner spending a
    // transaction per tick to be told so.
    await refused(round("Voided", 30 * 24 * HOUR));
  });

  it("refuses a settled round that ended inside the grace window", async () => {
    // The clock guard. Settlement takes several sweeps, so `Settled` is when
    // paying *may* begin rather than when it has finished — closing on the
    // status alone would race the sweep still working through the round.
    await refused(round("Settled", 5 * MINUTE));
  });

  it("holds the default grace window at the hour the program does", async () => {
    // Both sides check it and the program's `SETTLEMENT_GRACE_SECONDS` is the
    // one that decides. Shorter here and every reclaim is a refused transaction;
    // longer and rent sits locked up for no reason. Pinned from both sides.
    await refused(round("Settled", 59 * MINUTE));
    await reachesForTheCluster(round("Settled", 61 * MINUTE));
  });

  it("takes an override in place of the default window", async () => {
    const settled = round("Settled", 10 * MINUTE);
    await refused(settled, 3600);
    await reachesForTheCluster(settled, 60);
  });

  it("checks the status before the clock, so an old open round is still cheap", async () => {
    // Order matters for the case the runner actually meets: a round abandoned
    // long ago is past every clock and would sail into the debt scan on status
    // alone. It is refused on the status instead, without a request.
    await refused(round("Open", 30 * 24 * HOUR));
    await refused(round("Cut", 30 * 24 * HOUR));
  });
});
