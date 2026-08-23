import { PrismaClient } from "./generated/prisma";

export const prisma = new PrismaClient();

// Market/bet enums are passed to Prisma as string literals (assignable to the
// generated `$Enums` union types), so consumers use these local unions and
// never depend on how the client re-exports its runtime enums.
export type MarketValue = "DOWNLOADS" | "CDN_HITS";
export type BetDirectionValue = "UP" | "DOWN";
export type BetStatusValue = "OPEN" | "WON" | "LOST" | "CASHED_OUT" | "VOID";
