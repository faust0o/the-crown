import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { NextFunction, Request, Response } from "express";
import { IS_PRODUCTION } from "../env";
import { LIVE_ENABLED, LIVE_PASSWORD } from "./config";

/**
 * Who may run the livestream: whoever knows `LIVE_PASSWORD`.
 *
 * One shared password rather than accounts, because there is one control room
 * and the people in it are the people running the game. Signing in sets a
 * cookie, not a bearer token, for two reasons: the ingest WebSocket and the
 * <audio> element that plays the music can only carry a cookie, and an
 * HttpOnly one is out of reach of anything injected into the page.
 *
 * The cookie is stateless — an expiry and its HMAC — so there is no table to
 * keep and no sweep to run. The signing key is derived from the password, which
 * means changing the password signs every session out.
 */

export const SESSION_COOKIE = "crown_live";
/** Only the API needs it; the page itself is the public SPA shell. */
const COOKIE_PATH = "/api/live";
const TTL_MS = 7 * 24 * 60 * 60_000;

const sha256 = (s: string) => createHash("sha256").update(s).digest();
const keyFor = (password: string) => sha256(`crown-live-session\0${password}`);

/**
 * Compared as digests so the comparison takes the same time whatever the
 * length of the guess — `timingSafeEqual` refuses buffers of unequal length,
 * and comparing the raw strings would leak the password's length instead.
 */
export function passwordMatches(password: string, given: unknown): boolean {
  if (!password || typeof given !== "string") return false;
  return timingSafeEqual(sha256(given), sha256(password));
}

export function issueToken(password: string, now = Date.now()): string {
  const exp = String(now + TTL_MS);
  return `${exp}.${createHmac("sha256", keyFor(password)).update(exp).digest("base64url")}`;
}

export function tokenValid(password: string, token: string | undefined, now = Date.now()): boolean {
  if (!password || !token) return false;
  const dot = token.indexOf(".");
  const exp = token.slice(0, dot);
  if (dot < 0 || !/^\d{1,16}$/.test(exp) || Number(exp) <= now) return false;
  const want = createHmac("sha256", keyFor(password)).update(exp).digest();
  const got = Buffer.from(token.slice(dot + 1), "base64url");
  return got.length === want.length && timingSafeEqual(got, want);
}

/** One cookie out of a `Cookie` header. The server has no cookie parser otherwise. */
export function cookieFrom(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Whether a request came from a page on this origin.
 *
 * Browsers send `Origin` on every request that is not a plain GET, and on every
 * WebSocket handshake. A request without one is not from a browser, so it holds
 * nobody's cookie and has nothing to forge — `SameSite=Strict` is the first
 * line against cross-site requests and this is the second.
 */
export function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

export function signedIn(req: IncomingMessage): boolean {
  return (
    LIVE_ENABLED && tokenValid(LIVE_PASSWORD, cookieFrom(req.headers.cookie, SESSION_COOKIE))
  );
}

export function setSession(res: Response): void {
  res.cookie(SESSION_COOKIE, issueToken(LIVE_PASSWORD), {
    httpOnly: true,
    sameSite: "strict",
    // Only over TLS in production; a local http server would never get it back.
    secure: IS_PRODUCTION,
    path: COOKIE_PATH,
    maxAge: TTL_MS,
  });
}

export function clearSession(res: Response): void {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: "strict",
    secure: IS_PRODUCTION,
    path: COOKIE_PATH,
  });
}

/** Everything behind the password. */
export function requireSession(req: Request, res: Response, next: NextFunction): void {
  if (!signedIn(req)) {
    res.status(401).json({ error: "Sign in to the livestream first." });
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD" && !sameOrigin(req)) {
    res.status(403).json({ error: "Cross-origin request refused." });
    return;
  }
  next();
}
