-- CreateTable
CREATE TABLE "RankSample" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "symbol" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "volume" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "RankSample_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RankSample_at_idx" ON "RankSample"("at");

-- CreateIndex
CREATE UNIQUE INDEX "RankSample_at_symbol_key" ON "RankSample"("at", "symbol");
