-- A bet is VOIDed (stake refunded) when no decisive real data point lands
-- within 7 days of its round ending. See server/src/settlement.ts.
ALTER TYPE "BetStatus" ADD VALUE 'VOID';
