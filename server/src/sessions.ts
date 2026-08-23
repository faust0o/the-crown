import { prisma } from "./prisma";

/**
 * Delete sessions that have already expired.
 *
 * `createContext` checks `expiresAt` on every request, so an expired row is
 * already powerless — this is not what stops it being used. It is about the row
 * not being there to steal: a dump of a table that keeps every session ever
 * issued is a much better prize than one holding only the live ones, and the
 * table otherwise grows for the life of the product with rows that can never be
 * read again.
 */
export async function sweepExpiredSessions(): Promise<number> {
  const { count } = await prisma.session.deleteMany({
    where: { expiresAt: { lte: new Date() } },
  });
  return count;
}

const SWEEP_INTERVAL_MS = 60 * 60_000;

let timer: ReturnType<typeof setInterval> | null = null;

export function startSessionSweep(): void {
  if (timer) return;
  const run = () => {
    void sweepExpiredSessions().catch((err) =>
      console.warn("⚠  session sweep:", err?.message ?? err)
    );
  };
  timer = setInterval(run, SWEEP_INTERVAL_MS);
  // Hourly work should not be the reason the process can't exit.
  timer.unref?.();
  run();
}

export function stopSessionSweep(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
