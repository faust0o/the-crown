import { createHash, randomBytes, randomInt } from "node:crypto";

export const SESSION_TTL_DAYS = 30;

export function newToken(): string {
  return randomBytes(24).toString("hex");
}

/**
 * What we store for a session — never the token itself.
 *
 * A session token is a password that skips the password: whoever holds one is
 * the account until it expires. Storing them in the clear means a leaked dump,
 * a stray backup or a read-only SQL injection hands over every live account
 * rather than a list of who exists. Hashing makes the table useless for
 * impersonation, and costs one sha256 per request.
 *
 * Unsalted and unstretched on purpose: the input is 24 bytes of CSPRNG output,
 * so there is no dictionary to run and nothing for a salt to defeat. The reason
 * password hashes need bcrypt — low-entropy inputs — does not apply, and a slow
 * KDF on the read path would tax every authenticated request instead.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function sessionExpiry(): Date {
  return new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
}

const ADJECTIVES = [
  "degen", "paper", "diamond", "based", "giga",
  "alpha", "rekt", "moon", "turbo", "silent",
];
const NOUNS = [
  "whale", "ape", "trader", "maxi", "chad",
  "frog", "bull", "bear", "wojak", "hodler",
];

/** Pseudonymous handle e.g. "giga-whale-482". Uniqueness enforced by caller. */
export function newHandle(): string {
  const a = ADJECTIVES[randomInt(ADJECTIVES.length)];
  const n = NOUNS[randomInt(NOUNS.length)];
  return `${a}-${n}-${randomInt(100, 1000)}`;
}
