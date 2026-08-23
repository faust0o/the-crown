/**
 * Buying credits with SOL, end to end.
 *
 * The wallet is a payment method now: no delegation, no allowance, nothing to
 * approve. This walks the whole of what a player does — pay, then be credited —
 * and checks the two properties that matter: the credits match what the chain
 * says was paid, and a replayed signature credits nothing.
 *
 * ```sh
 * cd server && bun run chain:topup-check
 * ```
 */
import { Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction } from "@solana/web3.js";

import { PrismaClient } from "../generated/prisma";
import { COMMITMENT, connection, keypairFrom } from "./program";
import { confirmCreditPurchase, prepareCreditPurchase, solPriceUsd } from "./purchase";
import { sendChainTx } from "./send";

const conn = connection();
const prisma = new PrismaClient();
const ok = (s: string) => console.log(`  ✓ ${s}`);
const bad = (s: string, d = ""): never => {
  console.error(`  ✗ ${s}${d ? `\n    ${d}` : ""}`);
  process.exit(1);
};

async function main() {
  console.log(`  SOL price: $${(await solPriceUsd()).toFixed(2)}`);

  const buyer = Keypair.generate();
  const user = await prisma.user.create({
    data: { handle: `top-${Date.now() % 1e6}`, credits: 0 },
  });
  ok("new account: 0 credits, a wallet with 0 SOL");

  // Fund the buyer, since devnet's faucet refuses us.
  const treasury = keypairFrom("CROWN_AUTHORITY_KEY", `${process.env.HOME}/.config/solana/crown-devnet/treasury.json`);
  await sendChainTx({
    tx: new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: treasury.publicKey,
        toPubkey: buyer.publicKey,
        lamports: 0.4 * LAMPORTS_PER_SOL,
      })
    ),
    signers: [treasury],
  });
  ok("buyer funded with 0.4 SOL");

  // 1. Quote and build the transfer.
  const lamports = BigInt(Math.floor(0.25 * LAMPORTS_PER_SOL));
  const prepared = await prepareCreditPurchase({ owner: buyer.publicKey.toBase58(), lamports });
  ok(`quote: 0.25 SOL -> ${prepared.credits} credits @ $${prepared.solPriceUsd.toFixed(2)}/SOL`);

  // 2. The buyer signs and sends it, paying their own fee.
  const tx = Transaction.from(Buffer.from(prepared.transaction, "base64"));
  tx.partialSign(buyer);
  const signature = await conn.sendRawTransaction(tx.serialize(), { preflightCommitment: COMMITMENT });
  await conn.confirmTransaction(
    { signature, blockhash: prepared.blockhash, lastValidBlockHeight: prepared.lastValidBlockHeight },
    COMMITMENT
  );
  ok("the transfer landed, signed only by the buyer");

  // 3. The server reads it back and credits the account.
  const credited = await confirmCreditPurchase({ prisma, userId: user.id, signature });
  if (credited.credits !== prepared.credits) {
    bad(`credited ${credited.credits}, quoted ${prepared.credits}`);
  }
  ok(`credited ${credited.credits}, balance now ${credited.balance}`);

  const row = await prisma.user.findUnique({ where: { id: user.id }, select: { credits: true } });
  if (row?.credits !== prepared.credits) bad(`the account holds ${row?.credits}`);
  ok("the balance is on the account, where bets are paid from");

  // 4. Replaying the signature must credit nothing.
  const replay = await confirmCreditPurchase({ prisma, userId: user.id, signature });
  if (replay.credits !== 0) bad(`a replayed signature credited ${replay.credits} more`);
  const after = await prisma.user.findUnique({ where: { id: user.id }, select: { credits: true } });
  if (after?.credits !== prepared.credits) bad("the balance moved on a replay");
  ok("a replayed signature credits nothing");

  // 5. And somebody else's signature is not a top-up for them either.
  const other = await prisma.user.create({ data: { handle: `oth-${Date.now() % 1e6}`, credits: 0 } });
  const stolen = await confirmCreditPurchase({ prisma, userId: other.id, signature });
  if (stolen.credits !== 0) bad(`another account claimed ${stolen.credits} from the same payment`);
  ok("another account cannot claim the same payment");

  await prisma.user.deleteMany({ where: { id: { in: [user.id, other.id] } } }).catch(() => {});
  console.log("\n✅ a wallet buys credits, once, and the balance lives on the account");
}

main()
  .catch((err) => {
    console.error("\n✗ top-up check failed:", err?.message ?? err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
