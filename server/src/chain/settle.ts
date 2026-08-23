import type { Keypair } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";

import { configPda, connection, crownProgram, entryPda, vaultPda } from "./program";
import { sendChainTx } from "./send";
import type { ChainRound } from "./rounds";

/**
 * Paying out a settled round.
 *
 * `reveal_seed` ends the round; it does not pay anybody. Every position is its
 * own account and its own transfer, so settlement is a sweep — and until this
 * ran, a winning position stayed `Open` forever and its rent stayed spent. That
 * is the one failure in this design that costs a player money rather than
 * merely annoying them.
 *
 * ## Why the server does this at all
 *
 * `settle_bet` is permissionless precisely so it does not depend on us: the
 * payout is computed from the position and can only reach the position's owner,
 * so anybody may call it for anybody. That is the property that means a player
 * whose house has vanished can still collect.
 *
 * The server doing it anyway is a convenience, not a requirement. It is also why
 * failing here is survivable: a position missed on this pass is picked up on the
 * next, by us or by its owner, and the only cost of a miss is a delay.
 */

/** How many settlements to have in flight at once. */
const CONCURRENCY = Number(process.env.CHAIN_SETTLE_CONCURRENCY ?? 2);

/**
 * How many to attempt in one sweep.
 *
 * A round can hold a few hundred positions and the sweep runs on a five-second
 * timer, so an unbounded pass would overlap itself and put the same transaction
 * on the wire twice — wasted fees, and a second one that fails confusingly
 * because the first already closed the account. Bounded, the remainder is simply
 * next tick's work.
 */
const BATCH = Number(process.env.CHAIN_SETTLE_BATCH ?? 20);

export interface OpenPosition {
  address: PublicKey;
  owner: PublicKey;
  entryIndex: number;
  direction: number;
  stake: bigint;
  shares: bigint;
  rentPayer: PublicKey;
}

/**
 * Every position still open on a round.
 *
 * A `getProgramAccounts` scan filtered to this round — the expensive call that
 * `rpc-proxy.ts` deliberately refuses to browsers. The server holds the real
 * endpoint and is the right place for it: the alternative is tracking positions
 * from `BetPlaced` events, which works until a restart and then quietly does
 * not, and a settlement sweep that forgets what it owes is worse than a slow one.
 */
export async function openPositions(round: ChainRound, payer: Keypair): Promise<OpenPosition[]> {
  // `payer` is only here because Anchor's account client wants a provider; this
  // signs nothing and writes nothing.
  const program = crownProgram(payer, connection());
  const rows = await (program.account as any).bet.all([
    // `round` is the first field after the discriminator.
    { memcmp: { offset: 8, bytes: round.address.toBase58() } },
  ]);

  const open: OpenPosition[] = [];
  for (const row of rows) {
    const a = row.account;
    // `status` is an Anchor enum, which decodes as `{ open: {} }`.
    if (!("open" in (a.status ?? {}))) continue;
    open.push({
      address: row.publicKey,
      owner: new PublicKey(a.owner),
      entryIndex: a.entryIndex,
      direction: a.direction,
      stake: BigInt(a.stake.toString()),
      shares: BigInt(a.shares.toString()),
      rentPayer: new PublicKey(a.rentPayer),
    });
  }
  return open;
}

export interface SweepResult {
  attempted: number;
  settled: number;
  failed: number;
  remaining: number;
}

/**
 * Pay out what this round owes, up to a batch.
 *
 * Failures are counted rather than thrown. The commonest one is benign and
 * expected: two sweeps racing, where the second finds an account the first has
 * already closed. Treating that as fatal would stop the sweep on its most
 * ordinary event and strand every position behind it.
 */
export async function sweepSettlements(opts: {
  round: ChainRound;
  payer: Keypair;
  mint: PublicKey;
  /** How many to attempt now. Defaults to `BATCH`; see `limit` in the runner. */
  limit?: number;
  /**
   * Called with the position accounts this sweep settled, so the rows indexing
   * them can be brought in line. Optional because settlement must not depend on
   * a database being reachable: the money is on-chain and the payout has already
   * happened by the time this is called.
   */
  onSettled?: (addresses: string[]) => Promise<void>;
}): Promise<SweepResult> {
  const { round, payer, mint } = opts;
  const conn = connection();
  const program = crownProgram(payer, conn);

  const all = await openPositions(round, payer);
  const batch = all.slice(0, Math.max(1, opts.limit ?? BATCH));

  let settled = 0;
  let failed = 0;

  for (let i = 0; i < batch.length; i += CONCURRENCY) {
    const slice = batch.slice(i, i + CONCURRENCY);
    const outcomes = await Promise.allSettled(
      slice.map((p) =>
        program.methods
          .settleBet()
          .accounts({
            config: configPda(),
            round: round.address,
            entry: entryPda(round.address, p.entryIndex),
            bet: p.address,
            // The payout can only go here — the program constrains it to the
            // position's owner, which is what makes calling this for somebody
            // else's position safe rather than merely permitted.
            ownerTokens: getAssociatedTokenAddressSync(mint, p.owner),
            vault: vaultPda(),
            rentReceiver: p.rentPayer,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .transaction()
          // Preflight skipped: this sweep races itself and the owner by design,
          // so "already settled" is the expected outcome rather than a fault.
          // Simulating every attempt spends a request per position to learn what
          // the send reports anyway.
          .then((tx) => sendChainTx({ tx, signers: [payer], skipPreflight: true }))
      )
    );

    const justSettled: string[] = [];
    for (const [j, outcome] of outcomes.entries()) {
      if (outcome.status === "fulfilled") {
        settled += 1;
        justSettled.push(slice[j].address.toBase58());
        continue;
      }
      failed += 1;
      const why = String(outcome.reason);

      // **The message may be a lie, so ask the chain instead.**
      //
      // Anchor 0.32 constructs `SendTransactionError` with the *old* positional
      // signature (`provider.js:122`: `new SendTransactionError(err.message,
      // logs)`), and web3.js 1.98 destructures an object from it. The string
      // lands where `action` should be, the switch falls through, and every
      // failure that carried logs arrives as `Unknown action 'undefined'` with
      // the real message and the logs both discarded.
      //
      // That breaks matching on the text — the commonest failure here is a
      // position somebody already settled, which should be silent, and it was
      // being reported as an unknown error every time. So the benign case is
      // established by looking: an account that is gone was settled, by another
      // sweep or by its owner, which is the system working exactly as intended.
      const stillThere = await conn.getAccountInfo(slice[j].address).catch(() => null);
      if (!stillThere) continue;

      if (why.includes("AccountNotInitialized") || why.includes("BetNotOpen")) continue;
      console.warn(
        `⚠  chain/settle ${slice[j].address.toBase58().slice(0, 8)}…:`,
        why.includes("Unknown action")
          ? "the transaction failed and Anchor discarded the reason (see the note in settle.ts)"
          : why.split("\n")[0].slice(0, 160)
      );
    }

    // After the payouts, and never in their way. A failure here leaves a row
    // saying OPEN for a position that has been paid — visibly wrong, and fixed
    // by the next sweep — where a failure *before* them would delay real money
    // over a bookkeeping problem.
    if (justSettled.length && opts.onSettled) {
      await opts.onSettled(justSettled).catch((err) =>
        console.warn("⚠  chain/settle rows:", err instanceof Error ? err.message : err)
      );
    }
  }

  return {
    attempted: batch.length,
    settled,
    failed,
    remaining: Math.max(0, all.length - settled),
  };
}
