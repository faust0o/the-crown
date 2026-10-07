import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type Commitment,
} from "@solana/web3.js";
// Not the global: `types` in tsconfig.app.json is ["vite/client"], so there is
// no ambient Node Buffer, and web3.js types the one it wants from this package.
import { Buffer } from "buffer";

/**
 * The client's half of the chain wiring.
 *
 * A deliberate re-statement of `server/src/chain/program.ts` rather than an
 * import of it: that module reads keypairs off disk and drags Anchor in, and
 * neither belongs in a browser bundle. The price is that the seeds are written
 * twice, and a divergence between the two does not fail loudly — it derives a
 * *different, valid* address that simply has no account at it. Every seed below
 * has a counterpart in `crown/programs/crown/src/constants.rs`; changing one
 * means changing all three.
 */

/** `metadata.address` in server/src/chain/idl/crown.json. */
export const PROGRAM_ID = new PublicKey("EyeF41ia1T93ZKtgoSH9xrpawYuyhHjmrLhkWRESFucF");

const utf8 = (s: string) => new TextEncoder().encode(s);

const CONFIG_SEED = utf8("config");
const DELEGATION_SEED = utf8("delegation");

const pda = (seeds: Uint8Array[]) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];

/** Holder of the vault's authority, and the key a player approves as delegate. */
export const configPda = () => pda([CONFIG_SEED]);
export const delegationPda = (owner: PublicKey) => pda([DELEGATION_SEED, owner.toBytes()]);

/**
 * `sha256("global:authorize_relayer")[..8]`, copied out of the IDL.
 *
 * Copied rather than computed so the bundle needs neither Anchor nor a hash
 * implementation to build one instruction. It is a constant of the deployed
 * program: it only changes if the instruction is renamed, which would break the
 * server's calls in the same breath.
 */
const AUTHORIZE_RELAYER = Uint8Array.from([164, 158, 129, 204, 201, 28, 143, 11]);

/**
 * Name the relayer allowed to bet on `owner`'s behalf.
 *
 * Half of the authority the no-popup flow needs; the SPL `approve` alongside it
 * is the other half. This says *who* may spend and is enforced by the program,
 * the allowance says *how much* and is enforced by the token program. An
 * allowance with no named relayer is spendable by any passer-by, so the two
 * only ever ship together — see WalletSetup.
 *
 * The account is `init_if_needed` on the program side, so re-running this
 * re-points the relayer and leaves the allowance and the account's own counters
 * alone.
 *
 * A player is their own payer. The program separates `owner` from `payer` for
 * the server's desks, which hold credits and no SOL and so cannot fund their own
 * delegation account; a wallet that just approved an allowance has SOL by
 * definition. Passing one key for both is not a workaround — the message
 * compiler merges duplicate accounts and takes the union of their flags, so the
 * wallet ends up signing as both, which is exactly what it is.
 */
