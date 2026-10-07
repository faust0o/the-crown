import { randomBytes } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";

/**
 * Sign-in with a Solana wallet.
 *
 * A wallet address is public, so "who are you" cannot be answered by naming one
 * — anyone can name anyone. What proves ownership is a signature by the key
 * behind it, over something the server chose. Hence two steps: `issueChallenge`
 * hands out a nonce, and `verifyChallenge` checks the signature over the message
 * that nonce belongs to.
 *
 * Nothing here signs a transaction. The message is plain text and the wallet
 * shows it verbatim, so the worst a player can approve is a sentence.
 */

/** How long a challenge stays signable. Long enough to read the prompt. */
const CHALLENGE_TTL_MS = 5 * 60_000;

interface Challenge {
  address: string;
  expiresAt: number;
}

/**
 * Live challenges, in memory rather than in Postgres.
 *
 * They are single-use and live five minutes, which is the whole of their value:
 * a table of them would be a table that is empty in every backup worth taking.
 * The cost is that a restart mid-login invalidates a nonce the player is looking
 * at — one retry, on a flow that already involves a wallet prompt.
 */
const challenges = new Map<string, Challenge>();

/** Drop everything expired. Called on issue, so the map cannot grow unbounded. */
function sweep(now: number): void {
  for (const [nonce, c] of challenges) if (c.expiresAt <= now) challenges.delete(nonce);
}

/**
 * The exact text the wallet will display and sign.
 *
 * Derived server-side from the nonce on both legs — issued here, and rebuilt
 * here at verification — so the client never gets to say what was signed. A
 * flow that verified a caller-supplied message would verify a signature over
 * "hello" just as happily as over a sign-in.
 */
export function challengeMessage(address: string, nonce: string): string {
  return [
    "The Crown",
    "",
    "Sign in with this wallet. This does not trigger a transaction and costs no fees.",
    "",
    `Wallet: ${address}`,
    `Nonce: ${nonce}`,
  ].join("\n");
}

/** Reject anything that is not a Solana address before it reaches a lookup. */
export function normaliseAddress(address: string): string {
  const trimmed = address.trim();
  // A base58 pubkey is 32-44 characters; the constructor is the real check, but
  // it will happily parse a megabyte of it first.
  if (trimmed.length < 32 || trimmed.length > 64) throw new Error("That is not a wallet address.");
  try {
    return new PublicKey(trimmed).toBase58();
  } catch {
    throw new Error("That is not a wallet address.");
  }
}

export interface IssuedChallenge {
  nonce: string;
  message: string;
}

/** Hand out a fresh nonce bound to one address. */
export function issueChallenge(address: string, now = Date.now()): IssuedChallenge {
  sweep(now);
  const nonce = randomBytes(16).toString("hex");
  challenges.set(nonce, { address, expiresAt: now + CHALLENGE_TTL_MS });
  return { nonce, message: challengeMessage(address, nonce) };
}

/**
 * Spend a nonce and check the signature over its message.
 *
 * The nonce is deleted whether or not the signature checks out: it is a
 * one-shot, and leaving a failed attempt's nonce alive would turn a single
 * challenge into an unlimited number of guesses against it.
 *
 * Throws with a player-readable reason; returns nothing on success.
 */
export function verifyChallenge(
  address: string,
  nonce: string,
  signatureBase64: string,
  now = Date.now()
): void {
  const challenge = challenges.get(nonce);
  challenges.delete(nonce);

  if (!challenge || challenge.expiresAt <= now) {
    throw new Error("That sign-in request expired. Try again.");
  }
  if (challenge.address !== address) {
    throw new Error("That sign-in request was for a different wallet.");
  }

  let signature: Buffer;
  try {
    signature = Buffer.from(signatureBase64, "base64");
  } catch {
    throw new Error("That signature could not be read.");
  }
  // Ed25519 signatures are 64 bytes. Buffer.from silently accepts garbage and
  // returns whatever it could decode, so length is the check that catches it.
  if (signature.length !== nacl.sign.signatureLength) {
    throw new Error("That signature could not be read.");
  }

  const message = Buffer.from(challengeMessage(address, nonce), "utf8");
  const ok = nacl.sign.detached.verify(
    new Uint8Array(message),
    new Uint8Array(signature),
    new PublicKey(address).toBytes()
  );
  if (!ok) throw new Error("That signature does not match the wallet.");
}

/** Test seam: forget every outstanding challenge. */
export function resetChallenges(): void {
  challenges.clear();
}
