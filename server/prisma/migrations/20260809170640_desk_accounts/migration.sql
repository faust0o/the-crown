-- AlterTable
ALTER TABLE "User" ADD COLUMN     "isDesk" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "User_isDesk_idx" ON "User"("isDesk");