export function authorizeRelayerInstruction(
  owner: PublicKey,
  relayer: PublicKey
): TransactionInstruction {
  const data = new Uint8Array(8 + 32);
  data.set(AUTHORIZE_RELAYER, 0);
  data.set(relayer.toBytes(), 8);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: delegationPda(owner), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

export interface Delegation {
  owner: PublicKey;
  relayer: PublicKey;
}

/** Discriminator, then `owner`, then `relayer` — the prefix this file reads. */
const DELEGATION_PREFIX = 8 + 32 + 32;

/**
 * Read a `Delegation` without Anchor.
 *
 * Hand-decoded because the alternative is shipping the IDL and a coder to parse
 * two pubkeys at fixed offsets. It stops after the relayer deliberately: the
 * fields past it are the program's own bookkeeping, nothing here displays them,
 * and reading them would couple this file to a layout that is still moving.
 *
 * Returns null for an account too short to be one, rather than throwing — an
 * address that holds something else is a misconfiguration to surface, not a
 * crash.
 */
export function decodeDelegation(data: Uint8Array): Delegation | null {
  if (data.length < DELEGATION_PREFIX) return null;
  return {
    owner: new PublicKey(data.subarray(8, 40)),
    relayer: new PublicKey(data.subarray(40, 72)),
  };
}

/**
 * Vite's build-time environment, or an empty object outside Vite.
 *
 * Vite substitutes `import.meta.env.NAME` for a literal at build time, so the
 * member access has to stay written out — reading `env[name]` dynamically yields
 * undefined in a bundle. Widening `import.meta` here rather than at each use is
 * what lets those literal accesses also compile under the server's `tsc`, which
 * does not have `vite/client` in its `types`.
 */
interface ViteEnv {
  VITE_SOLANA_RPC_URL?: string;
  VITE_SOLANA_CLUSTER?: string;
}
const viteEnv = (): ViteEnv =>
  (import.meta as unknown as { env?: ViteEnv }).env ?? {};

/**
 * Where the chain is.
 *
 * Same default as the server's, and for the same reason: a dev run that lands on
 * devnet by accident opens rent-exempt accounts that then have to be reclaimed a
 * round at a time. Localnet costs nothing and resets.
 *
 * Read through literal member access, never `import.meta.env[name]` — Vite
 * substitutes the former at build time and leaves the latter undefined.
 *
 * Read through `viteEnv()` rather than `import.meta.env` directly, so this module
 * can be imported outside Vite. That is not hypothetical tidiness:
 * `server/src/chain/wallet-check.ts` imports this file under Node to check that
 * the instruction the browser builds by hand is the one the program expects, and
 * under Node `import.meta.env` is absent — a bare member access throws at import
 * time, and the file's types are not in scope for the server's `tsc` either.
 */
const RAW_RPC = viteEnv().VITE_SOLANA_RPC_URL ?? "http://127.0.0.1:8899";

/**
 * Where the chain is, as an absolute URL.
 *
 * A path like `/rpc` is the *preferred* setting in production: it points at this
 * origin's proxy, so a paid endpoint's key stays on the server instead of being
 * substituted into the bundle for anyone to read. But `web3.js` builds a `URL`
 * from whatever it is handed and throws on a relative one, so the origin has to
 * be attached here. Done at module load rather than per call because the origin
 * cannot change under a running page.
 */
export const RPC_URL: string = (() => {
  if (!RAW_RPC.startsWith("/")) return RAW_RPC;
  // Read off `globalThis` rather than `window`: this module is also imported
  // under Node by `server/src/chain/wallet-check.ts`, whose tsconfig has no DOM
  // lib, and there the relative form is simply left alone.
  const origin = (globalThis as { location?: { origin?: string } }).location?.origin;
  return origin ? `${origin}${RAW_RPC}` : RAW_RPC;
})();

/**
 * `confirmed`, matching the server's. A setup transaction is read back the
 * moment it lands — waiting for finality would leave the card claiming the
 * player still has no allowance for a further twelve seconds after they granted
 * one, which reads as the transaction having failed.
 */
export const COMMITMENT: Commitment = "confirmed";

export type Cluster = "mainnet" | "devnet" | "testnet" | "local";

/**
 * Which cluster the RPC URL points at, inferred rather than configured.
 *
 * A separate env var for this would be a second source of truth that can
 * disagree with the first, and the failure it produces — devnet explorer links
 * over mainnet balances — is the kind a player only notices after acting on it.
 */
export const CLUSTER: Cluster = ((): Cluster => {
  // Inference works on a direct endpoint and cannot work on a proxy: `/rpc`
  // says nothing about what is behind it. So the override is not a redundant
  // second source of truth — for the configuration we actually want to run, it
  // is the only source. It is still only consulted when set.
  const declared = viteEnv().VITE_SOLANA_CLUSTER;
  if (declared === "mainnet" || declared === "devnet" || declared === "testnet" || declared === "local") {
    return declared;
  }
  const url = RAW_RPC.toLowerCase();
  if (url.startsWith("/")) return "devnet";
  if (url.includes("devnet")) return "devnet";
  if (url.includes("testnet")) return "testnet";
  if (url.includes("127.0.0.1") || url.includes("localhost")) return "local";
  return "mainnet";
})();

/** Explorer deep link, on the cluster the app is actually talking to. */
export function explorerUrl(address: string): string {
  const base = `https://explorer.solana.com/address/${address}`;
  if (CLUSTER === "mainnet") return base;
  if (CLUSTER === "local") {
    return `${base}?cluster=custom&customUrl=${encodeURIComponent(RPC_URL)}`;
  }
  return `${base}?cluster=${CLUSTER}`;
}

/** `7xKX…p2aB`. Addresses are unreadable in a proportional font, so: font-mono. */
export function shortAddress(address: string, chars = 4): string {
  if (address.length <= chars * 2 + 1) return address;
  return `${address.slice(0, chars)}…${address.slice(-chars)}`;
}
