import { LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";

import type { PrismaClient } from "../generated/prisma";
import { COMMITMENT, connection, keypairFrom } from "./program";

/**
 * Buying credits with SOL.
 *
 * ## The wallet is a payment method and nothing else
 *
 * It used to be an identity: the player approved an allowance, named a relayer,
 * and every bet was signed for them against a delegation account. That bought a
 * genuine property — bets settled on chain, verifiably — and it cost a great
 * deal to have. A player could not place a bet until they had connected a
 * wallet, approved a cap and understood what a relayer was, and every one of
 * those steps was a place to get stuck. The card explaining it was longer than
 * the game's rules.
 *
 * Now the wallet does one thing, at the one moment a wallet is unavoidable:
 * paying. SOL goes to the house, credits arrive in the account, and everything
 * after that — betting, closing, settling — happens on the balance the account
 * already had. There is no delegation, no allowance, and nothing to revoke.
 *
 * The desks still trade on chain. That is where the book and its settlement
 * live, and none of it depended on the player holding a delegation.
 *
 * ## Why this is a purchase and not a mint button
 *
 * The client cannot say what it paid. It presents a *signature*, and the server
 * reads that transaction off the chain: who paid, who received, how much. The
 * signature is stored unique, so presenting it twice credits once.
 */

/** How long a fetched SOL price is good for. */
const PRICE_TTL_MS = Number(process.env.CROWN_SOL_PRICE_TTL_MS ?? 60_000);

/** Smallest purchase worth making, in credits — a credit is a dollar. */
const MIN_CREDITS = Number(process.env.CROWN_MIN_PURCHASE_CREDITS ?? 1);

/** Largest, so a fat-fingered amount cannot empty a wallet in one prompt. */
const MAX_CREDITS = Number(process.env.CROWN_MAX_PURCHASE_CREDITS ?? 100_000);

let priceCache: { at: number; usd: number } | null = null;

/**
 * What one SOL is worth, in dollars.
 *
 * From the same upstream the board's oracle uses, so the game has one opinion
 * about what things cost. Throws rather than falling back to a constant: a stale
 * hardcoded price keeps selling credits at last month's rate, which loses money
 * quietly, where refusing costs a retry and is obvious.
 */
export async function solPriceUsd(): Promise<number> {
  if (priceCache && Date.now() - priceCache.at < PRICE_TTL_MS) return priceCache.usd;

  const key = process.env.TOKENS_XYZ_SECRET;
  if (!key) throw new Error("No price feed is configured.");

  const res = await fetch(
    "https://api.tokens.xyz/v1/assets/So11111111111111111111111111111111111111112",
    { headers: { "x-api-key": key }, signal: AbortSignal.timeout(8_000) }
  );
  if (!res.ok) throw new Error("The price feed is unavailable.");

  const body = (await res.json()) as { asset?: { stats?: { price?: number } } };
  const usd = body.asset?.stats?.price;
  if (!usd || !Number.isFinite(usd) || usd <= 0) throw new Error("The price feed returned no price.");

  priceCache = { at: Date.now(), usd };
  return usd;
}

/** Credits for lamports, at the current rate. Floored — the unit is whole. */
export async function quoteCredits(lamports: bigint): Promise<{ credits: number; solPriceUsd: number }> {
  const usd = await solPriceUsd();
  return { credits: Math.floor((Number(lamports) / LAMPORTS_PER_SOL) * usd), solPriceUsd: usd };
}

/** Where the SOL goes. Also the mint authority, but that is not used here. */
function treasury(): PublicKey {
  const home = process.env.HOME ?? "~";
  return keypairFrom("CROWN_AUTHORITY_KEY", `${home}/.config/solana/crown-devnet/treasury.json`).publicKey;
}

export interface PreparedPurchase {
  /** Base64 of an unsigned transfer, for the wallet to sign and send. */
  transaction: string;
  blockhash: string;
  lastValidBlockHeight: number;
  lamports: string;
  credits: number;
  solPriceUsd: number;
}

/**
 * The transfer a player signs to buy credits.
 *
 * One instruction: their SOL to the house. Unsigned by us, because there is
 * nothing here for the house to authorise — the player is spending their own
 * money and paying their own fee, which is the one transaction in this game
 * where that is the natural arrangement.
 */
export async function prepareCreditPurchase(opts: {
  owner: string;
  lamports: bigint;
}): Promise<PreparedPurchase> {
  let owner: PublicKey;
  try {
    owner = new PublicKey(opts.owner);
  } catch {
    throw new Error("That is not a valid wallet address.");
  }

  const quote = await quoteCredits(opts.lamports);
  if (quote.credits < MIN_CREDITS) throw new Error(`That is less than the ${MIN_CREDITS} credit minimum.`);
  if (quote.credits > MAX_CREDITS) {
    throw new Error(`That is more than the ${MAX_CREDITS.toLocaleString()} credit maximum.`);
  }

  const conn = connection();
  const balance = await conn.getBalance(owner);
  if (BigInt(balance) < opts.lamports) {
    throw new Error(`Not enough SOL — that wallet holds ${(balance / LAMPORTS_PER_SOL).toFixed(4)}.`);
  }

  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: owner, toPubkey: treasury(), lamports: opts.lamports })
  );
  const latest = await conn.getLatestBlockhash(COMMITMENT);
  tx.feePayer = owner;
  tx.recentBlockhash = latest.blockhash;

  return {
    transaction: tx.serialize({ requireAllSignatures: false }).toString("base64"),
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
    lamports: opts.lamports.toString(),
    credits: quote.credits,
    solPriceUsd: quote.solPriceUsd,
  };
}

