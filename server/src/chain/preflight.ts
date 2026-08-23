import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { getAccount, getMint } from "@solana/spl-token";

import { CHAIN_MODE } from "../env";
import {
  COMMITMENT,
  PROGRAM_ID,
  RPC_URL,
  configPda,
  connection,
  keypairFrom,
  vaultPda,
} from "./program";

/**
 * Is this deployment actually able to run the chain?
 *
 * Every failure this catches is one that otherwise surfaces as a player pressing
 * a button and nothing happening. A missing key, a relayer with no SOL, an
 * authority that does not own the mint — none of them stop the server booting,
 * and all of them stop the game working, silently, for whoever tries first.
 *
 * Written to be runnable two ways: as `bun run chain:preflight` before flipping
 * `CHAIN_MODE`, and at boot, where it warns rather than exits — because a chain
 * that cannot start is a reason to serve the database game, not a reason to
 * serve nothing.
 */

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  /** Fatal for on-chain play, as opposed to worth knowing. */
  fatal: boolean;
}

/**
 * What the relayer needs in reserve.
 *
 * It pays every fee and opens a rent-exempt account for every position, and the
 * rent comes back only when the position settles — so the floor is set by how
 * much is *outstanding at once*, not by the rate of play. A round of eight desks
 * across ten coins and three legs is about 240 positions at 0.00195 SOL, and a
 * second round can be unsettled while the first is still paying out.
 */
const RELAYER_FLOOR_SOL = Number(process.env.CROWN_RELAYER_FLOOR_SOL ?? 0.5);

/** What the treasury needs to keep opening rounds. */
const AUTHORITY_FLOOR_SOL = Number(process.env.CROWN_AUTHORITY_FLOOR_SOL ?? 0.2);

