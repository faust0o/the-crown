// Post-build step: inline the stylesheet, and make the link-preview image
// absolute.
//
// Inlining is what makes a cold load one request to first paint: no
// render-blocking stylesheet, so the first frame the browser paints is already
// the final layout rather than unstyled markup waiting on a second round trip.
//
// Run after `vite build`. Rewrites dist/index.html in place.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DIST = path.join(process.cwd(), "dist");
const INDEX = path.join(DIST, "index.html");

/** Swap every <link rel="stylesheet"> for the stylesheet's contents. */
async function inlineStylesheets(html) {
  const tags = html.match(/<link\b[^>]*rel="stylesheet"[^>]*>/g) ?? [];
  let out = html;
  for (const tag of tags) {
    const href = tag.match(/href="([^"]+)"/)?.[1];
    if (!href?.startsWith("/")) continue;
    const css = await readFile(path.join(DIST, href.slice(1)), "utf8");
    out = out.replace(tag, () => `<style>${css.trim()}</style>`);
  }
  return { html: out, count: tags.length };
}

const kb = (s) => `${(Buffer.byteLength(s) / 1024).toFixed(1)} kB`;

const template = await readFile(INDEX, "utf8");
if (!template.includes('<div id="root"></div>')) {
  throw new Error('prerender: could not find <div id="root"></div> in dist/index.html');
}

const { html: inlined, count } = await inlineStylesheets(template);

/**
 * Link previews are most reliable with absolute URLs; set SITE_ORIGIN at build
 * time (e.g. https://thecrowngame.fun) to emit them. Relative still previews in
 * most scrapers, so an unset origin is a soft downgrade, not a break.
 */
const origin = (process.env.SITE_ORIGIN ?? "").replace(/\/+$/, "");
const out = origin
  ? inlined.replace(
      /((?:property="og:image"|name="twitter:image")\s+content=")\/(?!\/)/g,
      (_m, prefix) => `${prefix}${origin}/`
    )
  : inlined;

await writeFile(INDEX, out);

console.log(
  `prerender: inlined ${count} stylesheet(s) — index.html ${kb(out)}` +
    (origin ? ` (link previews absolute against ${origin})` : " (link previews relative — set SITE_ORIGIN)")
);
