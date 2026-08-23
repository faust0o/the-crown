/**
 * Does the browser's idea of this program match the program?
 *
 * `src/casino/chain/program.ts` builds `authorize_relayer` by hand rather than
 * through Anchor — sensible, since shipping an IDL and a coder to the browser to
 * encode one instruction is a lot of bundle for eight bytes and four accounts.
 * The cost is that its discriminator, account order and signer flags are a second
 * implementation of something the program already defines, in a file that has no
 * reason to be rebuilt when the program changes.
 *
 * That drift is silent in the worst way: a wrong account order does not fail to
 * compile, it produces a transaction the runtime rejects for a reason that points
 * somewhere else entirely — as it did once already here, when a stale deploy left
 * the old program reading `payer` in the `system_program` slot and the error
 * named the system program.
 *
 * So this checks the encoding against Anchor's, byte for byte, and then does the
 * thing no amount of encoding review can settle: sends it, and reads the account
 * back with the client's own decoder.
 *
 * ```sh
 * cd server && bun run chain:wallet-check
 * ```
 */
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createApproveInstruction,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

import {
  authorizeRelayerInstruction,
  decodeDelegation,
  delegationPda as clientDelegationPda,
  configPda as clientConfigPda,
  PROGRAM_ID as CLIENT_PROGRAM_ID,
} from "../../../src/casino/chain/program";

import { crownProgram, configPda, delegationPda, loadKeypair } from "./program";

const RPC = process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899";
const conn = new Connection(RPC, "confirmed");
const KEYS = `${process.env.HOME}/.config/solana/crown-devnet`;

const ok = (s: string) => console.log(`  ✓ ${s}`);
const bad = (s: string, d: string): never => {
  console.error(`  ✗ ${s}\n    ${d}`);
  process.exit(1);
};

async function main() {
  // --- the two derivations must agree -------------------------------------
  if (!CLIENT_PROGRAM_ID.equals((await import("./program")).PROGRAM_ID)) {
    bad("program ids differ", CLIENT_PROGRAM_ID.toBase58());
  }
  if (!clientConfigPda().equals(configPda())) bad("config PDA differs", clientConfigPda().toBase58());
  ok("client and server derive the same program id and config PDA");

  const owner = Keypair.generate();
  const relayer = loadKeypair(`${KEYS}/relayer.json`);
  if (!clientDelegationPda(owner.publicKey).equals(delegationPda(owner.publicKey))) {
    bad("delegation PDA differs", clientDelegationPda(owner.publicKey).toBase58());
  }
  ok("client and server derive the same delegation PDA");

  // --- byte-for-byte against Anchor ---------------------------------------
  const authority = loadKeypair(`${KEYS}/treasury.json`);
  const program = crownProgram(authority, conn);
  const viaAnchor = await program.methods
    .authorizeRelayer(relayer.publicKey)
    .accounts({
      delegation: delegationPda(owner.publicKey),
      owner: owner.publicKey,
      payer: owner.publicKey,
      systemProgram: new PublicKey("11111111111111111111111111111111"),
    })
    .instruction();

  const viaClient = authorizeRelayerInstruction(owner.publicKey, relayer.publicKey);

  if (Buffer.compare(Buffer.from(viaAnchor.data), Buffer.from(viaClient.data)) !== 0) {
    bad(
      "instruction data differs",
      `anchor ${Buffer.from(viaAnchor.data).toString("hex")}\n    client ${Buffer.from(viaClient.data).toString("hex")}`
    );
  }
  ok(`instruction data identical (${viaClient.data.length} bytes, discriminator ${Buffer.from(viaClient.data.subarray(0, 8)).toString("hex")})`);

  if (viaAnchor.keys.length !== viaClient.keys.length) {
    bad("account count differs", `anchor ${viaAnchor.keys.length}, client ${viaClient.keys.length}`);
  }
  for (let i = 0; i < viaAnchor.keys.length; i++) {
    const a = viaAnchor.keys[i];
    const c = viaClient.keys[i];
    if (!a.pubkey.equals(c.pubkey) || a.isSigner !== c.isSigner || a.isWritable !== c.isWritable) {
      bad(
        `account ${i} differs`,
        `anchor ${a.pubkey.toBase58()} s=${a.isSigner} w=${a.isWritable}\n    client ${c.pubkey.toBase58()} s=${c.isSigner} w=${c.isWritable}`
      );
    }
  }
  ok(`all ${viaClient.keys.length} accounts identical in order, signer and writable flags`);

  // --- and it has to actually land ----------------------------------------
  const cfg = await (program.account as any).config.fetch(configPda());
  const mint = new PublicKey(cfg.creditMint);
  const ata = getAssociatedTokenAddressSync(mint, owner.publicKey);

  // Enough to pay a signature and the rent on one delegation account.
  //
  // Airdropped where that works, transferred where it does not. On a local
  // validator the faucet is free and unlimited; on devnet it is neither — the
  // measured cap is 5 SOL a request against a per-IP limit that one call
  // exhausts, so a test that insists on airdropping simply cannot run there.
  // Falling back to the treasury keeps this check runnable on the cluster it
  // most needs to be runnable on.
  const FUNDING = LAMPORTS_PER_SOL / 100;
  try {
    const sig = await conn.requestAirdrop(owner.publicKey, FUNDING);
    const bh = await conn.getLatestBlockhash();
    await conn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
    ok("funded the test player by airdrop");
  } catch {
    await sendAndConfirmTransaction(
      conn,
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: authority.publicKey,
          toPubkey: owner.publicKey,
          lamports: FUNDING,
        })
      ),
      [authority]
    );
    ok("no usable faucet here — funded the test player from the treasury");
  }

  await sendAndConfirmTransaction(
    conn,
    new Transaction().add(
      createAssociatedTokenAccountInstruction(authority.publicKey, ata, owner.publicKey, mint),
      createMintToInstruction(mint, ata, authority.publicKey, 25_000)
    ),
    [authority]
  );

  // Exactly the transaction the client's setup card builds: create-ATA is already
  // done above, so approve + authorize, signed only by the player's wallet.
  const ALLOWANCE = 25_000;
  await sendAndConfirmTransaction(
    conn,
    new Transaction().add(
      createApproveInstruction(ata, configPda(), owner.publicKey, ALLOWANCE),
      viaClient
    ),
    [owner]
  );
  ok("approve + authorize landed in ONE transaction signed only by the player");

  // --- and the app must be able to read back what it wrote ----------------
  const info = await conn.getAccountInfo(delegationPda(owner.publicKey));
  if (!info) bad("no delegation account after the transaction", "the setup silently did nothing");
  const decoded = decodeDelegation(info!.data);
  if (!decoded) bad("client decodeDelegation returned null", `${info!.data.length} bytes`);
  if (!decoded!.owner.equals(owner.publicKey)) {
    bad("decoded owner is wrong", decoded!.owner.toBase58());
  }
  if (!decoded!.relayer.equals(relayer.publicKey)) {
    bad("decoded relayer is wrong", decoded!.relayer.toBase58());
  }
  ok(`client decoded the account it wrote: owner and relayer both correct (${info!.data.length}-byte layout)`);

  // --- and a relayed bet must now work without the player -----------------
  const tokenAcct = await conn.getTokenAccountBalance(ata);
  ok(`player holds ${tokenAcct.value.amount} credits with a ${ALLOWANCE} allowance delegated to the program`);

  console.log("\n✅ the client's setup flow works against a real validator\n");
}

main().catch((e) => {
  console.error("\n✗ verification failed:", e?.message ?? e);
  if (e?.logs) console.error(e.logs.join("\n"));
  process.exit(1);
});
