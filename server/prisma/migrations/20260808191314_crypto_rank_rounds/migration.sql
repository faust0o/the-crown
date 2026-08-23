-- CreateEnum
CREATE TYPE "RoundStatus" AS ENUM ('OPEN', 'LOCKED', 'CUT', 'SETTLED');

-- CreateEnum
CREATE TYPE "RankDirection" AS ENUM ('HIGHER', 'DRAW', 'LOWER');

-- CreateTable
CREATE TABLE "Round" (
    "id" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "lockAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "commitHash" TEXT NOT NULL,
    "seed" TEXT,
    "cutAt" TIMESTAMP(3),
    "status" "RoundStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Round_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoundEntry" (
    "id" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "ticker" TEXT NOT NULL,
    "startRank" INTEGER NOT NULL,
    "startVolume" DOUBLE PRECISION NOT NULL,
    "cutRank" INTEGER,
    "cutVolume" DOUBLE PRECISION,

    CONSTRAINT "RoundEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CryptoBet" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "ticker" TEXT NOT NULL,
    "direction" "RankDirection" NOT NULL,
    "stake" INTEGER NOT NULL,
    "odds" DOUBLE PRECISION NOT NULL,
    "startRank" INTEGER NOT NULL,
    "status" "BetStatus" NOT NULL DEFAULT 'OPEN',
    "cutRank" INTEGER,
    "payout" INTEGER NOT NULL DEFAULT 0,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "CryptoBet_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Round_startsAt_key" ON "Round"("startsAt");

-- CreateIndex
CREATE INDEX "Round_status_idx" ON "Round"("status");

-- CreateIndex
CREATE UNIQUE INDEX "RoundEntry_roundId_symbol_key" ON "RoundEntry"("roundId", "symbol");

-- CreateIndex
CREATE INDEX "CryptoBet_userId_status_idx" ON "CryptoBet"("userId", "status");

-- CreateIndex
CREATE INDEX "CryptoBet_roundId_idx" ON "CryptoBet"("roundId");

-- AddForeignKey
ALTER TABLE "RoundEntry" ADD CONSTRAINT "RoundEntry_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "Round"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CryptoBet" ADD CONSTRAINT "CryptoBet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CryptoBet" ADD CONSTRAINT "CryptoBet_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "Round"("id") ON DELETE CASCADE ON UPDATE CASCADE;
