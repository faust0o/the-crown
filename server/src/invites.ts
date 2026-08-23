import { randomInt } from "node:crypto";
import { prisma } from "./prisma";

/** How many usable codes the server keeps in circulation. */
const KEEP = 5;
/** Accounts each code can create before it's spent. */
const USES_PER_CODE = 1;

// No vowels or look-alikes, so a code read aloud or off a screen can't be
// mistyped into a different valid one.
const ALPHABET = "23456789BCDFGHJKLMNPQRSTVWXYZ";

function newCode(): string {
  let body = "";
  for (let i = 0; i < 6; i++) body += ALPHABET[randomInt(ALPHABET.length)];
  return `CROWN-${body}`;
}

/**
 * Mint `count` fresh codes. Uniqueness is the database's call, not ours: the
 * unique constraint on `code` is what makes a racing minter (a second server,
 * or the CLI run against a live one) safe, so a rejected insert is retried with
 * a new draw rather than pre-checked with a SELECT.
 */
export async function mintInviteCodes(
  count: number,
  { maxUses = USES_PER_CODE, note }: { maxUses?: number; note?: string } = {}
): Promise<string[]> {
  const minted: string[] = [];

  for (let i = 0; i < count; i++) {
    let created = false;
    for (let attempt = 0; attempt < 5 && !created; attempt++) {
      const code = newCode();
      try {
        await prisma.inviteCode.create({ data: { code, maxUses, note } });
        minted.push(code);
        created = true;
      } catch (err) {
        // Unique collision on `code` — vanishingly unlikely, just try again.
        // Anything else (no database, bad schema) will not fix itself.
        if (!isUniqueCollision(err)) throw err;
      }
    }
    if (!created) {
      throw new Error(`could not find an unused code after 5 draws (minted ${minted.length}/${count})`);
    }
  }

  return minted;
}

function isUniqueCollision(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002";
}

/**
 * Top the pool back up to KEEP unused codes at boot.
 *
 * Idempotent: only mints what's missing, so restarts don't inflate the pool, and
 * codes already handed out and redeemed are replaced rather than resurrected.
 */
export async function seedInviteCodes(): Promise<string[]> {
  const existing = await prisma.inviteCode.findMany({
    where: { active: true },
    orderBy: { createdAt: "asc" },
  });
  const usable = existing.filter((c) => c.uses < c.maxUses);

  const missing = Math.max(0, KEEP - usable.length);
  const minted = await mintInviteCodes(missing, { note: "auto-seeded at boot" });

  return [...usable.map((c) => c.code), ...minted];
}
