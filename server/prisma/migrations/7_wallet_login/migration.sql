-- Wallet login replaces invite codes.
--
-- `User.walletAddress` already exists and is already unique (migration 4); what
-- changes is that it is now the identity rather than a note about a payment
-- method. Accounts that predate this have none and can no longer be signed
-- into — their rows stay because settled bets point at them.
ALTER TABLE "User" DROP CONSTRAINT IF EXISTS "User_inviteCodeId_fkey";
ALTER TABLE "User" DROP COLUMN IF EXISTS "inviteCodeId";
DROP TABLE IF EXISTS "InviteCode";
