-- A top-up that has been paid for on chain and credited here.
--
-- The signature is the idempotency key and is unique: a client that replays a
-- confirmation must not be credited twice, and the only thing that can prove a
-- payment happened is the transaction itself.
CREATE TABLE "CreditPurchase" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "lamports" BIGINT NOT NULL,
    "credits" INTEGER NOT NULL,
    "solPriceUsd" DOUBLE PRECISION NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CreditPurchase_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CreditPurchase_signature_key" ON "CreditPurchase"("signature");
CREATE INDEX "CreditPurchase_userId_idx" ON "CreditPurchase"("userId");
ALTER TABLE "CreditPurchase" ADD CONSTRAINT "CreditPurchase_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
