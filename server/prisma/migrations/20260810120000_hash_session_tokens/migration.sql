-- Session.token now holds sha256(token) rather than the token itself.
--
-- Hashed in place rather than truncated. Deleting the rows would have been the
-- obvious move and it is the wrong one here: an invite code is single-use and
-- redeeming one is the only way to sign in, so a player whose session is deleted
-- cannot make a new one -- their account, and its credits, would simply be
-- unreachable forever.
--
-- Nothing needs to be deleted anyway. The database is holding the plaintext
-- right now, so it can compute the digest itself; the clients keep the token
-- they already have, it hashes to what is stored, and every session survives.
-- After this runs the plaintext exists only in the browsers that hold it.
--
-- Guarded on length so a re-run cannot hash a hash: issued tokens are 48 hex
-- characters (24 bytes) and a digest is 64.
UPDATE "Session"
   SET token = encode(sha256(token::bytea), 'hex')
 WHERE length(token) <> 64;

-- Expiry is now a query in its own right (the hourly sweep in src/sessions.ts),
-- not just a field read off a row already found by token.
CREATE INDEX IF NOT EXISTS "Session_expiresAt_idx" ON "Session"("expiresAt");
