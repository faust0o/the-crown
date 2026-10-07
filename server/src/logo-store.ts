import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Express, Request, RequestHandler, Response } from "express";
import { fetchLogo, type Logo } from "./logo-proxy";

/**
 * Token logos, served from our own origin and our own disk.
 *
 * `/logo` used to be a pass-through: every visitor's browser asked for every
 * logo, and every ask was a fresh fetch from the issuer's host. That is slow —
 * two to three seconds for half the board — and it fails in ways a visitor
 * sees as a coin with no face: IPFS gateways rate-limiting this server,
 * arweave serving files with no content type. Measured against one live board,
 * nine logos in sixty-one failed, cbBTC's and PUMP's among them.
 *
 * Now a logo is fetched once, in the background, when the oracle first meets
 * the token, and kept on disk for good. The request path reads memory or disk
 * and only reaches the network for a logo it has never managed to fetch. A
 * failure is retried on a backoff rather than on every page load, so a gateway
 * that is rate-limiting us is not asked again by every visitor at once.
 *
 * On Railway the disk is the service's volume, which Railway mounts at
 * `RAILWAY_VOLUME_MOUNT_PATH`, so the logos outlive a deploy. They used to live
 * in Postgres to keep the service volume-free, because a service with a volume
 * cannot run two deployments at once and so every deploy has a few seconds of
 * downtime. That trade was reversed deliberately. Off Railway, with no
 * `LOGO_DIR`, they go to a temp directory: a cache that a reboot can clear,
 * since every logo is fetched again on demand.
 *
 * It also stops being an open proxy. `/logo` serves the logos of tokens the game
 * knows — every URL the oracle has handed out — and refuses the rest, which a
 * store would otherwise have to hold for anyone who asked.
 */

/** Where logos are kept. */
const DIR =
  process.env.LOGO_DIR ??
  join(process.env.RAILWAY_VOLUME_MOUNT_PATH ?? join(tmpdir(), "crown"), "logos");

/** How many logos may be fetched at once. */
const CONCURRENCY = 4;
/** The first retry after a failed fetch, doubling up to `MAX_RETRY_MS`. */
const FIRST_RETRY_MS = 30_000;
const MAX_RETRY_MS = 60 * 60_000;
/** Bytes of logos kept in memory, least recently served evicted first. */
const MEMORY_BUDGET = 32 * 1024 * 1024;

/** URLs the oracle has handed out as some token's `imageUrl`. */
const known = new Set<string>();
/** Files in `DIR`, by `fileOf` name — one per stored logo. */
const stored = new Set<string>();
/** Recently served logos, oldest first — a `Map` keeps insertion order. */
const hot = new Map<string, Logo>();
let hotBytes = 0;
const failures = new Map<string, { attempts: number; retryAt: number }>();
const inFlight = new Map<string, Promise<Logo | null>>();
const queue: string[] = [];
let active = 0;
let primed: Promise<void> | null = null;

/**
 * The file a logo is kept in: the sha256 of its upstream URL, which is what
 * the token's `imageUrl` names. Hashed because a URL is not a filename — it is
 * too long, and its slashes and query strings mean something to a filesystem.
 */
const fileOf = (url: string) => createHash("sha256").update(url).digest("hex");
const FILE = /^[0-9a-f]{64}$/;

/**
 * Learn which logos are already stored. Once per process, and again only if it
 * failed — a volume that was not mounted yet at boot.
 */
function ensurePrimed(): Promise<void> {
  primed ??= mkdir(DIR, { recursive: true })
    .then(() => readdir(DIR))
    .then((names) => {
      for (const n of names) if (FILE.test(n)) stored.add(n);
    })
    .catch((err) => {
      console.warn(`⚠  logo store ${DIR} unavailable:`, err instanceof Error ? err.message : err);
      primed = null;
    });
  return primed;
}

/**
 * One file per logo: its content type, a newline, then the body. A content type
 * cannot contain a newline, so the first one is the boundary.
 *
 * Written to a temporary name and renamed into place, so a reader never sees a
 * half-written file and a crash mid-write leaves nothing that looks stored.
 */
async function writeStored(url: string, logo: Logo): Promise<void> {
  const name = fileOf(url);
  const tmp = join(DIR, `${name}.${process.pid}.tmp`);
  await writeFile(tmp, Buffer.concat([Buffer.from(`${logo.type}\n`), logo.body]));
  await rename(tmp, join(DIR, name));
  stored.add(name);
}

