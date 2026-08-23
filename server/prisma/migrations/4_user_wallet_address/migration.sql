-- The wallet a player bets from, once they have completed the on-chain setup.
-- Nullable because every existing row predates it and every player has one only
-- after connecting; unique because the program settles payouts to a wallet, and
-- two rows sharing one would let two accounts spend the same balance.
ALTER TABLE "User" ADD COLUMN "walletAddress" TEXT;
CREATE UNIQUE INDEX "User_walletAddress_key" ON "User"("walletAddress");
