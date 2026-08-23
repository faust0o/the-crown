import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns";
import type { Express, Request, RequestHandler, Response } from "express";
import { Agent, fetch as undiciFetch, type Response as UndiciResponse } from "undici";

/**
 * Same-origin proxy for token logos.
 *
 * Logos come from arweave, per-content IPFS gateway subdomains and
 * raw.githubusercontent, and several send no `Access-Control-Allow-Origin`.
 * That's fine for display, but the chart samples each logo's dominant colour via
 * a canvas, and reading pixels from a canvas tainted by a cross-origin image
 * throws — and the attempt logs a CORS error on every load. Serving them from
 * our own origin removes both problems.
 *
 * An exact host allowlist goes stale immediately because IPFS gateways put the
 * content hash in the subdomain, so the guard has to be "can this reach anything
 * we own" rather than "is this a host we know". That guard is only sound if it
 * runs against the *address* rather than the name:
 *
 *   - A name says nothing about where it points. `localtest.me` and the whole
 *     `nip.io` family resolve to 127.0.0.1 and hold valid certificates, so a
 *     hostname blocklist waves them straight through to our own loopback — and
 *     :4000 there is this very server, unauthenticated from its own point of
 *     view.
 *   - A redirect is a second request that the first one's check never saw. Left
 *     to `fetch`'s default, an allowed https host answers 302 to
 *     `http://169.254.169.254/…` and the proxy fetches the cloud metadata
 *     service on the attacker's behalf.
 *
 * So: resolve first, refuse any address in a private, loopback, link-local or
 * otherwise non-public range, then pin the connection to the address that was
 * checked. Redirects are followed manually, at most `MAX_REDIRECTS` deep, each
 * hop re-entering the same check. The response is capped, has to be an image,
 * and is served with `nosniff` so a mislabelled body can't become script on our
 * own origin.
 */

/** Redirect hops to follow. Enough for the CDNs we see, few enough to bound the work. */
const MAX_REDIRECTS = 3;
/** Largest logo we will relay. Comfortably above any real icon. */
const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 8_000;

/** Image types we are willing to re-serve. Excludes SVG — it is script. */
const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  "image/avif",
  "image/x-icon",
  "image/vnd.microsoft.icon",
  // **SVG, which is the interesting one.**
  //
  // Excluding it is the right default everywhere else: an SVG is a document,
  // it can carry `<script>`, and serving one from your own origin is a stored
  // XSS with extra steps. It was excluded here for that reason.
  //
  // The cost was not theoretical. Three of the ten coins on the board — and a
  // rotating set of them, since the board turns over — are served as
  // `image/svg+xml` by their issuer, so they came back 415 and rendered as
  // lettered discs. It looked random because *which* coins are on the board is.
  //
  // What makes it safe here rather than in general is the pair of headers below,
  // which this route already sent before SVG was allowed: `sandbox` with no
  // `allow-scripts` means the document cannot execute anything even when opened
  // directly, and `nosniff` stops a mislabelled body being reinterpreted. An
  // `<img>` tag — which is the only way the app uses this — never runs scripts
  // in an SVG regardless.
  "image/svg+xml",
]);

/**
 * Is this address one the public internet could not have given us?
 *
 * Covers the ranges an SSRF actually wants: loopback, RFC1918, carrier-grade
 * NAT, link-local (which is where every cloud metadata service lives), and the
 * IPv6 equivalents including the v4-mapped forms that would otherwise smuggle a
 * v4 private address past a v6 check.
 */
export function isPrivateAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPrivateV4(ip);
  if (version === 6) return isPrivateV6(ip);
  return true; // not an address we can reason about — refuse
}

function isPrivateV4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  return (
    a === 0 || // "this network"
    a === 10 || // RFC1918
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // RFC6598 carrier-grade NAT
    (a === 169 && b === 254) || // link-local — cloud metadata lives here
    (a === 172 && b >= 16 && b <= 31) || // RFC1918
    (a === 192 && b === 0) || // IETF protocol assignments
    (a === 192 && b === 168) || // RFC1918
    (a === 198 && b >= 18 && b <= 19) || // benchmarking
    a >= 224 // multicast + reserved + broadcast
  );
}

