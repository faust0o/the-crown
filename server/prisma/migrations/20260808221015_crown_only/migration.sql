-- DropForeignKey
ALTER TABLE "Bet" DROP CONSTRAINT "Bet_packageId_fkey";

-- DropForeignKey
ALTER TABLE "Bet" DROP CONSTRAINT "Bet_userId_fkey";

-- DropForeignKey
ALTER TABLE "MetricSnapshot" DROP CONSTRAINT "MetricSnapshot_packageId_fkey";

-- DropTable
DROP TABLE "Bet";

-- DropTable
DROP TABLE "MetricSnapshot";

-- DropTable
DROP TABLE "Package";

-- DropEnum
DROP TYPE "BetDirection";

-- DropEnum
DROP TYPE "Market";

