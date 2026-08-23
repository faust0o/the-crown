import { createHash } from "node:crypto";
import { Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createApproveInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

import { deskIntent, recordChainStake, urgencyOf, type MarketView } from "../bots";
import { fairCents, remainingFraction, type Direction, type RoundBook } from "../market";
import { BOARD_SIZE, oracle, type Standing } from "../oracle/index";
import { DIRECTION_INDEX } from "./direction";
import { CAP_CENTS, creditsToClose, type Book } from "./pricing";
import { closeFor, quoteFor, readBoard, invalidateBoard, type EntryBook } from "./book";
import {
  BN,
  betPda,
  configPda,
  connection,
  crownProgram,
  delegationPda,
  entryPda,
  roundPda,
  vaultPda,
} from "./program";
import { sendChainTx } from "./send";

/**
 * The desks, as ordinary accounts.
 *
 * There is nothing on-chain that knows a desk from a player. A desk is a keypair
 * the server holds, with a token account, an SPL allowance and a `Delegation`
 * naming the relayer — the identical setup a player completes in one wallet
 * prompt. `place_bet` cannot tell them apart and is not meant to: anything a desk
 * could skip would be a thumb on the scale.
 *
 * That also settles the funding question. A desk signs nothing and pays for
 * nothing; the relayer is the fee payer and the rent payer for every fill, desk
 * or player alike. **Desks need no SOL at all** — only credits. The pre-deploy
 * step is a mint, not an airdrop.
 *
 * What is left here is the execution: turning the intent `bots.ts` forms into a
 * transaction, and keeping the desks' accounts in existence.
 */

const tunable = (name: string, fallback: number): number => {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) ? raw : fallback;
};

/**
 * How often *somebody* trades — the tape's cadence, across all desks together.
 *
 * Expressed as an aggregate rather than as a per-desk tick because the aggregate
 * is the number anyone can perceive: a player watching the board sees arrivals,
 * not which desk produced them. Each desk's own interval is this multiplied by
 * how many desks there are (`tickFor`), so adding a desk thickens the book
 * without speeding the tape up.
 *
 * A second is affordable now, and it was not before. While a position was one
 * account *per fill*, this rate set the rent: eight desks at a one-second tick
 * opened fourteen thousand accounts in a half-hour round, ~28 SOL, against seven
 * hundredths of a SOL of fees. Merging buys into a position keyed by its leg
 * (see `Bet` in `state.rs`) bounds the accounts at desks × coins × legs — about
 * 240, under half a SOL — **whatever the tick rate**. What is left scaling with
 * this is fees, at 5000 lamports a fill, which is ~0.01 SOL a round.
 *
 * The remaining ceiling is the RPC, not the money, and it has been measured
 * rather than assumed: the endpoint in use starts refusing around 4 requests a
 * second, and a fill costs three or four between reading, sending and confirming.
 * One arrival every three seconds is what fits, with room left for settlement
 * and the round loop.
 *
 * A second is affordable on a dedicated endpoint and nowhere else. This is the
 * one number to raise after upgrading the plan, and the only honest way to pick
 * it is to re-run the ramp.
 */
const ARRIVAL_MS = tunable("DESK_ARRIVAL_MS", 3_000);

/**
 * One desk's own interval, so that `deskCount` desks produce an arrival every
 * `ARRIVAL_MS` between them.
 *
 * They are staggered by `startDesks`, so the arrivals interleave rather than
 * eight desks waking on the same millisecond — which is a load spike with no
 * purpose, since what a desk pays is set by what it buys and not by the order it
 * arrives in.
 */
export const tickFor = (deskCount: number): number =>
  Math.max(250, ARRIVAL_MS * Math.max(1, deskCount));

/** Credits a desk is capitalised with, once. Its P&L is its balance from then on. */
export const DESK_BANKROLL = tunable("DESK_BANKROLL", 5_000_000);

/**
 * A desk's slippage tolerance, in cents above what it quoted itself.
 *
 * Not `CAP_CENTS`, and the difference matters more here than it does for a
 * player. A desk sizes its clip against a board it read up to a tick ago, and
 * between that read and the transaction landing, seven other desks and any number
 * of players may have moved the same line. Sending with no bound means filling at
 * whatever is there, which is the "buy big, close immediately" hole run
 * backwards. Three cents is wide enough that ordinary drift does not cost the
 * desk its turn and narrow enough that a line someone has just run away with does.
 */
