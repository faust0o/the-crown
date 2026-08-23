import type { Keypair } from "@solana/web3.js";

import { configPda, connection, crownProgram, entryPda } from "./program";
import { sendChainTx } from "./send";
import { openPositions } from "./settle";
import type { ChainRound } from "./rounds";

/**
 * Giving a finished round's storage back.
 *
 * A round and its ten entries hold about 0.02 SOL of rent between them, and
 * nothing ever released it: at half-hour rounds that is roughly a SOL a day,
 * accruing forever, for accounts describing races that finished. Positions
 * already refund when they settle, so this was the last thing in the system that
 * only ever grew.
 *
 * ## What is discarded, and why that is safe
 *
 * The round account carries the commitment, the revealed seed and the cut ranks,
 * which is the evidence a player would use to check the house did not choose
 * when to look. Closing it does not destroy that evidence — the evidence was
 * never *in* the account. `open_round` published the commitment and
 * `reveal_seed` published the seed, both permanently in the ledger, and anyone
 * can recompute `sha256(seed)` against the commitment from those transactions
 * alone. What goes is a convenient index into history, not the history.
 *
 * ## Entries first, then the round
 *
 * `settle_bet` reads the entry account to decide an outcome, so an entry closed
 * while a position still expects to settle against it strands that position for
 * good. The program refuses to close anything until an hour past the round's end
 * (`SETTLEMENT_GRACE_SECONDS`), and this refuses to start unless the round has no
 * open positions left. Two independent guards, because the failure is permanent
 * and silent.
 */

/** How many rounds to reclaim per sweep. */
const BATCH = Number(process.env.CHAIN_RECLAIM_BATCH ?? 1);

export interface ReclaimResult {
  round: bigint;
  entriesClosed: number;
  roundClosed: boolean;
  lamports: number;
}

/**
 * Close one finished round, entries first.
 *
 * Returns null when the round is not eligible — still owed, or inside the grace
 * window — rather than throwing, because both are the ordinary case and the
 * caller's response to either is to try a different round next tick.
 */
export async function reclaimRound(opts: {
  round: ChainRound;
  authority: Keypair;
  graceSeconds?: number;
}): Promise<ReclaimResult | null> {
  const { round, authority } = opts;
  const grace = opts.graceSeconds ?? 3600;

  if (round.status !== "Settled") return null;
  if (Date.now() < round.endsAt.getTime() + grace * 1000) return null;

  // The program checks the clock; this checks the debts. Neither alone is
  // enough: the grace window says settlement has had time to finish, and this
  // says it actually did.
  const stillOwed = await openPositions(round, authority);
  if (stillOwed.length > 0) return null;

  const conn = connection();
  const program = crownProgram(authority, conn);
  const before = await conn.getBalance(authority.publicKey);

  let entriesClosed = 0;
  // Indices are dense for rounds opened by `openChainRound`, but the earliest
  // rounds have a hole where the crown sat, so a missing account is skipped
  // rather than treated as the end of the list.
  for (let i = 0; i < Math.max(round.entryCount, 10); i++) {
    const entry = entryPda(round.address, i);
    if (!(await conn.getAccountInfo(entry))) continue;
    try {
      await program.methods
        .closeRoundEntry()
        .accounts({
          config: configPda(),
          round: round.address,
          entry,
          authority: authority.publicKey,
        })
        .transaction()
        .then((tx) => sendChainTx({ tx, signers: [authority] }));
      entriesClosed += 1;
    } catch (err) {
      // **Abort the whole round, do not carry on.**
      //
      // `settle_bet` reads both the round and the entry, so an entry closed
      // while a position still references it strands that position for good —
      // permissionless settlement exists precisely so an owner can always
      // collect, and a missing entry takes that away. Continuing past a failed
      // close and then closing the round would turn one failure into exactly
      // that. Leaving the rest open costs a little rent until the next sweep.
      console.warn(
        `⚠  chain/reclaim round ${round.index}: entry ${i} would not close, leaving the round alone —`,
        String(err).split("\n")[0].slice(0, 120)
      );
      return { round: round.index, entriesClosed, roundClosed: false, lamports: 0 };
    }
  }

  let roundClosed = false;
  try {
    await program.methods
      .closeRound()
      .accounts({
        config: configPda(),
        round: round.address,
        authority: authority.publicKey,
      })
      .transaction()
      .then((tx) => sendChainTx({ tx, signers: [authority] }));
    roundClosed = true;
  } catch (err) {
    // Leaving the round open after its entries have gone is safe and temporary:
    // it holds one account's rent and the next sweep will finish the job.
    console.warn(`⚠  chain/reclaim round ${round.index}:`, String(err).split("\n")[0].slice(0, 120));
  }

  return {
    round: round.index,
    entriesClosed,
    roundClosed,
    lamports: (await conn.getBalance(authority.publicKey)) - before,
  };
}

export { BATCH as RECLAIM_BATCH };
