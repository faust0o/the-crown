import type { PrismaClient } from "./generated/prisma";
import { hashToken } from "./auth";
import { prisma } from "./prisma";

export interface Context {
  prisma: PrismaClient;
  /** Authenticated user id, or null for anonymous (logged-out) requests. */
  userId: string | null;
  /** The session row behind `userId`, so `logout` can revoke exactly this one. */
  sessionId: string | null;
  /** Caller address, for rate limits that have to key on something before login. */
  ip: string;
}

/**
 * Resolve an Authorization bearer token to a user id via the sessions table.
 *
 * The lookup is by hash, because that is all the table holds — see `hashToken`.
 * A desk's account is never a caller. Nothing creates desks any more — the board
 * is priced by players — but the accounts the old market-making desks used still
 * exist behind their old bets, and excluding them here means one can never
 * become the subject of a request no matter how a session row arrived.
 */
export async function createContext(
  authHeader?: string | null,
  ip = ""
): Promise<Context> {
  let userId: string | null = null;
  let sessionId: string | null = null;

  const token = parseBearer(authHeader);
  if (token) {
    try {
      const session = await prisma.session.findUnique({
        where: { token: hashToken(token) },
        include: { user: { select: { isDesk: true } } },
      });
      if (session && !session.user.isDesk && session.expiresAt.getTime() > Date.now()) {
        userId = session.userId;
        sessionId = session.id;
      }
    } catch {
      // DB unreachable — treat as anonymous rather than failing the request.
      userId = null;
      sessionId = null;
    }
  }
  return { prisma, userId, sessionId, ip };
}

/**
 * The caller's user id, for a field the guard layer already marked `requireUser`.
 *
 * Not a second authorisation check — `schema/guards.ts` is where that decision
 * lives, and it has already refused an anonymous caller before the resolver
 * runs. This exists so the resolver's *types* know that, instead of every
 * authenticated field carrying a `ctx.userId!` that would keep compiling if the
 * guard were ever removed. If it ever throws, a field lost its guard.
 */
export function callerId(ctx: Context): string {
  if (!ctx.userId) {
    throw new Error("unguarded authenticated field — see schema/guards.ts");
  }
  return ctx.userId;
}

function parseBearer(header?: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+([A-Za-z0-9._-]+)$/i.exec(header.trim());
  return match ? match[1] : null;
}
