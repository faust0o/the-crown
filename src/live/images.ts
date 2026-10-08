import { proxied } from "../casino/crypto/proxied";

/**
 * Coin marks and the crown, ready to draw on the stream's canvas.
 *
 * The canvas is painted thirty times a second, so a mark is asked for on every
 * frame and drawn from whichever frame it has landed by. Everything comes from
 * this origin — logos through /logo — and loads in CORS mode: a canvas that has
 * drawn one cross-origin image is tainted, and a tainted canvas records black.
 */

/** An image, or when it last failed. A broadcast runs for days; a failure is not forever. */
const cache = new Map<string, HTMLImageElement | number>();
const RETRY_MS = 60_000;

export function image(url: string | null | undefined): HTMLImageElement | null {
  if (!url) return null;
  const held = cache.get(url);
  if (typeof held === "number") {
    if (Date.now() - held < RETRY_MS) return null;
  } else if (held) {
    return held.complete && held.naturalWidth > 0 ? held : null;
  }
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.decoding = "async";
  img.onerror = () => cache.set(url, Date.now());
  img.src = url;
  cache.set(url, img);
  return null;
}

/** A coin's logo, by the URL the board gives for it. */
export const coinImage = (imageUrl: string | null | undefined) => image(proxied(imageUrl));
