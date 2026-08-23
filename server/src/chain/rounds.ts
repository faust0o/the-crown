import { createHash } from "node:crypto";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";

import { CUT_WINDOW_SECONDS, ROUND_MINUTES } from "../rounds";
import { probabilities } from "../crypto-odds";
import { BOARD_SIZE, oracle, type Standing } from "../oracle/index";
import { CAP_CENTS, FLOOR_CENTS } from "./pricing";
import { invalidateBoard, readBoard } from "./book";
import {
  BN,
  configPda,
  connection,
  crownProgram,
  entryPda,
  roundPda,
  vaultPda,
  type CrownProgram,
} from "./program";
import { sendChainTx } from "./send";

/**
 * The round lifecycle, on-chain.
 *
 * `../rounds.ts` does this against Postgres and still does: it owns the clock,
 * the wall-clock alignment and the schedule everything else reads. What moves
 * here is the part a player should not have to take anybody's word for — the
 * commitment published before a bet exists, the board frozen at the cut, and the
 * seed revealed against that commitment afterwards.
 *
 * The two are deliberately not merged. The database round is what the API serves
 * and what the UI has always read; the chain round is what the money settles
 * against. Keeping the schedule in one place and the settlement in the other is
 * what lets this be switched on without the game stopping if it is switched off
 * again — see `CHAIN_ROUNDS` in `env.ts`.
 *
 * ## The opening auction is computed here
 *
 * `add_entry` takes the stake per leg rather than deriving it, because deriving
 * it needs `probabilities` and the `erf`/`probit` machinery under it — the
 * floating-point model that `pricing.rs` explains at length does not belong
 * on-chain. This is where that model gets its one and only say on price. After
 * this instruction the mark is the pool's share and nothing else.
 */

const tunable = (name: string, fallback: number): number => {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) ? raw : fallback;
};

/**
 * Credits the opening auction stakes across one coin's three lines.
 *
 * The same quantity as `MARKET_OPENING_POOL` in `market.ts` and for the same
 * reason — it is the liquidity, denominated in credits, that a round's buying
 * has to out-weigh in order to argue with the model. Unlike the in-memory
 * version this one is a **real deposit**: `add_entry` transfers it from the
 * authority into the vault, so the pool the book prices against is the pool the
 * vault holds.
 */
const OPENING_POOL = tunable("CHAIN_OPENING_POOL", 300_000);

const pad = (s: string, n: number): number[] => {
  const b = Buffer.alloc(n);
  b.write(s.slice(0, n));
  return Array.from(b);
};

const unpad = (bytes: number[] | Uint8Array): string =>
  Buffer.from(bytes).toString("utf8").replace(/\0+$/, "");

export interface ChainRound {
  index: bigint;
  address: PublicKey;
  startsAt: Date;
  lockAt: Date;
  endsAt: Date;
  status: "Open" | "Cut" | "Settled";
  entryCount: number;
  crownSymbol: string | null;
  commitHash: string;
}

/**
 * The seed for a round, held until it is time to reveal.
 *
 * In memory, and that is a real limitation worth naming: a restart between a
 * round opening and its cut loses the seed, and a round whose seed is lost can
 * never be revealed — its positions stay open and only `Void` would free them.
 * The database round already stores its seed for exactly this reason, so the
 * chain round borrows it rather than keeping a second copy that can disagree.
 */
const seeds = new Map<string, Buffer>();

