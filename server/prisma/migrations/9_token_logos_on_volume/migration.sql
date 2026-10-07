-- Token logos move from Postgres to the service's volume (see src/logo-store.ts).
--
-- The rows are a cache of files fetched from public hosts, so nothing is lost:
-- each logo is fetched again, once, onto the volume.
--
-- Named to sort straight after `9_token_logos`, which created the table. Prisma
-- applies migrations in the order their directory names sort as strings, so a
-- `10_…` here would sort before `2_…` and, on a fresh database, drop the table
-- before it existed.
DROP TABLE IF EXISTS "TokenLogo";
