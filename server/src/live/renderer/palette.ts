import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The stream's colours: the dark theme's tokens, read out of src/index.css.
 *
 * index.css is the source of truth for the palette (see brand.md), and the
 * stream is always the dark object, so the renderer reads that block rather
 * than keeping a copy that could drift. Skia does not parse `oklch()`, so each
 * token is converted to sRGB here; the fallbacks are the same tokens, converted,
 * for a checkout that somehow has no stylesheet.
 */

export type RGB = readonly [number, number, number];

export interface Palette {
  background: RGB;
  foreground: RGB;
  surface: RGB;
  secondary: RGB;
  muted: RGB;
  hairline: RGB;
  up: RGB;
  down: RGB;
  gold: RGB;
  accentInk: RGB;
  panelTop: RGB;
  panelBottom: RGB;
  panelEdge: RGB;
  wellTop: RGB;
  wellBottom: RGB;
  wellEdge: RGB;
  woodHi: RGB;
  woodMid: RGB;
  woodLo: RGB;
}

const TOKENS: Record<keyof Palette, [string, string]> = {
  background: ["--background", "oklch(0.185 0.006 65)"],
  foreground: ["--foreground", "oklch(0.95 0.004 80)"],
  surface: ["--surface", "oklch(0.245 0.007 65)"],
  secondary: ["--text-secondary", "oklch(0.79 0.008 75)"],
  muted: ["--text-muted", "oklch(0.66 0.01 70)"],
  hairline: ["--hairline", "oklch(0.36 0.008 65)"],
  up: ["--up", "oklch(0.74 0.17 150)"],
  down: ["--down", "oklch(0.68 0.19 27)"],
  gold: ["--gold", "oklch(0.82 0.14 92)"],
  accentInk: ["--accent-ink", "oklch(0.8 0.15 62)"],
  panelTop: ["--panel-top", "oklch(0.278 0.007 65)"],
  panelBottom: ["--panel-bottom", "oklch(0.222 0.006 65)"],
  panelEdge: ["--panel-edge", "oklch(0.325 0.008 65)"],
  wellTop: ["--well-top", "oklch(0.132 0.005 65)"],
  wellBottom: ["--well-bottom", "oklch(0.178 0.006 65)"],
  wellEdge: ["--well-edge", "oklch(0.115 0.004 65)"],
  woodHi: ["--wood-hi", "oklch(0.49 0.05 52)"],
  woodMid: ["--wood-mid", "oklch(0.39 0.045 47)"],
  woodLo: ["--wood-lo", "oklch(0.3 0.036 43)"],
};

/** OKLCH → OKLab → linear sRGB → sRGB, clipped to the gamut. */
export function oklchToRgb(l: number, c: number, hue: number): RGB {
  const h = (hue * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
  const encode = (x: number) => {
    const v = Math.min(1, Math.max(0, x));
    return Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));
  };
  return [encode(linear[0]), encode(linear[1]), encode(linear[2])];
}

/** An `oklch(L C H)` value, or null for anything else. The alpha, if any, is not a colour. */
export function parseOklch(value: string): RGB | null {
  const m = value.match(/^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/i);
  return m ? oklchToRgb(Number(m[1]), Number(m[2]), Number(m[3])) : null;
}

/** The custom properties declared in `:root[data-theme="dark"] { … }`, `var()`s resolved. */
export function darkTokens(css: string): Map<string, string> {
  const block = css.match(/:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
  const tokens = new Map<string, string>();
  for (const m of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) tokens.set(m[1], m[2].trim());
  for (const [name, value] of tokens) {
    const ref = value.match(/^var\((--[\w-]+)\)$/)?.[1];
    if (ref && tokens.has(ref)) tokens.set(name, tokens.get(ref)!);
  }
  return tokens;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const STYLESHEET = join(HERE, "../../../../src/index.css");

export function readPalette(path = STYLESHEET): Palette {
  let tokens = new Map<string, string>();
  try {
    tokens = darkTokens(readFileSync(path, "utf8"));
  } catch {
    console.warn(`⚠  live: no stylesheet at ${path}; the stream uses its built-in colours`);
  }
  const out = {} as Record<keyof Palette, RGB>;
  for (const [key, [name, fallback]] of Object.entries(TOKENS) as [keyof Palette, [string, string]][]) {
    out[key] = parseOklch(tokens.get(name) ?? "") ?? parseOklch(fallback)!;
  }
  return out;
}

/** A colour as Skia takes it, see-through if asked. */
export const rgb = (c: RGB, alpha = 1) =>
  alpha >= 1 ? `rgb(${c[0]}, ${c[1]}, ${c[2]})` : `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${alpha})`;
