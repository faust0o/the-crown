import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns";
import { Agent, fetch as undiciFetch, type Response as UndiciResponse } from "undici";

/**
 * Fetching token logos without letting the fetch reach anything we own.
 *
 * `logo-store.ts` serves them from our own origin, and this is how it gets
 * them.
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

/**
 * IPFS gateways to fall back on, in order, when a logo's own gateway will not
 * serve it.
 *
 * Measured, not chosen: `ipfs.io`, `dweb.link` and `w3s.link` — one operator's
 * infrastructure under three names — answered every request from this server
 * with 429, which was a third of the board's IPFS logos on any given load,
 * including cbBTC's and PUMP's. These two served the same content IDs without
 * complaint. Content addressing is what makes a substitution safe: a CID names
 * the bytes, so any gateway that returns them returns the same image.
 */
const IPFS_GATEWAYS = ["https://gateway.pinata.cloud/ipfs/", "https://4everland.io/ipfs/"];

/** The `<cid>[/path]` a gateway URL names, in either the path or the subdomain form. */
function ipfsPath(url: URL): string | null {
  const inPath = /^\/ipfs\/(.+)$/.exec(url.pathname);
  if (inPath) return inPath[1];
  const inHost = /^([a-z0-9]+)\.ipfs\./i.exec(url.hostname);
  if (inHost) return inHost[1] + (url.pathname === "/" ? "" : url.pathname);
  return null;
}

/** Where a logo can be fetched from: its own URL first, then any equivalent. */
export function sourcesFor(url: URL): URL[] {
  const path = ipfsPath(url);
  if (!path) return [url];
  const alternates = IPFS_GATEWAYS.map((g) => new URL(g + path)).filter((u) => u.href !== url.href);
  return [url, ...alternates];
}

/**
 * What an image actually is, from its first bytes — for a response that did
 * not say.
 *
 * Arweave serves some files with no `Content-Type` at all, and a proxy that
 * only trusts the header refuses them: PENGU's and TRUMP's logos were a PNG and
 * a JPEG that came back 415 on every load. Only consulted when the declared type
 * is not an image type we serve, and only ever answers with one of those, so a
 * body can be let in this way but never turned into anything else.
 */
export function sniffImageType(body: Uint8Array): string | null {
  const b = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  const ascii = (start: number, end: number) => b.subarray(start, end).toString("latin1");
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (ascii(4, 8) === "ftyp" && /^avi[fs]$/.test(ascii(8, 12))) return "image/avif";
  if (b.length >= 4 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return "image/x-icon";
  const head = b.subarray(0, 1024).toString("utf8").replace(/^\uFEFF/, "").trimStart();
  if (head.startsWith("<") && /<svg[\s>]/i.test(head)) return "image/svg+xml";
  return null;
}

/** A logo, ready to serve. */
export interface Logo {
  type: string;
  body: Buffer;
}

/** One source, through the guard, following redirects by hand. */
async function fetchOne(start: URL): Promise<Logo> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let url = start;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!vetUrl(url)) throw new Error(`refused ${url.protocol}//${url.hostname}`);
      const res = await undiciFetch(url, {
        signal: controller.signal,
        redirect: "manual",
        headers: { accept: "image/*" },
        dispatcher: guardedAgent,
      });

      // Followed by hand so the next hop meets the same scheme check this one
      // did — `redirect: "follow"` would happily walk to an http:// URL. The
      // address check needs no help: it is in the dispatcher, so it applies to
      // every hop whether we look at it or not.
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (location) {
        await res.body?.cancel();
        url = new URL(location, url);
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw new Error(`${res.status} from ${url.hostname}`);
      }

      const body = await readCapped(res);
      if (!body) throw new Error(`oversized or empty body from ${url.hostname}`);
      const declared = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      const type = IMAGE_TYPES.has(declared) ? declared : sniffImageType(body);
      if (!type) throw new Error(`not an image (${declared || "no type"}) from ${url.hostname}`);
      return { type, body };
    }
    throw new Error("too many redirects");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch a token's logo from wherever it can be had.
 *
 * Every source goes through the same guard — scheme, address at connect time,
 * redirects, size, type — so an alternate gateway is held to exactly what the
 * original would have been. Throws with every source's reason when none works.
 */
export async function fetchLogo(raw: string): Promise<Logo> {
  const reasons: string[] = [];
  for (const source of sourcesFor(new URL(raw))) {
    try {
      return await fetchOne(source);
    } catch (err) {
      reasons.push(err instanceof Error ? err.message : String(err));
    }
  }
  throw new Error(reasons.join("; "));
}
