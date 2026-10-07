import { fallbackColor } from "./useIconColors";

/** Side of the backing canvas: 3x the 14px liveline draws it at, so it stays sharp on any screen. */
const PX = 42;

/** symbol|url -> canvas. Module-level so a logo is only fetched once per session. */
const cache = new Map<string, HTMLCanvasElement>();

/**
 * A coin's mark, ready for liveline to stamp at the end of its line.
 *
 * A canvas rather than the <img> itself: liveline draws every frame, so the
 * canvas can start blank and fill in whenever the logo lands without the chart
 * having to re-render — and if the logo never lands, the same canvas takes a
 * lettered disc instead, the way `CoinIcon` falls back in the rows.
 */
export function lineIcon(symbol: string, ticker: string, url: string | null): HTMLCanvasElement {
  const key = `${symbol}|${url ?? ""}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const canvas = document.createElement("canvas");
  canvas.width = PX;
  canvas.height = PX;
  cache.set(key, canvas);

  if (!url) {
    drawFallback(canvas, symbol, ticker);
    return canvas;
  }
  const img = new Image();
  // Same mode as `useIconColors`, so the two share one cached response.
  img.crossOrigin = "anonymous";
  img.onload = () => drawLogo(canvas, img);
  img.onerror = () => drawFallback(canvas, symbol, ticker);
  img.src = url;
  return canvas;
}

function drawLogo(canvas: HTMLCanvasElement, img: HTMLImageElement) {
  const ctx = canvas.getContext("2d");
  if (!ctx || !img.naturalWidth || !img.naturalHeight) return;
  // object-contain, so a wide wordmark shrinks to fit rather than overflowing
  // into its neighbour's line.
  const scale = Math.min(PX / img.naturalWidth, PX / img.naturalHeight);
  const w = img.naturalWidth * scale;
  const h = img.naturalHeight * scale;
  ctx.beginPath();
  ctx.roundRect(0, 0, PX, PX, 3);
  ctx.clip();
  ctx.drawImage(img, (PX - w) / 2, (PX - h) / 2, w, h);
}

/**
 * One letter on the line's own colour. A logo that fails here failed in
 * `useIconColors` too, so its line is drawn in `fallbackColor` as well.
 */
function drawFallback(canvas: HTMLCanvasElement, symbol: string, ticker: string) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const color = fallbackColor(symbol);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(PX / 2, PX / 2, PX / 2, 0, Math.PI * 2);
  ctx.fill();

  // Dark or light letter, whichever the disc's luma can carry.
  const n = parseInt(color.slice(1), 16);
  const luma = 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 0xff) + 0.114 * (n & 0xff);
  ctx.fillStyle = luma > 150 ? "#111" : "#fff";
  ctx.font = `600 ${PX * 0.55}px -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(ticker.slice(0, 1).toUpperCase(), PX / 2, PX / 2 + PX * 0.03);
}
