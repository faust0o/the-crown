import { useEffect, useMemo, useState } from "react";

/** url -> extracted hex. Module-level so a logo is only sampled once per session. */
const cache = new Map<string, string>();
const pending = new Set<string>();

/** Deterministic fallback when a logo can't be sampled, so lines stay distinct. */
const FALLBACK = [
  "#f7931a", "#627eea", "#14f195", "#f0b90b", "#2a5ada",
  "#e84142", "#c3a634", "#e6007a", "#00c1de", "#3d8130",
];

/**
 * Fallback keyed by the token itself, never by its position.
 *
 * Keying on array index meant every token changed colour whenever the board
 * reordered — which read as the chart redrawing at random and made a hidden
 * line look like it jumped to another series.
 */
export function fallbackColor(symbol: string): string {
  let h = 0;
  for (let i = 0; i < symbol.length; i++) h = (h * 31 + symbol.charCodeAt(i)) >>> 0;
  return FALLBACK[h % FALLBACK.length];
}

/**
 * Dominant colour of a logo.
 *
 * Samples the image into a 16×16 canvas and buckets pixels by hue, ignoring
 * anything transparent or washed out — logos are mostly padding and white, so a
 * naive average returns grey for everything. The most-represented saturated hue
 * is the mark's identity colour.
 *
 * Needs `crossOrigin`: the logos come from arweave/ipfs/github, and reading
 * pixels from a canvas tainted by a cross-origin image throws. Hosts that don't
 * send CORS headers fall back to the palette.
 */
function extract(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onerror = () => resolve(null);
    img.onload = () => {
      try {
        const N = 16;
        const canvas = document.createElement("canvas");
        canvas.width = N;
        canvas.height = N;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) return resolve(null);
        ctx.drawImage(img, 0, 0, N, N);
        const { data } = ctx.getImageData(0, 0, N, N);

        // Bucket by coarse hue; carry summed rgb so we can average the winner.
        const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
          if (a < 200) continue;
          const max = Math.max(r, g, b), min = Math.min(r, g, b);
          const sat = max === 0 ? 0 : (max - min) / max;
          if (sat < 0.25 || max < 40 || (max > 235 && sat < 0.35)) continue;
          const hue = rgbToHue(r, g, b);
          const key = Math.round(hue / 24); // 15 buckets around the wheel
          const cur = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
          cur.n++; cur.r += r; cur.g += g; cur.b += b;
          buckets.set(key, cur);
        }
        let best: { n: number; r: number; g: number; b: number } | null = null;
        for (const v of buckets.values()) if (!best || v.n > best.n) best = v;
        if (!best) return resolve(null);
        resolve(hex(best.r / best.n, best.g / best.n, best.b / best.n));
      } catch {
        resolve(null); // tainted canvas — host sent no CORS headers
      }
    };
    img.src = url;
  });
}

function rgbToHue(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d === 0) return 0;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

const hex = (r: number, g: number, b: number) =>
  "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

/** Logo colour per image URL, filled in as each one is sampled. */
export function useIconColors(urls: (string | null)[]): Map<string, string> {
  const [version, bump] = useState(0);
  // Collapse to a stable string so a new array identity each poll doesn't
  // re-run the effect; the list itself is derived from it below.
  const key = urls.filter(Boolean).join("|");

  useEffect(() => {
    let live = true;
    for (const url of key.split("|")) {
      if (!url || cache.has(url) || pending.has(url)) continue;
      pending.add(url);
      void extract(url).then((color) => {
        pending.delete(url);
        if (!color) return;
        cache.set(url, color);
        if (live) bump((n) => n + 1);
      });
    }
    return () => {
      live = false;
    };
  }, [key]);

  // A fresh identity only when a colour actually lands, so consumers' useMemo
  // recomputes then — returning the module-level Map directly meant the chart
  // kept its placeholder colours until some unrelated change forced a redraw.
  // `cache` is module-level and deliberately not a dependency; `version` and
  // `key` are the signals that its contents changed.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => new Map(cache), [version, key]);
}