async function readStored(url: string): Promise<Logo | null> {
  const file = await readFile(join(DIR, fileOf(url))).catch(() => null);
  const cut = file?.indexOf(0x0a) ?? -1;
  if (!file || cut < 0) return null;
  return { type: file.subarray(0, cut).toString(), body: file.subarray(cut + 1) };
}

function keep(url: string, logo: Logo): void {
  const held = hot.get(url);
  if (held) {
    hot.delete(url);
    hotBytes -= held.body.byteLength;
  }
  hot.set(url, logo);
  hotBytes += logo.body.byteLength;
  for (const [oldest, evicted] of hot) {
    if (hotBytes <= MEMORY_BUDGET) break;
    hot.delete(oldest);
    hotBytes -= evicted.body.byteLength;
  }
}

const backingOff = (url: string) => {
  const f = failures.get(url);
  return f != null && Date.now() < f.retryAt;
};

/** Fetch and store one logo. Shared by everyone waiting on the same URL. */
function load(url: string): Promise<Logo | null> {
  const pending = inFlight.get(url);
  if (pending) return pending;
  const job = (async () => {
    try {
      const logo = await fetchLogo(url);
      failures.delete(url);
      keep(url, logo);
      try {
        await ensurePrimed();
        await writeStored(url, logo);
      } catch {
        // Unstored is still servable from memory, and is fetched again next
        // process. Never worth failing a request over.
      }
      return logo;
    } catch (err) {
      const attempts = (failures.get(url)?.attempts ?? 0) + 1;
      const wait = Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** (attempts - 1));
      failures.set(url, { attempts, retryAt: Date.now() + wait });
      // The first failure and then every fifth: enough to see a logo that will
      // never load, without a line every half-minute for each one.
      if (attempts === 1 || attempts % 5 === 0) {
        console.warn(
          `⚠  logo (attempt ${attempts}, next in ${Math.round(wait / 1000)}s) ${url}:`,
          err instanceof Error ? err.message : err
        );
      }
      return null;
    } finally {
      inFlight.delete(url);
    }
  })();
  inFlight.set(url, job);
  return job;
}

function pump(): void {
  while (active < CONCURRENCY && queue.length) {
    const url = queue.shift()!;
    active++;
    void load(url).finally(() => {
      active--;
      pump();
    });
  }
}

/**
 * Note a token's logo, and fetch it in the background if it is not stored yet.
 *
 * Cheap enough to call on every poll for every coin on the board, which is the
 * point: that is what retries a logo whose host failed, once its backoff has
 * run, without anything having to remember to.
 */
export function warmLogo(url: string | null | undefined): void {
  if (!url) return;
  known.add(url);
  const name = fileOf(url);
  if (stored.has(name) || inFlight.has(url) || backingOff(url) || queue.includes(url)) return;
  void ensurePrimed().then(() => {
    if (stored.has(name) || inFlight.has(url) || queue.includes(url)) return;
    queue.push(url);
    pump();
  });
}

async function logoFor(url: string): Promise<Logo | null> {
  const held = hot.get(url);
  if (held) {
    keep(url, held); // touch, for the eviction order
    return held;
  }
  await ensurePrimed();
  if (stored.has(fileOf(url))) {
    const logo = await readStored(url);
    if (logo) {
      keep(url, logo);
      return logo;
    }
  }
  // Never stored. Fetched now if it is not resting after a failure — the one
  // case where a visitor waits on the network, and only once per logo.
  return backingOff(url) ? null : load(url);
}

export function serveLogos(app: Express, limiter: RequestHandler): void {
  app.get("/logo", limiter, async (req: Request, res: Response) => {
    const url = typeof req.query.u === "string" ? req.query.u : "";
    if (!url) {
      res.status(400).end();
      return;
    }
    await ensurePrimed();
    if (!known.has(url) && !stored.has(fileOf(url))) {
      res.status(404).end();
      return;
    }

    const logo = await logoFor(url);
    if (!logo) {
      res.status(502).end();
      return;
    }
    res.setHeader("Content-Type", logo.type);
    // A body that lied about its type must not become script on our origin. The
    // sandbox is what makes serving SVG here safe: opened directly, it still
    // cannot run anything.
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    res.end(logo.body);
  });
}
