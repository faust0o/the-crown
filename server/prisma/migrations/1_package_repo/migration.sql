-- Add GitHub repo + owner (avatar thumbnail source) to Package
ALTER TABLE "Package" ADD COLUMN "repoUrl" TEXT;
ALTER TABLE "Package" ADD COLUMN "githubOwner" TEXT;
