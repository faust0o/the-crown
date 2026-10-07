import type { Keypair } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";

import { connection } from "./program";
import { decodeRound, type ChainRound } from "./rounds";

/**
 * Rounds that still owe somebody, however old they are.
 *
 * ## Why this exists
 *
 * The runner works a window of the most recent rounds, which is the right shape
 * for the ordinary case — a round is opened, cut, revealed and paid within a few
 * of its successors, and re-reading the older ones forever is what exhausted the
 * request quota once already.
 *
 * It is the wrong shape for the case that actually costs a player money. A round
 * that fails to reveal, or whose payout sweep is interrupted, keeps its open
 * positions; the window then moves past it and *nothing ever looks at it again*.
 * That is not a delay, it is abandonment, and on devnet it had already happened
 * three times: 173 positions and about 3.4 million credits of stake sitting
 * behind rounds 0, 20 and 198 while the runner swept indices 401-410. The oldest
 * had been payable for twelve days.
 *
 * So the work list is taken from the debt rather than from the calendar. An open
 * `Bet` account *is* an unpaid position — `settle_bet` closes it when it pays —
 * so asking the cluster for the open bets asks exactly the right question, and no
 * round can age out of the answer.
 *
 * ## What it costs
 *
 * One `getProgramAccounts`, which is the most expensive call the program makes,
 * so this is deliberately rare — see `ARREARS_EVERY_MS` in the runner. It is
 * filtered to open bets and sliced to the one field it needs (the round each
 * belongs to), so a cluster that has paid everything returns nothing.
 */

/** `Bet`: discriminator(8) + round(32). Its status sits after the fixed head. */
export const BET_ROUND_OFFSET = 8;
/** discriminator(8) round(32) owner(32) entry_index(1) direction(1) stake(8) shares(8) start_rank(2) */
export const BET_STATUS_OFFSET = 8 + 32 + 32 + 1 + 1 + 8 + 8 + 2;
/** `BetStatus::Open` is the first variant, so one zero byte — "1" in base58. */
export const OPEN = "1";

export interface Arrears {
  round: ChainRound;
  /** Open positions found on it, which is what it owes. */
  positions: number;
}

export async function roundsInArrears(payer: Keypair): Promise<Arrears[]> {
  void payer; // symmetry with the other chain calls; this one signs nothing
  const conn = connection();
  const programId = (await import("./program")).PROGRAM_ID;

  const open = await conn.getProgramAccounts(programId, {
    filters: [
      { memcmp: { offset: BET_STATUS_OFFSET, bytes: OPEN } },
      { dataSize: BET_ACCOUNT_SIZE },
    ],
    dataSlice: { offset: BET_ROUND_OFFSET, length: 32 },
  });

  const owed = new Map<string, number>();
  for (const row of open) {
    const round = new PublicKey(row.account.data).toBase58();
    owed.set(round, (owed.get(round) ?? 0) + 1);
  }
  if (!owed.size) return [];

  // One batched read for the rounds themselves, so this is two calls whatever
  // the size of the backlog.
  const addresses = [...owed.keys()].map((k) => new PublicKey(k));
  const infos = await conn.getMultipleAccountsInfo(addresses);

  const out: Arrears[] = [];
  infos.forEach((info, i) => {
    if (!info?.data?.length) return; // round account closed out from under its bets
    out.push({
      round: decodeRound(addresses[i], info.data as Buffer),
      positions: owed.get(addresses[i].toBase58()) ?? 0,
    });
  });
  // Oldest debt first: it has been waiting longest and, on a cluster that is
  // behind, it is the one a player has already given up on.
  return out.sort((a, b) => Number(a.round.index - b.round.index));
}

/**
 * `Bet`'s on-chain size, discriminator included.
 *
 * Pinned so the status filter cannot accidentally match a different account type
 * that happens to carry a zero at the same offset.
 */
export const BET_ACCOUNT_SIZE =
  8 + 32 + 32 + 1 + 1 + 8 + 8 + 2 + 1 + 8 + 8 + 8 + 32 + 1;