const SLIPPAGE_CENTS = tunable("DESK_SLIPPAGE_CENTS", 3);

export interface Desk {
  id: number;
  name: string;
  keypair: Keypair;
  tokens: PublicKey;
}

/**
 * A desk's identity is a pure function of its id and the seed phrase, so the same
 * desks come back with the same accounts across restarts.
 *
 * Derived rather than stored because a desk's keypair is not a secret worth
 * protecting — it holds play credits and cannot sign anything but a bet, and the
 * relayer has to be able to reconstruct them at boot without a key file per desk.
 * Set `DESK_SECRET` to something unguessable anyway if the desks' balances are
 * ever worth more than the game.
 */
export function deskKeypair(id: number): Keypair {
  const secret = process.env.DESK_SECRET ?? "crown-desks";
  const seed = createHash("sha256").update(`${secret}:${id}`).digest();
  return Keypair.fromSeed(Uint8Array.from(seed));
}


/**
 * The book, as the desks price against it: on-chain.
 *
 * `bots.ts` forms the intent and does not care where the numbers came from; this
 * is the production half of that seam, and the in-memory one it replaces is kept
 * only so a test can run a round's accumulation without a validator.
 */
export function chainMarket(entries: EntryBook[]): MarketView {
  const bySymbol = new Map(entries.map((e) => [e.symbol, e]));
  return {
    quote: (symbol, direction) => {
      const entry = bySymbol.get(symbol);
      return entry ? quoteFor(entry, DIRECTION_INDEX[direction]) : null;
    },
    creditsToClose: (symbol, direction, fair, fraction) => {
      const entry = bySymbol.get(symbol);
      if (!entry) return 0;
      return creditsToClose(entry.book, DIRECTION_INDEX[direction], fair, fraction);
    },
  };
}

/**
 * Open a desk's accounts if they are not already there.
 *
 * Idempotent, and deliberately **not** an upsert on the balance. A desk's credits
 * are its P&L; topping it back up on every restart would quietly refill a desk
 * that had traded itself broke, and losing money is the thing that makes a desk's
 * opinions cost it something.
 */
