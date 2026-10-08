import { createCanvas, loadImage, type Image } from "@napi-rs/canvas";
import type { RGB } from "./palette";

/**
 * Coin marks for the stream, fetched through this server's own /logo store —
 * the one the site's pages use — and the colour each coin's line is drawn in.
 *
 * A frame is painted thirty times a second, so a mark is asked for on every
 * frame and drawn from whichever frame it has landed by. A broadcast runs for
 * days, so a logo that fails is tried again after a minute rather than never.
 */

const RETRY_MS = 60_000;

interface Held {
  image: Image | null;
  color: RGB | null;
  failedAt: number;
  loading: boolean;
}

const held = new Map<string, Held>();

export class Logos {
  private readonly origin: string;

  constructor(origin: string) {
    this.origin = origin;
  }

  private entry(url: string): Held {
    let h = held.get(url);
    if (!h) {
      h = { image: null, color: null, failedAt: 0, loading: false };
      held.set(url, h);
    }
    if (!h.image && !h.loading && Date.now() - h.failedAt > RETRY_MS) {
      h.loading = true;
      const target = url.startsWith("/") ? `${this.origin}${url}` : `${this.origin}/logo?u=${encodeURIComponent(url)}`;
      fetch(target, { signal: AbortSignal.timeout(10_000) })
        .then(async (res) => {
          if (!res.ok) throw new Error(String(res.status));
          let body = Buffer.from(await res.arrayBuffer());
          if (/svg/i.test(res.headers.get("content-type") ?? "")) {
            body = Buffer.from(inlineSvgClasses(body.toString("utf8")));
          }
          const image = await loadImage(body);
          h!.image = image;
          h!.color = dominantColor(image);
        })
        .catch(() => {
          h!.failedAt = Date.now();
        })
        .finally(() => {
          h!.loading = false;
        });
    }
    return h;
  }

  image(url: string | null | undefined): Image | null {
    return url ? this.entry(url).image : null;
  }

  /** The coin's line colour: its logo's, made legible on the dark ground. */
  color(symbol: string, url: string | null | undefined): RGB {
    const c = url ? this.entry(url).color : null;
    return legibleOnDark(c ?? fallbackColor(symbol));
  }
}

/**
 * Skia draws SVG without CSS, so a logo that colours its shapes through a
 * `<style>` block — `.cls-1{fill:url(#g)}`, which is how most design tools
 * export — comes out black. Simple class rules are copied onto the elements
 * that use them as ordinary attributes, which Skia does read.
 */
export function inlineSvgClasses(svg: string): string {
  const rules = new Map<string, Map<string, string>>();
  for (const block of svg.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
    const css = block[1].replace(/<!\[CDATA\[|\]\]>/g, "");
    for (const rule of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      for (const selector of rule[1].split(",")) {
        const name = selector.trim().match(/^\.([\w-]+)$/)?.[1];
        if (!name) continue;
        const decls = rules.get(name) ?? new Map<string, string>();
        for (const decl of rule[2].split(";")) {
          const colon = decl.indexOf(":");
          const prop = decl.slice(0, colon).trim();
          const value = decl.slice(colon + 1).trim();
          if (colon > 0 && /^[a-z-]+$/.test(prop) && value) decls.set(prop, value.replace(/"/g, "'"));
        }
        rules.set(name, decls);
      }
    }
  }
  if (!rules.size) return svg;
  return svg.replace(
    /<([a-zA-Z][\w:-]*)([^>]*?)\sclass="([^"]*)"([^>]*?)(\/?)>/g,
    (_whole, tag: string, before: string, classes: string, after: string, slash: string) => {
      const attrs = new Map<string, string>();
      for (const c of classes.split(/\s+/)) for (const [k, v] of rules.get(c) ?? []) attrs.set(k, v);
      const own = before + after;
      const added = [...attrs].filter(([k]) => !new RegExp(`\\s${k}=`).test(own)).map(([k, v]) => ` ${k}="${v}"`);
      return `<${tag}${before}${after}${added.join("")}${slash}>`;
    }
  );
}

/** Deterministic, keyed by the token — the site's chart uses the same ten. */
const FALLBACK: RGB[] = [
  [0xf7, 0x93, 0x1a], [0x62, 0x7e, 0xea], [0x14, 0xf1, 0x95], [0xf0, 0xb9, 0x0b], [0x2a, 0x5a, 0xda],
  [0xe8, 0x41, 0x42], [0xc3, 0xa6, 0x34], [0xe6, 0x00, 0x7a], [0x00, 0xc1, 0xde], [0x3d, 0x81, 0x30],
];

export function fallbackColor(symbol: string): RGB {
  let h = 0;
  for (let i = 0; i < symbol.length; i++) h = (h * 31 + symbol.charCodeAt(i)) >>> 0;
  return FALLBACK[h % FALLBACK.length];
}

function rgbToHue(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

/**
 * A logo's identity colour: the most common saturated hue in a 16×16 sample,
 * ignoring transparency and near-white — logos are mostly padding, so a plain
 * average comes out grey. The same method as the site's `useIconColors`.
 */
export function dominantColor(image: Image): RGB | null {
  const N = 16;
  const canvas = createCanvas(N, N);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0, N, N);
  const { data } = ctx.getImageData(0, 0, N, N);
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (data[i + 3] < 200) continue;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const sat = max === 0 ? 0 : (max - min) / max;
    if (sat < 0.25 || max < 40 || (max > 235 && sat < 0.35)) continue;
    const key = Math.round(rgbToHue(r, g, b) / 24);
    const cur = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    cur.n++;
    cur.r += r;
    cur.g += g;
    cur.b += b;
    buckets.set(key, cur);
  }
  let best: { n: number; r: number; g: number; b: number } | null = null;
  for (const v of buckets.values()) if (!best || v.n > best.n) best = v;
  return best ? [Math.round(best.r / best.n), Math.round(best.g / best.n), Math.round(best.b / best.n)] : null;
}

/**
 * A navy or oxblood logo makes a line that vanishes into the dark ground, so
 * dark colours have their lightness inverted, hue and saturation kept, with a
 * floor. The site's chart does the same (`legibleOn`).
 */
export function legibleOnDark([R, G, B]: RGB): RGB {
  const r = R / 255;
  const g = G / 255;
  const b = B / 255;
  if (0.299 * r + 0.587 * g + 0.114 * b >= 0.32) return [R, G, B];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const s = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
  const h = rgbToHue(R, G, B);
  const L = Math.max(1 - l, 0.68);
  const c = (1 - Math.abs(2 * L - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const [r1, g1, b1] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const m = L - c / 2;
  return [Math.round((r1 + m) * 255), Math.round((g1 + m) * 255), Math.round((b1 + m) * 255)];
}
