import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express, type NextFunction, type Request, type Response } from "express";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Where `vite build` (+ the prerender step) puts the client. */
export const CLIENT_DIR = process.env.CLIENT_DIR
  ? path.resolve(process.env.CLIENT_DIR)
  : path.resolve(HERE, "../../dist");

/** The SPA shell — one document, with its CSS already inlined. */
const INDEX_HTML = path.join(CLIENT_DIR, "index.html");

export const hasClientBuild = () => existsSync(INDEX_HTML);

/**
 * Vite, when `bun dev` is running it beside this server.
 *
 * Set, a page asked of this server is sent there instead of to `dist/` — which
 * in dev is whatever was last built, never the code being edited, and looks
 * enough like the live site that nothing says it is stale.
 */
export const DEV_CLIENT_URL = process.env.DEV_CLIENT_URL || null;

const HAS_EXTENSION = /\.[a-z0-9]+$/i;

/**
 * Serve the built SPA alongside /graphql.
 *
 * The document already carries its CSS inline, so a cold load is one request to
 * first paint. Everything under /assets is content-hashed by Vite and therefore
 * immutable; the HTML itself must always be revalidated.
 */
export function serveClient(app: Express): void {
  if (DEV_CLIENT_URL) {
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method !== "GET" && req.method !== "HEAD") return next();
      res.redirect(302, new URL(req.originalUrl, DEV_CLIENT_URL).toString());
    });
    return;
  }

  app.use(
    "/assets",
    express.static(path.join(CLIENT_DIR, "assets"), {
      immutable: true,
      maxAge: "1y",
    })
  );

  // public/ files (icons, the link-preview card) — not hashed, so revalidate daily.
  app.use(express.static(CLIENT_DIR, { index: false, maxAge: "1d" }));

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    // A missing file with an extension is a 404, not an SPA route.
    if (HAS_EXTENSION.test(req.path)) return next();

    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(INDEX_HTML, (err) => {
      if (err) next(err);
    });
  });
}
