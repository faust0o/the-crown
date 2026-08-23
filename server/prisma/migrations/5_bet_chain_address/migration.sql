-- The position account a bet lives in on-chain, when it was placed there.
--
-- Null for every bet placed through the Postgres path, which is every bet before
-- this and every bet by a player who has not connected a wallet. Unique because
-- a position account is one position: two rows pointing at it would be two
-- records of one bet, and settlement would pay one and strand the other.
ALTER TABLE "CryptoBet" ADD COLUMN "chainAddress" TEXT;
CREATE UNIQUE INDEX "CryptoBet_chainAddress_key" ON "CryptoBet"("chainAddress");