export async function openDeskAccount(
  desk: Desk,
  opts: { authority: Keypair; relayer: PublicKey; mint: PublicKey; bankroll?: number }
): Promise<void> {
  const conn = connection();
  const { authority, relayer, mint } = opts;

  let existing: Awaited<ReturnType<typeof getAccount>> | null = null;
  try {
    existing = await getAccount(conn, desk.tokens);
  } catch {
    existing = null;
  }

  const ixs = [
    createAssociatedTokenAccountIdempotentInstruction(
      authority.publicKey,
      desk.tokens,
      desk.keypair.publicKey,
      mint
    ),
  ];

  // Capitalise once. A desk that already holds an account keeps whatever trading
  // has left it with.
  if (!existing) {
    ixs.push(
      createMintToInstruction(
        mint,
        desk.tokens,
        authority.publicKey,
        BigInt(Math.floor(opts.bankroll ?? DESK_BANKROLL))
      )
    );
  }

  // The same two halves a player's wallet signs in one prompt: the SPL allowance,
  // and the relayer permitted to spend it. The desk signs this itself because the
  // server holds its key — which is the only place a desk differs from a player,
  // and it is a difference in who holds the key rather than in what the chain
  // requires.
  const config = configPda();
  ixs.push(
    createApproveInstruction(
      desk.tokens,
      config,
      desk.keypair.publicKey,
      BigInt(Number.MAX_SAFE_INTEGER)
    )
  );

  const program = crownProgram(authority, conn);
  ixs.push(
    await program.methods
      .authorizeRelayer(relayer)
      .accounts({
        delegation: delegationPda(desk.keypair.publicKey),
        owner: desk.keypair.publicKey,
        payer: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .instruction()
  );

  await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [
    authority,
    desk.keypair,
  ]);
}

/** Build the desks' identities. Accounts are opened separately, by the seeder. */
export function makeDesks(names: string[], mint: PublicKey): Desk[] {
  return names.map((name, id) => {
    const keypair = deskKeypair(id);
    return {
      id,
      name,
      keypair,
      tokens: getAssociatedTokenAddressSync(mint, keypair.publicKey),
    };
  });
}

export interface ArrivalContext {
  desk: Desk;
  relayer: Keypair;
  round: RoundBook & { index: bigint; entryCount: number };
  standings: Standing[];
  /** The desk's credit balance, so sizing does not need a read per arrival. */
  credits: number;
}

/**
 * One desk's arrival: it prices the board, forms an intent, and buys — for real.
 *
 * Returns the fill, or null when the desk decided not to trade. **A refusal is
 * not an error here.** A desk that cannot afford a clip, or finds the line
 * already at its number, or arrives a moment after the lock, simply does not
 * place one, and that has to be an ordinary Tuesday rather than something that
 * throws inside a timer.
 */
export async function deskArrival(ctx: ArrivalContext): Promise<{
  symbol: string;
  ticker: string;
  direction: Direction;
  stake: number;
  cents: number;
} | null> {
  const { desk, relayer, round, standings } = ctx;
  const board = standings.slice(0, BOARD_SIZE);
  if (!board.length) return null;

  const entries = await readBoard(round.index, round.entryCount);
  if (!entries.length) return null;

  // Driven off the round's entries rather than the live board: a coin that has
  // dropped out still has positions on it and its lines still have to be priced.
  const entry = entries[Math.floor(Math.random() * entries.length)];
  const standing = board.find((s) => s.symbol === entry.symbol) ?? delisted(entry);

  const at = Date.now();
  const intent = deskIntent({
    deskId: desk.id,
    entry: { symbol: entry.symbol, ticker: entry.ticker, startRank: entry.startRank },
    standing,
    board,
    remaining: remainingFraction(round, at),
    urgency: urgencyOf(round, at),
    windowMs: (round.lockAt ?? round.endsAt).getTime() - round.startsAt.getTime(),
    credits: ctx.credits,
    now: at,
    market: chainMarket(entries),
  });
  if (!intent) return null;

  const d = DIRECTION_INDEX[intent.direction];
  const quoted = quoteFor(entry, d);
  if (!quoted) return null;

  const conn = connection();
  const program = crownProgram(relayer, conn);
  const roundKey = roundPda(round.index);

  const tx = await program.methods
    .placeBet({
      direction: d,
      stake: new BN(intent.stake),
      maxCents: Math.min(CAP_CENTS, quoted.ask + SLIPPAGE_CENTS),
    })
    .accounts({
      config: configPda(),
      round: roundKey,
      entry: entryPda(roundKey, entry.index),
      delegation: delegationPda(desk.keypair.publicKey),
      bet: betPda(roundKey, desk.keypair.publicKey, entry.index, d),
      bettor: desk.keypair.publicKey,
      bettorTokens: desk.tokens,
      vault: vaultPda(),
      relayer: relayer.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .transaction();
  await sendChainTx({ tx, signers: [relayer] });

  // The board just moved, and the desk that moved it must not re-price against
  // the version it read a moment ago.
  invalidateBoard();

  // And the desk's own position limit has to know what the desk just did. This
  // is the only write to `books` on the chain path; without it `deskIntent`
  // sizes every subsequent clip against a position it cannot see, and
  // `MAX_ASSET_EXPOSURE` — the one per-coin cap in the system, since the program
  // enforces none — never binds for the desk it is supposed to bind for.
  recordChainStake({
    roundId: round.id,
    deskId: desk.id,
    symbol: entry.symbol,
    direction: intent.direction,
    stake: intent.stake,
  });

  return {
    symbol: entry.symbol,
    ticker: entry.ticker,
    direction: intent.direction,
    stake: intent.stake,
    cents: quoted.ask,
  };
}

/**
 * Where a coin that has fallen out of the board stands.
 *
 * `record_cut` scores it one place below the last visible slot, so the book has
 * to price it there or the market and the settlement would disagree at the cut.
 */
function delisted(entry: EntryBook): Standing {
  const meta = oracle.metaFor(entry.symbol);
  return {
    symbol: entry.symbol,
    ticker: entry.ticker,
    name: meta?.name ?? entry.ticker,
    imageUrl: meta?.imageUrl ?? null,
    rank: BOARD_SIZE + 1,
    previousRank: null,
    quoteVolume: 0,
    price: 0,
    trades1h: 0,
    wallets1h: 0,
    priceChange1hPercent: 0,
  };
}

export { fairCents, closeFor, type Book, type EntryBook };