/** Remember the seed a database round committed to, keyed by chain round index. */
export function rememberSeed(index: bigint, seedHex: string): void {
  seeds.set(index.toString(), Buffer.from(seedHex, "hex"));
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest();

/**
 * Decode a `Round` account by byte offset.
 *
 * Same reasoning as `book.ts`: reading the chain should not require a signing
 * wallet, and Anchor's client wants a provider. The offsets are checked against
 * Anchor's own decoding in the smoke test.
 */
function decodeRound(address: PublicKey, data: Buffer): ChainRound {
  let o = 8;
  const index = data.readBigUInt64LE(o); o += 8;
  const startsAt = Number(data.readBigInt64LE(o)); o += 8;
  const lockAt = Number(data.readBigInt64LE(o)); o += 8;
  const endsAt = Number(data.readBigInt64LE(o)); o += 8;
  const commitHash = Buffer.from(data.subarray(o, o + 32)).toString("hex"); o += 32;
  o += 32; // seed
  o += 8;  // cutAt
  o += 4;  // cutWindowSeconds
  const crownSymbol = unpad(data.subarray(o, o + 16)); o += 16;
  const status = (["Open", "Cut", "Settled"] as const)[data.readUInt8(o)] ?? "Open"; o += 1;
  const entryCount = data.readUInt16LE(o);

  return {
    index,
    address,
    startsAt: new Date(startsAt * 1000),
    lockAt: new Date(lockAt * 1000),
    endsAt: new Date(endsAt * 1000),
    status,
    entryCount,
    crownSymbol: crownSymbol || null,
    commitHash,
  };
}

/**
 * The last `n` rounds, newest first.
 *
 * Settlement needs a window rather than just the newest, because a round is
 * revealed and *then* paid, and the paying takes several sweeps. Looking only at
 * the newest meant that the moment the next round opened, whatever the previous
 * one still owed stopped being anybody's job — positions stranded, open forever,
 * with their rent still spent.
 */
export async function recentRounds(n = 3): Promise<ChainRound[]> {
  const conn = connection();
  const cfg = await conn.getAccountInfo(configPda());
  if (!cfg) return [];
  const count = cfg.data.readBigUInt64LE(8 + 32 + 32);
  if (count === 0n) return [];

  const wanted: bigint[] = [];
  for (let i = 0n; i < BigInt(n) && count - 1n - i >= 0n; i++) wanted.push(count - 1n - i);

  const infos = await conn.getMultipleAccountsInfo(wanted.map((i) => roundPda(i)));
  const out: ChainRound[] = [];
  infos.forEach((info, i) => {
    if (info?.data?.length) out.push(decodeRound(roundPda(wanted[i]), info.data as Buffer));
  });
  return out;
}

/**
 * How long a read of the current round is good for.
 *
 * Same reasoning as the board cache in `book.ts`, and it matters more than it
 * looks: every desk turn began by reading this, at two account fetches each, and
 * the desks arrive once a second. That was a quarter of the entire request
 * budget spent re-asking a question whose answer changes twice in half an hour.
 *
 * Nothing that must be current reads through this. `place_bet` re-reads the
 * round inside the transaction, so a stale view here can cost a desk its turn —
 * the program refuses the bet — but can never let one trade a round that is
 * closed.
 */
const ROUND_TTL_MS = Number(process.env.CHAIN_ROUND_TTL_MS ?? 3_000);

let roundCache: { until: number; round: ChainRound | null } | null = null;

/** Forget the cached round. Used when we have just changed it ourselves. */
export function invalidateRound(): void {
  roundCache = null;
}

/** The most recently opened round, or null before there is one. */
export async function latestRound(): Promise<ChainRound | null> {
  if (roundCache && Date.now() < roundCache.until) return roundCache.round;

  const conn = connection();
  const cfg = await conn.getAccountInfo(configPda());
  if (!cfg) return null;
  // `round_count` sits after the discriminator, authority and mint.
  const count = cfg.data.readBigUInt64LE(8 + 32 + 32);
  if (count === 0n) return null;

  const index = count - 1n;
  const address = roundPda(index);
  const info = await conn.getAccountInfo(address);
  const round = info ? decodeRound(address, info.data as Buffer) : null;
  roundCache = { until: Date.now() + ROUND_TTL_MS, round };
  return round;
}

/**
 * Which legs a coin is offered on, and what the auction stakes on each.
 *
 * Mirrors `openRound` in `market.ts` exactly, because the two must agree about
 * what is bettable or the board and the chain would disagree about which chips
 * exist. Two legs never open, for different reasons:
 *
 * - the crown is closed outright — a reigning coin resolves as a near-certain
 *   DRAW, and taking it off the book leaves the interesting bet intact;
 * - a coin that opened at rank 1 cannot finish HIGHER, and one that opened last
 *   is not offered LOWER. The second *can* happen — dropping off the board is
 *   exactly that — but the round does not offer the bet, and `target` is what
 *   keeps its share of the hundred out of the other two legs' pool.
 */
function auctionFor(
  standing: Standing,
  fieldSize: number,
  isCrown: boolean
): { quoted: [boolean, boolean, boolean]; opening: [number, number, number]; target: number } | null {
  if (isCrown) return null;

  const prior = probabilities(standing.symbol, standing.rank, fieldSize);
  const legs: [number, number, number] = [prior.higher, prior.draw, prior.lower];

  const quoted: [boolean, boolean, boolean] = [true, true, true];
  if (!(legs[0] > 0) || standing.rank <= 1) quoted[0] = false;
  if (!(legs[1] > 0)) quoted[1] = false;
  if (!(legs[2] > 0) || standing.rank >= fieldSize) quoted[2] = false;
  if (!quoted.some(Boolean)) return null;

  const opening: [number, number, number] = [0, 0, 0];
  let elsewhere = 0;
  for (let d = 0; d < 3; d++) {
    if (quoted[d]) opening[d] = Math.max(1, Math.round(OPENING_POOL * legs[d]));
    else elsewhere += Math.min(100, Math.max(0, Math.round(legs[d] * 100)));
  }

  // What the quoted legs divide between them: a hundred, less the share of any
  // leg that is real but has no line.
  const target = Math.min(100, Math.max(FLOOR_CENTS, 100 - elsewhere));
  return { quoted, opening, target };
}

/**
 * Open a round on-chain and put the board on it.
 *
 * One transaction per instruction rather than one for the lot: eleven
 * instructions with eleven account initialisations is comfortably past a legacy
 * transaction's size, and a partially-seeded round is recoverable — the entries
 * are indexed, so a retry fills the gaps — while a transaction too large to send
 * is not recoverable at all.
 */
export async function openChainRound(opts: {
  authority: Keypair;
  startsAt: Date;
  seedHex: string;
  crownSymbol: string | null;
  standings?: Standing[];
}): Promise<ChainRound | null> {
  const conn = connection();
  const program = crownProgram(opts.authority, conn);
  const board = (opts.standings ?? oracle.standings(BOARD_SIZE)).slice(0, BOARD_SIZE);
  if (!board.length) return null;

  const cfgInfo = await conn.getAccountInfo(configPda());
  if (!cfgInfo) throw new Error("the program has no config — run `bun run chain:seed`");
  const index = cfgInfo.data.readBigUInt64LE(8 + 32 + 32);
  const round = roundPda(index);

  const seed = Buffer.from(opts.seedHex, "hex");
  const lockAt = new Date(opts.startsAt.getTime() + ROUND_MINUTES * 60_000 - CUT_WINDOW_SECONDS * 1000);
  const endsAt = new Date(opts.startsAt.getTime() + ROUND_MINUTES * 60_000);

  await program.methods
    .openRound({
      startsAt: new BN(Math.floor(opts.startsAt.getTime() / 1000)),
      lockAt: new BN(Math.floor(lockAt.getTime() / 1000)),
      endsAt: new BN(Math.floor(endsAt.getTime() / 1000)),
      commitHash: Array.from(sha256(seed)),
      cutWindowSeconds: CUT_WINDOW_SECONDS,
      crownSymbol: pad(opts.crownSymbol ?? "", 16),
    })
    .accounts({
      config: configPda(),
      round,
      authority: opts.authority.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .transaction()
    .then((tx) => sendChainTx({ tx, signers: [opts.authority] }));

  rememberSeed(index, opts.seedHex);

  const mint = new PublicKey((await (program.account as any).config.fetch(configPda())).creditMint);
  const authorityTokens = getAssociatedTokenAddressSync(mint, opts.authority.publicKey);

  // Indices are assigned densely over the coins that get an entry, *not* by
  // board position. The crown gets no entry — it has no book, so an account
  // holding an empty one would only be a row every reader has to skip — and
  // numbering by position would therefore leave a hole. A hole is not merely
  // untidy: `entry_count` would no longer describe the index space, so anything
  // reading `0..count-1` would both probe a gap and miss the last real entry.
  // Found exactly that way.
  let slot = 0;
  for (const standing of board) {
    const auction = auctionFor(standing, board.length, standing.symbol === opts.crownSymbol);
    if (!auction) continue;
    const i = slot++;

    await program.methods
      .addEntry({
        index: i,
        symbol: pad(standing.symbol, 16),
        ticker: pad(standing.ticker, 12),
        startRank: standing.rank,
        quoted: auction.quoted,
        opening: auction.opening.map((v) => new BN(v)),
        target: auction.target,
      })
      .accounts({
        config: configPda(),
        round,
        entry: entryPda(round, i),
        authorityTokens,
        vault: vaultPda(),
        authority: opts.authority.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .transaction()
      .then((tx) => sendChainTx({ tx, signers: [opts.authority] }));
  }

  invalidateBoard();
  invalidateRound();
  const info = await conn.getAccountInfo(round);
  return info ? decodeRound(round, info.data as Buffer) : null;
}

/**
 * Freeze the board into the round, then reveal the seed.
 *
 * Both are the authority's to do and neither is verifiable on its own — the
 * ranking comes from off-chain market data and nothing on-chain can check it.
 * What the commitment proves is narrower and worth stating exactly: the house
 * did not choose *when* to look. What it saw is the house's word.
 */
export async function cutAndReveal(opts: {
  authority: Keypair;
  round: ChainRound;
  standings?: Standing[];
}): Promise<"cut" | "settled" | "waiting" | "no-seed"> {
  const program = crownProgram(opts.authority, connection());
  const now = Date.now();
  if (now < opts.round.lockAt.getTime()) return "waiting";

  if (opts.round.status === "Open") {
    const board = opts.standings ?? oracle.standings(BOARD_SIZE);
    const rankOf = new Map(board.map((s) => [s.symbol, s.rank]));
    const entries = await readBoard(opts.round.index, opts.round.entryCount);

    for (const entry of entries) {
      if (entry.cutRank != null) continue;
      await program.methods
        // A coin that has dropped off the board is scored one place below the
        // last visible slot — the same place `market.ts` prices it, so the book
        // and the settlement cannot disagree at the cut.
        .recordCut({ cutRank: rankOf.get(entry.symbol) ?? BOARD_SIZE + 1 })
        .accounts({
          config: configPda(),
          round: opts.round.address,
          entry: entryPda(opts.round.address, entry.index),
          authority: opts.authority.publicKey,
        })
        .transaction()
        .then((tx) => sendChainTx({ tx, signers: [opts.authority] }));
    }
    invalidateBoard();
    invalidateRound();
    return "cut";
  }

  if (opts.round.status === "Cut") {
    const key = opts.round.index.toString();
    const seed = seeds.get(key);
    // Nothing here can recover a lost seed, and guessing would be worse than
    // waiting: an unrevealed round settles nothing, while a wrong seed is simply
    // refused by the commitment.
    if (!seed) return "no-seed";

    // **Checked against the commitment before it is sent.**
    //
    // "No seed" used to be the only recoverable state, so a seed that was
    // present and *wrong* was sticky: it was sent, refused with `BadReveal`, and
    // left in the map to be sent again on the next tick, forever. The round
    // never revealed, every position on it stayed unsettled, and the log
    // repeated one line that read like a chain problem rather than a cache
    // holding the wrong thirty-two bytes.
    //
    // The commitment is right there in the account and the check is one hash, so
    // there is no reason to learn this from the cluster. Forgetting the bad seed
    // turns a permanent failure into "no-seed", which the caller already knows
    // how to repair from the database.
    if (sha256(seed).toString("hex") !== opts.round.commitHash) {
      seeds.delete(key);
      return "no-seed";
    }

    try {
      await program.methods
        .revealSeed(Array.from(seed))
        .accounts({
          config: configPda(),
          round: opts.round.address,
          authority: opts.authority.publicKey,
        })
        .transaction()
        .then((tx) => sendChainTx({ tx, signers: [opts.authority] }));
      invalidateRound();
      return "settled";
    } catch (err) {
      // `CutNotReached` is expected: the cut instant is derived from the seed and
      // lands somewhere inside the window, so the first attempts after the lock
      // are early by design rather than wrong.
      if (String(err).includes("CutNotReached") || String(err).includes("6006")) return "waiting";
      // Belt and braces for anything the local check could not see — a seed that
      // matched the commitment we read but not the one on chain, which is what a
      // stale round account would look like. Same repair: forget it and let the
      // database supply the seed again.
      if (String(err).includes("BadReveal") || String(err).includes("6005")) {
        seeds.delete(key);
        return "no-seed";
      }
      throw err;
    }
  }

  return "waiting";
}

export { decodeRound, auctionFor, CAP_CENTS };
export type { CrownProgram };