export async function preflight(): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string, fatal = true) =>
    checks.push({ name, ok, detail, fatal });

  add("CHAIN_MODE", true, CHAIN_MODE, false);

  // The endpoint, named but never printed — it carries the provider key.
  const provider = /helius/i.test(RPC_URL)
    ? "helius"
    : /devnet/i.test(RPC_URL)
      ? "public devnet"
      : /127\.0\.0\.1|localhost/.test(RPC_URL)
        ? "local validator"
        : "custom";
  add("RPC endpoint", true, `${provider} (${COMMITMENT})`, false);

  const conn = connection();

  let slot = 0;
  try {
    slot = await conn.getSlot();
    add("RPC reachable", true, `slot ${slot}`);
  } catch (err) {
    add("RPC reachable", false, err instanceof Error ? err.message : "unreachable");
    return checks; // nothing below can be checked without it
  }

  // The program, and that it is actually a program.
  const programInfo = await conn.getAccountInfo(PROGRAM_ID);
  add(
    "program deployed",
    Boolean(programInfo?.executable),
    programInfo
      ? programInfo.executable
        ? PROGRAM_ID.toBase58()
        : "the account exists but is not executable"
      : `no account at ${PROGRAM_ID.toBase58()}`
  );

  const cfgInfo = await conn.getAccountInfo(configPda());
  if (!cfgInfo) {
    add("program seeded", false, "no config account — run `bun run chain:seed`");
    return checks;
  }
  const cfgAuthority = new PublicKey(cfgInfo.data.subarray(8, 40));
  const mint = new PublicKey(cfgInfo.data.subarray(40, 72));
  const roundCount = cfgInfo.data.readBigUInt64LE(72);
  add("program seeded", true, `${roundCount} rounds opened so far`);

  // Keys. Loaded rather than merely present, because a malformed one fails at
  // the first bet rather than at boot.
  const home = process.env.HOME ?? "~";
  let authority: PublicKey | null = null;
  let relayer: PublicKey | null = null;
  try {
    authority = keypairFrom("CROWN_AUTHORITY_KEY", `${home}/.config/solana/crown-devnet/treasury.json`).publicKey;
    add("authority key", true, authority.toBase58());
  } catch (err) {
    add("authority key", false, err instanceof Error ? err.message : "unreadable");
  }
  try {
    relayer = keypairFrom("CROWN_RELAYER_KEY", `${home}/.config/solana/crown-devnet/relayer.json`).publicKey;
    add("relayer key", true, relayer.toBase58());
  } catch (err) {
    add("relayer key", false, err instanceof Error ? err.message : "unreadable");
  }

  // The authority the program will accept, not merely one we happen to hold.
  // A mismatch here means every round the server tries to open is refused, and
  // the error names an authority rather than an env var.
  if (authority) {
    add(
      "authority matches the program",
      authority.equals(cfgAuthority),
      authority.equals(cfgAuthority)
        ? "the config names this key"
        : `the config names ${cfgAuthority.toBase58()}, this deploy holds ${authority.toBase58()}`
    );
  }

  // And that it can still mint. Credits are minted to players when they connect;
  // an authority that does not hold the mint authority cannot fund anybody.
  try {
    const mintInfo = await getMint(conn, mint);
    const holdsMint = Boolean(authority && mintInfo.mintAuthority?.equals(authority));
    add(
      "authority can mint credits",
      holdsMint,
      holdsMint ? `${mint.toBase58()} (${mintInfo.decimals} decimals)` : "the mint authority is somebody else"
    );
    add(
      "credit mint has no decimals",
      mintInfo.decimals === 0,
      mintInfo.decimals === 0
        ? "whole credits only, as the program's arithmetic assumes"
        : `${mintInfo.decimals} decimals — place_bet refuses fractional stakes`,
      false
    );
  } catch (err) {
    add("credit mint", false, err instanceof Error ? err.message : "unreadable");
  }

  // Balances. These are the ones that fail *later*, mid-round, when the money
  // runs out — which is why they are checked before anybody is playing.
  if (relayer) {
    const sol = (await conn.getBalance(relayer)) / LAMPORTS_PER_SOL;
    add(
      "relayer has SOL",
      sol >= RELAYER_FLOOR_SOL,
      `${sol.toFixed(4)} SOL (floor ${RELAYER_FLOOR_SOL}) — it pays every fee and every position's rent`
    );
  }
  if (authority) {
    const sol = (await conn.getBalance(authority)) / LAMPORTS_PER_SOL;
    add(
      "authority has SOL",
      sol >= AUTHORITY_FLOOR_SOL,
      `${sol.toFixed(4)} SOL (floor ${AUTHORITY_FLOOR_SOL}) — it opens rounds and funds the opening auctions`
    );
  }

  // The vault is what pays winners. An empty one settles every winning position
  // to nothing, which looks exactly like the game cheating.
  try {
    const vault = await getAccount(conn, vaultPda());
    add(
      "vault holds credits",
      vault.amount > 0n,
      `${vault.amount.toString()} credits behind the book`
    );
  } catch (err) {
    add("vault", false, err instanceof Error ? err.message : "no vault account");
  }

  // The client is never given the upstream endpoint — see rpc-proxy.ts. A build
  // that baked one in has published the key to every visitor.
  const clientRpc = process.env.VITE_SOLANA_RPC_URL ?? "";
  add(
    "client RPC is the proxy",
    clientRpc === "" || clientRpc.startsWith("/"),
    clientRpc === ""
      ? "unset — the client will default to a local validator"
      : clientRpc.startsWith("/")
        ? `${clientRpc} — the provider key stays server-side`
        : "VITE_SOLANA_RPC_URL is an absolute URL: any key in it is in the browser bundle",
    clientRpc !== "" && !clientRpc.startsWith("/")
  );

  return checks;
}

/** Run the checks and report. Returns true when on-chain play is safe to enable. */
export async function reportPreflight(log = console.log): Promise<boolean> {
  const checks = await preflight();
  for (const c of checks) {
    const mark = c.ok ? "✓" : c.fatal ? "✗" : "–";
    log(`  ${mark} ${c.name.padEnd(28)} ${c.detail}`);
  }
  return !checks.some((c) => !c.ok && c.fatal);
}