export interface CreditedPurchase {
  credits: number;
  /** The account's balance afterwards. */
  balance: number;
}

/**
 * Credit an account for a transfer that has already landed.
 *
 * Everything here is read from the chain rather than taken from the caller. The
 * caller supplies a signature; the transaction says who paid, who was paid, and
 * how much, and those are the only facts used. A client that lies about the
 * amount is describing a transaction that does not exist.
 *
 * Re-presenting a signature credits nothing: it is stored unique, and the insert
 * is what claims it. Checking first and inserting after would let two concurrent
 * confirmations of one payment both pass the check.
 */
export async function confirmCreditPurchase(opts: {
  prisma: PrismaClient;
  userId: string;
  signature: string;
}): Promise<CreditedPurchase> {
  const conn = connection();

  const parsed = await conn.getParsedTransaction(opts.signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (!parsed) throw new Error("That payment has not landed yet. Try again in a moment.");
  if (parsed.meta?.err) throw new Error("That payment failed on chain.");

  // What the treasury actually gained, from the balance deltas — not from the
  // instruction list, which a crafted transaction could pad with transfers that
  // net to nothing.
  const house = treasury().toBase58();
  const keys = parsed.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
  const index = keys.indexOf(house);
  if (index < 0) throw new Error("That payment was not made to this game.");

  const before = parsed.meta?.preBalances?.[index] ?? 0;
  const after = parsed.meta?.postBalances?.[index] ?? 0;
  const lamports = BigInt(after - before);
  if (lamports <= 0n) throw new Error("That payment did not move any SOL to this game.");

  const quote = await quoteCredits(lamports);
  if (quote.credits < MIN_CREDITS) throw new Error("That payment is below the minimum.");

  // The unique signature is what makes this idempotent; the insert is the claim.
  try {
    await opts.prisma.creditPurchase.create({
      data: {
        userId: opts.userId,
        signature: opts.signature,
        lamports,
        credits: quote.credits,
        solPriceUsd: quote.solPriceUsd,
      },
    });
  } catch {
    const already = await opts.prisma.creditPurchase.findUnique({
      where: { signature: opts.signature },
      select: { userId: true },
    });
    if (already) {
      const user = await opts.prisma.user.findUnique({
        where: { id: opts.userId },
        select: { credits: true },
      });
      // Already credited — to this account or, if somebody is presenting a
      // stranger's signature, to theirs. Either way nothing more is owed.
      return { credits: 0, balance: user?.credits ?? 0 };
    }
    throw new Error("Could not record that payment.");
  }

  const user = await opts.prisma.user.update({
    where: { id: opts.userId },
    data: { credits: { increment: quote.credits } },
    select: { credits: true },
  });

  return { credits: quote.credits, balance: user.credits };
}
