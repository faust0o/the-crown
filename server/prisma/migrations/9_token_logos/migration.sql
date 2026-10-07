-- Token logos, stored rather than proxied on every request.
--
-- Keyed by the upstream URL, which is what a token's `imageUrl` names and what
-- the client asks `/logo` for. A token whose logo moves gets a new row; the old
-- one is a few kilobytes nobody asks for.
CREATE TABLE "TokenLogo" (
    "url" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TokenLogo_pkey" PRIMARY KEY ("url")
);
