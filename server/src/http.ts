import type { Express, Request, Response } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import helmet from "helmet";
import { IS_PRODUCTION, TRUST_PROXY } from "./env";

/**
 * The HTTP layer's own defences, separate from anything GraphQL knows about.
 *
 * `schema/guards.ts` limits a *field* and `schema/limits.ts` limits a
 * *document*, but both of those run after a request has been parsed — so
 * neither is any use against a client that simply opens ten thousand
 * connections, or posts a megabyte of unparseable text. That is this file's
 * job, and it has to be done in front of Apollo rather than inside it.
 */

/**
 * Behind Railway's proxy the socket address is the proxy's, so every caller
 * looks like one caller and a per-IP limit becomes a global one. Trusting the
 * hop count rather than `true` is the part that matters: `trust proxy: true`
 * takes the left-most `X-Forwarded-For` entry, which the client writes, so any
 * caller can mint a fresh identity per request and the limiter never fires.
 */
export function trustProxy(app: Express): void {
  app.set("trust proxy", TRUST_PROXY);
  // Nothing gains from announcing the framework and its version.
  app.disable("x-powered-by");
}

/**
 * Content-Security-Policy for a site that inlines its own stylesheet.
 *
 * `style-src` has to allow inline because the build folds the CSS into the
 * document on purpose — that is the single-request-to-first-paint property, and
 * giving it up to satisfy a header would be trading a real user-visible win for
 * a theoretical one. Scripts get no such exemption: the bundle is a file, so
 * `script-src` stays free of `unsafe-inline` and an injected `<script>` is
 * refused by the browser rather than merely unlikely.
 *
 * `connect-src` is 'self' because the SPA talks to its own /graphql; token
 * logos are same-origin too, since they come through /logo.
 */
const FATHOM = "https://cdn.usefathom.com";

export function securityHeaders(app: Express): void {
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          "default-src": ["'self'"],
          "script-src": ["'self'", FATHOM],
          "style-src": ["'self'", "'unsafe-inline'"],
          "img-src": ["'self'", "data:", "blob:"],
          "font-src": ["'self'", "data:"],
          "connect-src": ["'self'", FATHOM],
          "object-src": ["'none'"],
          "base-uri": ["'none'"],
          "form-action": ["'self'"],
          // Belt and braces with the frameguard below: `frame-ancestors` is the
          // header browsers actually still honour, and a betting UI in someone
          // else's iframe is a click away from being a bet someone else placed.
          "frame-ancestors": ["'none'"],
          ...(IS_PRODUCTION ? { "upgrade-insecure-requests": [] } : {}),
        },
      },
      // Only meaningful over TLS, and setting it on a local http server would
      // pin localhost to https in the developer's browser for a year.
      strictTransportSecurity: IS_PRODUCTION
        ? { maxAge: 15_552_000, includeSubDomains: true }
        : false,
      referrerPolicy: { policy: "strict-origin-when-cross-origin" },
      crossOriginEmbedderPolicy: false, // would break the third-party analytics script
      crossOriginResourcePolicy: { policy: "same-origin" },
    })
  );
}

/**
 * Per-IP request budgets.
 *
 * Two tiers, because the two routes fail differently. /graphql is the API the
 * game polls every second, so its ceiling is high enough to be invisible to a
 * player with several tabs open and low enough to stop a script. /logo makes an
 * outbound request per call, so its budget is about not becoming someone else's
 * bandwidth.
 *
 * `ipKeyGenerator` normalises IPv6 to a /64 — without it a caller with a v6
 * allocation has effectively unlimited distinct keys and no limit at all.
 */
const limiter = (windowMs: number, max: number) =>
  rateLimit({
    windowMs,
    limit: max,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: (req: Request) => ipKeyGenerator(req.ip ?? ""),
    // A 429 that says nothing is still a 429; keep the body small and boring.
    handler: (_req: Request, res: Response) =>
      res.status(429).json({ errors: [{ message: "Too many requests." }] }),
  });

export const graphqlLimiter = limiter(60_000, 600);
export const logoLimiter = limiter(60_000, 120);

/**
 * Liveness for the platform's health check.
 *
 * Deliberately says nothing about the database, the oracle or the round loop.
 * A health check that fails when Postgres blips gets the container restarted,
 * which is precisely the wrong response — the process is fine, its dependency
 * is not, and restarting drops every in-memory book to no purpose.
 */
export function serveHealth(app: Express): void {
  app.get("/healthz", (_req: Request, res: Response) => {
    res.status(200).json({ ok: true });
  });
}
