/**
 * The pre-deploy step: stand up the chain side of the game.
 *
 * Creates the credit mint if there is not one, initialises the config and vault,
 * opens an account for every desk, funds the vault's buffer, and mints invite
 * codes. Idempotent throughout — running it twice is how you top up after
 * changing the desk roster, not a way to reset the game.
 *
 * ```sh
 * cd server && bun run chain:seed
 * ```
 *
 * ## What it deliberately does not do
 *
 * **It does not airdrop SOL to the desks.** They do not need any. A desk signs
 * its own setup once and never again — the relayer is the fee payer and the rent
 * payer for every fill, desk or player alike, so the only account that needs SOL
 * is the relayer. Sending SOL to eight desk addresses would strand it there.
 *
 * **It cannot fund the relayer.** faucet.solana.com is a browser flow behind a
 * GitHub login, so this prints what the relayer needs and where, and stops if it
 * is short. Guessing that a run will fit inside whatever is left is how a round
 * dies half-seeded.
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMintInstruction,
  createMintToInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMinimumBalanceForRentExemptMint,
} from "@solana/spl-token";

import { DESK_NAMES } from "../bots";
import { seedInviteCodes } from "../invites";
import { LOG_INVITE_CODES } from "../env";
import { configPda, connection, crownProgram, loadKeypair, vaultPda } from "./program";
import { DESK_BANKROLL, makeDesks, openDeskAccount } from "./desks";

/** Credits are whole units; decimals would invent half a credit. */
const DECIMALS = 0;

/**
 * What the house puts behind the book beyond the opening auctions.
 *
 * The book is not self-funding and no deposit makes it so: buying `S` into a leg
 * holding `a` of a pool `P` earns `S + (P-a)·ln((a+S)/a)` shares against a pool
 * that only grew to `P+S`, so an informed trader who buys a cheap leg that lands
 * is paid out of the house's capital. This is that capital. Too small and a
 * winning round hits `VaultUnderfunded` and stops paying anybody, which is the
 * correct behaviour and a bad evening.
 */
const VAULT_BUFFER = Number(process.env.CROWN_VAULT_BUFFER ?? 500_000_000);

/**
 * SOL the relayer needs on hand before a run is worth starting.
 *
 * Rent dominates: every lot opens a `Bet` account at ~0.0019 SOL and the relayer
 * pays it. Eight desks on a thirty-second tick put ~480 lots through a half-hour
 * round, so a round costs a little under a SOL and refunds it as the lots settle.
 * One round of headroom is the floor worth insisting on.
 */
const RELAYER_MIN_SOL = Number(process.env.CROWN_RELAYER_MIN_SOL ?? 1);

const KEYS = process.env.CROWN_KEY_DIR ?? `${process.env.HOME}/.config/solana/crown-devnet`;

const say = (s: string) => console.log(s);
const step = (s: string) => console.log(`\n▸ ${s}`);

const repoRoot = () => fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, "");

/**
 * Merge keys into a dotenv file, leaving anything else in it alone.
 *
 * Merged rather than overwritten because these files are where a developer also
 * keeps `DATABASE_URL` and whatever else they are experimenting with, and a
 * seeder that silently truncated them would be a nasty surprise the second time
 * it ran.
 */
async function writeEnv(path: string, vars: Record<string, string>): Promise<void> {
  let existing = "";
  try {
    existing = await readFile(path, "utf8");
  } catch {
    existing = "";
  }

  const lines = existing ? existing.split("\n") : [];
  for (const [key, value] of Object.entries(vars)) {
    const at = lines.findIndex((l) => l.startsWith(`${key}=`));
    if (at >= 0) lines[at] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  }
  const out = lines.filter((l, i) => l.trim() !== "" || i < lines.length - 1).join("\n");
  await writeFile(path, out.endsWith("\n") ? out : `${out}\n`, "utf8");
}

