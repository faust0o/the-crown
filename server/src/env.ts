export const PORT = Number(process.env.PORT ?? 4000);

export const IS_PRODUCTION = process.env.NODE_ENV === "production";

/**
 * Origins allowed to call the API from a browser (dev uses the Vite proxy).
 *
 * The SPA is same-origin in production, so this list exists for outside callers
 * only — and an empty list is the right default there, not a permissive one.
 * Falling back to the dev origin in production would leave a localhost page able
 * to drive a real account with a real token, which is a working phishing
 * primitive rather than a hypothetical one.
 */
export const CORS_ORIGINS = (
  process.env.CORS_ORIGINS ?? (IS_PRODUCTION ? "" : "http://localhost:5173")
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export const HAS_DATABASE_URL = Boolean(process.env.DATABASE_URL);

/**
 * How many reverse proxies sit in front of us, for `X-Forwarded-For` parsing.
 *
 * One on Railway. See `trustProxy` for why this is a count and not `true`.
 */
export const TRUST_PROXY = Number(process.env.TRUST_PROXY ?? (IS_PRODUCTION ? 1 : 0));

/**
 * Whether the chain half of the game runs: `on` or `off`.
 *
 * Off by default, and that default is the point. The database game works and has
 * for months; the chain game is days old. A flag means switching between them is
 * a deploy rather than a revert, and it means whatever misbehaves at 3am can be
 * turned off by somebody who did not write it.
 *
 * When on, the server mirrors each database round onto the program, commits and
 * reveals its cut there, and settles what it owes. The database round keeps the
 * clock either way — the chain never decides *when* a round happens, only
 * settles what happened in it. Nothing bets through it yet: the only thing that
 * ever did was the market-making desks, and they are gone.
 */
export const CHAIN_MODE: "on" | "off" =
  (process.env.CHAIN_MODE ?? "off") === "on" ? "on" : "off";