function isPrivateV6(ip: string): boolean {
  const addr = ip.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];

  // ::ffff:127.0.0.1 and friends are v4 wearing a v6 coat. Judge the v4.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (mapped) return isPrivateV4(mapped[1]);

  if (addr === "::" || addr === "::1") return true; // unspecified, loopback
  const head = addr.split(":")[0];
  if (head.startsWith("fe8") || head.startsWith("fe9")) return true; // link-local
  if (head.startsWith("fea") || head.startsWith("feb")) return true;
  if (head.startsWith("fc") || head.startsWith("fd")) return true; // unique-local
  if (head.startsWith("ff")) return true; // multicast
  return false;
}

/**
 * A dispatcher that refuses to open a socket to an address we don't like.
 *
 * The check belongs *at connect time*, not before it. Vetting a hostname and
 * then handing the URL to `fetch` leaves a window in which the name can be
 * re-resolved to something else — classic DNS rebinding — and the obvious way to
 * close it, rewriting the URL to the vetted IP, breaks TLS: the certificate is
 * then validated against an address literal, so every host that serves more than
 * one site fails. (It does not fail *open*, but "no logos load" is still a bug.)
 *
 * Undici lets the connector do its own name resolution, which resolves both
 * problems at once. The address this returns is the address the socket connects
 * to — there is no second lookup to disagree with — and the TLS handshake still
 * sees the real hostname, so SNI and certificate validation are untouched.
 *
 * Every hop gets this treatment, redirects included, because they all go through
 * the same dispatcher.
 */
const guardedAgent = new Agent({
  connect: {
    timeout: TIMEOUT_MS,
    lookup(hostname, options, callback) {
      dnsLookup(hostname, options, (err, address, family) => {
        if (err) return callback(err, address as never, family as never);
        const addresses = Array.isArray(address) ? address : [{ address, family }];
        for (const a of addresses) {
          if (isPrivateAddress(a.address)) {
            return callback(
              new Error(`refusing to connect to a private address (${hostname})`),
              address as never,
              family as never
            );
          }
        }
        callback(null, address as never, family as never);
      });
    },
  },
});

type Response_ = UndiciResponse;

/** Vet the parts of a hop that are visible before a connection: scheme, and any literal address. */
function vetUrl(url: URL): boolean {
  if (url.protocol !== "https:") return false;
  // A literal address never reaches the resolver, so it is checked here instead.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && isPrivateAddress(host)) return false;
  return true;
}

/** Read at most `MAX_BYTES`, refusing rather than truncating an oversized body. */
async function readCapped(res: Response_): Promise<Buffer | null> {
  const declared = Number(res.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > MAX_BYTES) return null;
  if (!res.body) return null;

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export function serveLogoProxy(app: Express, limiter: RequestHandler): void {
  app.get("/logo", limiter, async (req: Request, res: Response) => {
    const raw = typeof req.query.u === "string" ? req.query.u : "";
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      res.status(400).end();
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      let upstream: Response_ | null = null;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        if (!vetUrl(url)) {
          res.status(403).end();
          return;
        }
        const hopRes = await undiciFetch(url, {
          signal: controller.signal,
          redirect: "manual",
          headers: { accept: "image/*" },
          dispatcher: guardedAgent,
        });

        // Follow it ourselves so the next hop meets the same scheme check this
        // one did — `redirect: "follow"` would happily walk to an http:// URL.
        // The address check needs no help here: it is in the dispatcher, so it
        // applies to every hop whether we look at it or not.
        const location =
          hopRes.status >= 300 && hopRes.status < 400
            ? hopRes.headers.get("location")
            : null;
        if (!location) {
          upstream = hopRes;
          break;
        }
        const from = url;
        await hopRes.body?.cancel();
        try {
          url = new URL(location, from);
        } catch {
          res.status(502).end();
          return;
        }
      }

      if (!upstream) {
        res.status(502).end(); // ran out of hops
        return;
      }
      if (!upstream.ok) {
        res.status(502).end();
        return;
      }

      const type = (upstream.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      if (!IMAGE_TYPES.has(type)) {
        await upstream.body?.cancel();
        res.status(415).end();
        return;
      }

      const body = await readCapped(upstream);
      if (!body) {
        res.status(502).end();
        return;
      }

      res.setHeader("Content-Type", type);
      // A body that lied about its type must not become script on our origin.
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
      res.setHeader("Cache-Control", "public, max-age=86400, immutable");
      res.end(body);
    } catch {
      res.status(504).end();
    } finally {
      clearTimeout(timer);
    }
  });
}