async function main() {
  const conn = connection();
  const authority = loadKeypair(process.env.CROWN_AUTHORITY ?? `${KEYS}/treasury.json`);
  const relayer = loadKeypair(process.env.CROWN_RELAYER ?? `${KEYS}/relayer.json`);

  say(`cluster    ${conn.rpcEndpoint}`);
  say(`authority  ${authority.publicKey.toBase58()}`);
  say(`relayer    ${relayer.publicKey.toBase58()}`);

  // --- can this run even start? -------------------------------------------
  step("checking funding");
  const relayerSol = (await conn.getBalance(relayer.publicKey)) / LAMPORTS_PER_SOL;
  const authoritySol = (await conn.getBalance(authority.publicKey)) / LAMPORTS_PER_SOL;
  say(`  authority ${authoritySol.toFixed(4)} SOL`);
  say(`  relayer   ${relayerSol.toFixed(4)} SOL`);

  if (relayerSol < RELAYER_MIN_SOL) {
    console.error(
      `\n✗ the relayer holds ${relayerSol.toFixed(4)} SOL and needs at least ${RELAYER_MIN_SOL}.\n` +
        `  It pays the rent on every lot (~0.0019 SOL each), which is what actually\n` +
        `  bounds how long a round can run.\n\n` +
        `  Top it up at https://faucet.solana.com — it is a browser flow behind a\n` +
        `  GitHub login, so this script cannot do it for you:\n\n` +
        `      ${relayer.publicKey.toBase58()}\n`
    );
    process.exit(1);
  }

  const program = crownProgram(authority, conn);
  const config = configPda();
  const vault = vaultPda();

  // --- the mint, the config, the vault ------------------------------------
  step("config and credit mint");
  let mint: PublicKey;
  const existing = await conn.getAccountInfo(config);

  if (existing) {
    const cfg = await (program.account as any).config.fetch(config);
    mint = new PublicKey(cfg.creditMint);
    say(`  config already stood up, reusing mint ${mint.toBase58()}`);
    if (!new PublicKey(cfg.authority).equals(authority.publicKey)) {
      console.error(
        `\n✗ the config's authority is ${new PublicKey(cfg.authority).toBase58()},\n` +
          `  not the key this run holds. Nothing here can open rounds.\n`
      );
      process.exit(1);
    }
  } else {
    const mintKp = Keypair.generate();
    mint = mintKp.publicKey;
    const lamports = await getMinimumBalanceForRentExemptMint(conn);
    await sendAndConfirmTransaction(
      conn,
      new Transaction().add(
        SystemProgram.createAccount({
          fromPubkey: authority.publicKey,
          newAccountPubkey: mint,
          space: MINT_SIZE,
          lamports,
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMintInstruction(mint, DECIMALS, authority.publicKey, null)
      ),
      [authority, mintKp]
    );
    say(`  minted ${mint.toBase58()}`);

    await program.methods
      .initialize()
      .accounts({
        config,
        creditMint: mint,
        vault,
        authority: authority.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    say(`  config ${config.toBase58()}`);
    say(`  vault  ${vault.toBase58()}`);
  }

  // --- the house's own credits, which opening auctions are deposited from --
  step("house float");
  const houseAta = getAssociatedTokenAddressSync(mint, authority.publicKey);
  await sendAndConfirmTransaction(
    conn,
    new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        authority.publicKey,
        houseAta,
        authority.publicKey,
        mint
      )
    ),
    [authority]
  );
  const house = await getAccount(conn, houseAta);
  const FLOAT = BigInt(VAULT_BUFFER) * 2n;
  if (house.amount < FLOAT) {
    const top = FLOAT - house.amount;
    await sendAndConfirmTransaction(
      conn,
      new Transaction().add(
        createMintToInstruction(mint, houseAta, authority.publicKey, top)
      ),
      [authority]
    );
    say(`  minted ${top} credits to the house`);
  }
  say(`  house holds ${(await getAccount(conn, houseAta)).amount} credits`);

  // --- the vault's buffer --------------------------------------------------
  step("vault buffer");
  const vaultBefore = await getAccount(conn, vault);
  if (vaultBefore.amount < BigInt(VAULT_BUFFER)) {
    const top = BigInt(VAULT_BUFFER) - vaultBefore.amount;
    // No instruction needed: the vault is an ordinary token account, so the house
    // transfers in with the SPL program like anyone else.
    await sendAndConfirmTransaction(
      conn,
      new Transaction().add(createMintToInstruction(mint, vault, authority.publicKey, top)),
      [authority]
    );
    say(`  topped up by ${top}`);
  }
  say(`  vault holds ${(await getAccount(conn, vault)).amount} credits`);

  // --- the desks -----------------------------------------------------------
  step(`desks (${DESK_NAMES.length})`);
  const desks = makeDesks(DESK_NAMES, mint);
  for (const desk of desks) {
    let held = 0n;
    try {
      held = (await getAccount(conn, desk.tokens)).amount;
      say(`  ${desk.name.padEnd(24)} ${desk.tokens.toBase58().slice(0, 8)}… holds ${held} (kept)`);
      continue;
    } catch {
      // No account yet — open and capitalise it.
    }
    await openDeskAccount(desk, {
      authority,
      relayer: relayer.publicKey,
      mint,
      bankroll: DESK_BANKROLL,
    });
    held = (await getAccount(conn, desk.tokens)).amount;
    say(`  ${desk.name.padEnd(24)} ${desk.tokens.toBase58().slice(0, 8)}… opened with ${held}`);
  }
  say(`  desks hold no SOL and need none — the relayer pays every fee and every rent`);

  // --- invite codes --------------------------------------------------------
  step("invite codes");
  try {
    const codes = await seedInviteCodes();
    say(`  ${codes.length} usable`);
    if (LOG_INVITE_CODES) for (const c of codes) say(`    ${c}`);
    else say(`  (set LOG_INVITE_CODES=true to print them, or use \`bun run invites:mint\`)`);
  } catch (err) {
    say(`  skipped — no database reachable (${(err as Error).message.split("\n")[0]})`);
  }

  // --- what the app needs to know -----------------------------------------
  //
  // Written, not printed. The mint is created fresh whenever the validator is
  // reset, so a hand-copied address is stale the first time anyone runs
  // `solana-test-validator --reset` — and the symptom is not an error but the
  // client quietly deciding on-chain betting is off, which reads like a bug in
  // the app rather than a stale constant.
  step("environment");

  // **The client is never given the upstream endpoint.**
  //
  // A paid RPC carries its key in the URL, and `VITE_*` is substituted into the
  // bundle at build time — so writing `conn.rpcEndpoint` here would publish the
  // key to every visitor the moment anyone pointed this at Helius. Writing the
  // proxy path unconditionally means that mistake cannot be made by editing an
  // env var, which is the only way it would ever be made.
  //
  // The cluster has to be stated rather than inferred, because `/rpc` says
  // nothing about what is behind it.
  const cluster = /devnet/.test(conn.rpcEndpoint)
    ? "devnet"
    : /testnet/.test(conn.rpcEndpoint)
      ? "testnet"
      : /127\.0\.0\.1|localhost/.test(conn.rpcEndpoint)
        ? "local"
        : "mainnet";

  await writeEnv(`${repoRoot()}/.env`, {
    VITE_SOLANA_RPC_URL: "/rpc",
    VITE_SOLANA_CLUSTER: cluster,
    VITE_CROWN_CREDIT_MINT: mint.toBase58(),
    VITE_CROWN_RELAYER: relayer.publicKey.toBase58(),
  });
  await writeEnv(`${repoRoot()}/server/.env`, {
    SOLANA_RPC_URL: conn.rpcEndpoint,
    CROWN_CREDIT_MINT: mint.toBase58(),
  });
  say(`  wrote .env and server/.env`);
  say(`  client -> /rpc (${cluster}); the endpoint and any key stay server-side`);
  say(`  restart Vite to pick them up — they are read at build time, not per request`);

  say(`\n✅ seeded\n`);
}

main().catch((e) => {
  console.error("\n✗ seed failed:", e?.message ?? e);
  if (e?.logs) console.error(e.logs.join("\n"));
  process.exit(1);
});
