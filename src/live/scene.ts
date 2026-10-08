import type { Mover } from "../casino/crypto/GameStats";
import type { Standing } from "../casino/crypto/graphql";
import { formatCompact } from "../casino/format";
import { coinImage, image } from "./images";
import type { StreamEntry, StreamRound } from "./queries";

/**
 * The broadcast, drawn.
 *
 * Everything that goes out on the stream is painted here, onto one 1280×720
 * canvas — the page records that canvas and nothing else. The chart is the one
 * borrowed part: liveline draws it on its own canvas, off screen, and the
 * scene copies that in each frame. Its badge and legend are DOM, so they never
 * reach the recording; the field column down the right is what says which line
 * is which.
 *
 * The stream is always the dark object — walnut, anodised aluminium, amber —
 * whatever theme the operator's browser is in, and its colours are the tokens
 * in index.css, read once the page has put itself in the dark theme.
 */

export const WIDTH = 1280;
export const HEIGHT = 720;

const PAD = 32;
const HEADER = 76;
const RAIL = 8;
const STATS_Y = 116;
const RULE_Y = 142;
/** Where the chart is copied to. The stage sizes liveline's canvas to match. */
export const CHART = { x: PAD, y: 158, w: 864, h: 502 };
const FIELD = { x: 928, y: 158, w: WIDTH - PAD - 928, h: 502 };
const FOOT_RULE = 676;
const FOOT_Y = 698;

const SANS = 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';

/** The brand crown, from public/crown-icon.svg, in that file's 32-unit box. */
const CROWN = new Path2D("M5.8 11 11.2 15.6 16 8.6 20.8 15.6 26.2 11 24.3 23.4 7.7 23.4Z");
const CROWN_TIPS: [number, number][] = [
  [5.8, 11],
  [16, 8.6],
  [26.2, 11],
];

/** A round that has just been decided, as the stream announces it. */
export interface Crowning {
  roundId: string;
  symbol: string;
  ticker: string;
  imageUrl: string | null;
  /** Where it stood when the round opened; null for a rehearsal between rounds. */
  startRank: number | null;
  startsAt: string | null;
  endsAt: string | null;
  rehearsal: boolean;
  /** `performance.now()` when the announcement began. */
  at: number;
}

export interface Race {
  field: Standing[];
  entries: ReadonlyMap<string, StreamEntry>;
  movers: Mover[];
  round: StreamRound | null;
  window: string;
}

export interface Frame {
  /** `performance.now()`, for animation. */
  now: number;
  /** `Date.now()`, for the clock. */
  wall: number;
  race: Race;
  crowning: Crowning | null;
  chart: HTMLCanvasElement | null;
  /** Printed in the corner, so a clip that travels says where it came from. */
  host: string;
}

export interface Palette {
  background: string;
  foreground: string;
  surface: string;
  secondary: string;
  muted: string;
  hairline: string;
  up: string;
  down: string;
  gold: string;
  accentInk: string;
  panelTop: string;
  panelBottom: string;
  panelEdge: string;
  wellTop: string;
  wellBottom: string;
  wellEdge: string;
  woodHi: string;
  woodMid: string;
  woodLo: string;
}

/** The dark tokens, as index.css states them; read live so the two cannot drift. */
export function readPalette(): Palette {
  const css = getComputedStyle(document.documentElement);
  const t = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    background: t("--background", "oklch(0.185 0.006 65)"),
    foreground: t("--foreground", "oklch(0.95 0.004 80)"),
    surface: t("--surface", "oklch(0.245 0.007 65)"),
    secondary: t("--text-secondary", "oklch(0.79 0.008 75)"),
    muted: t("--text-muted", "oklch(0.66 0.01 70)"),
    hairline: t("--hairline", "oklch(0.36 0.008 65)"),
    up: t("--up", "oklch(0.74 0.17 150)"),
    down: t("--down", "oklch(0.68 0.19 27)"),
    gold: t("--gold", "oklch(0.82 0.14 92)"),
    accentInk: t("--accent-ink", "oklch(0.8 0.15 62)"),
    panelTop: t("--panel-top", "oklch(0.278 0.007 65)"),
    panelBottom: t("--panel-bottom", "oklch(0.222 0.006 65)"),
    panelEdge: t("--panel-edge", "oklch(0.325 0.008 65)"),
    wellTop: t("--well-top", "oklch(0.132 0.005 65)"),
    wellBottom: t("--well-bottom", "oklch(0.178 0.006 65)"),
    wellEdge: t("--well-edge", "oklch(0.115 0.004 65)"),
    woodHi: t("--wood-hi", "oklch(0.49 0.05 52)"),
    woodMid: t("--wood-mid", "oklch(0.39 0.045 47)"),
    woodLo: t("--wood-lo", "oklch(0.3 0.036 43)"),
  };
}

/** The same colour, see-through. Gradients need it: fading to `transparent` fades through black. */
function fade(color: string, a: number): string {
  const fn = color.match(/^(oklch|oklab|lch|lab)\((.*)\)$/i);
  if (fn && !fn[2].includes("/")) return `${fn[1]}(${fn[2]} / ${a})`;
  if (/^#[0-9a-f]{6}$/i.test(color)) return color + Math.round(a * 255).toString(16).padStart(2, "0");
  return color;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const progress = (t: number, from: number, to: number) => clamp01((t - from) / (to - from));
const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
const easeOutBack = (x: number) => 1 + 2.70158 * (x - 1) ** 3 + 1.70158 * (x - 1) ** 2;

function mmss(ms: number): string {
  if (ms <= 0) return "0:00";
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** UTC: the room watching a stream is in no one timezone, least of all the operator's. */
export const utcTime = (t: string | number) =>
  new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });

function setText(ctx: CanvasRenderingContext2D, font: string, color: string, align: CanvasTextAlign = "left") {
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  ctx.letterSpacing = "0px";
}

/** The engraved caption every section of the app is titled with. Returns its width. */
function caption(
  ctx: CanvasRenderingContext2D,
  p: Palette,
  label: string,
  x: number,
  y: number,
  align: CanvasTextAlign = "left"
): number {
  setText(ctx, `600 12px ${SANS}`, p.muted, align);
  ctx.letterSpacing = "1.4px";
  const text = label.toUpperCase();
  ctx.fillText(text, x, y);
  const w = ctx.measureText(text).width;
  ctx.letterSpacing = "0px";
  return w;
}

/**
 * A coin's mark on its square tile — `CoinIcon`, on canvas. The tile is the
 * foreground a few percent over whatever it sits on, and a mark that will not
 * load is replaced by the ticker on the same tile.
 */
function coin(
  ctx: CanvasRenderingContext2D,
  p: Palette,
  s: { ticker: string; imageUrl: string | null },
  x: number,
  y: number,
  size: number
): void {
  const r = Math.max(2, Math.round(size / 10));
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, size, size, r);
  ctx.globalAlpha *= 0.07;
  ctx.fillStyle = p.foreground;
  ctx.fill();
  ctx.restore();
  mark(ctx, p, s, x, y, size, Math.max(2, Math.round(size * 0.1)), r);
}

function mark(
  ctx: CanvasRenderingContext2D,
  p: Palette,
  s: { ticker: string; imageUrl: string | null },
  x: number,
  y: number,
  size: number,
  pad: number,
  radius: number
): void {
  const img = coinImage(s.imageUrl);
  const box = size - pad * 2;
  if (!img) {
    setText(ctx, `600 ${Math.round(size * 0.34)}px ${SANS}`, p.secondary, "center");
    ctx.fillText(s.ticker.slice(0, 3), x + size / 2, y + size / 2 + 1);
    return;
  }
  // object-contain, so a wide wordmark shrinks to fit rather than overflowing.
  const scale = Math.min(box / img.naturalWidth, box / img.naturalHeight);
  const w = img.naturalWidth * scale;
  const h = img.naturalHeight * scale;
  const ix = x + (size - w) / 2;
  const iy = y + (size - h) / 2;
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(ix, iy, w, h, Math.max(1, radius * (box / size)));
  ctx.clip();
  ctx.drawImage(img, ix, iy, w, h);
  ctx.restore();
}

/**
 * The brand crown in gold, its base centred on (`cx`, `baseY`). The jewels are
 * for the big one, over the winner; at row size they would be noise.
 */
function crown(ctx: CanvasRenderingContext2D, cx: number, baseY: number, width: number, jewels = false): void {
  const s = width / 20.4;
  ctx.save();
  ctx.translate(cx - 16 * s, baseY - 23.4 * s);
  ctx.scale(s, s);
  ctx.lineJoin = "round";
  // Outline first and fill over it, as the icon's `paint-order="stroke"` does,
  // so the outline sits outside the shape and does not eat into it.
  ctx.lineWidth = jewels ? 1.5 : 2;
  ctx.strokeStyle = "#1b1206";
  ctx.stroke(CROWN);
  const g = ctx.createLinearGradient(0, 8.6, 0, 23.4);
  g.addColorStop(0, "#ffe7a3");
  g.addColorStop(0.45, "#f4c04e");
  g.addColorStop(1, "#d0731f");
  ctx.fillStyle = g;
  ctx.fill(CROWN);
  if (jewels) {
    ctx.save();
    ctx.clip(CROWN);
    ctx.fillStyle = "rgba(154, 52, 18, 0.5)";
    ctx.fillRect(0, 20.3, 32, 3.2);
    ctx.restore();
    for (const [jx, jy] of CROWN_TIPS) {
      ctx.beginPath();
      ctx.arc(jx, jy, 1.2, 0, Math.PI * 2);
      ctx.lineWidth = 0.8;
      ctx.stroke();
      ctx.fillStyle = "#fff4cc";
      ctx.fill();
    }
  }
  ctx.restore();
}

function clockOf(round: StreamRound | null, wall: number): { label: string; value: string } {
  if (!round) return { label: "Next round", value: "–:––" };
  const lock = Date.parse(round.lockAt);
  const end = Date.parse(round.endsAt);
  if (round.status === "OPEN" && lock > wall) return { label: "Betting closes in", value: mmss(lock - wall) };
  if (round.status === "OPEN" || round.status === "LOCKED") {
    return { label: "The cut lands within", value: mmss(end - wall) };
  }
  return { label: "Next round in", value: mmss(end - wall) };
}

function paintHeader(ctx: CanvasRenderingContext2D, f: Frame, p: Palette): void {
  const face = ctx.createLinearGradient(0, 0, 0, HEADER);
  face.addColorStop(0, p.panelTop);
  face.addColorStop(1, p.panelBottom);
  ctx.fillStyle = face;
  ctx.fillRect(0, 0, WIDTH, HEADER);
  ctx.fillStyle = p.panelEdge;
  ctx.fillRect(0, HEADER - 1, WIDTH, 1);

  // The walnut rail under the header, with its routed groove.
  const wood = ctx.createLinearGradient(0, HEADER, 0, HEADER + RAIL);
  wood.addColorStop(0, p.woodHi);
  wood.addColorStop(0.5, p.woodMid);
  wood.addColorStop(1, p.woodLo);
  ctx.fillStyle = wood;
  ctx.fillRect(0, HEADER, WIDTH, RAIL);
  ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
  ctx.fillRect(0, HEADER + RAIL / 2 - 0.5, WIDTH, 1);

  const icon = image("/crown-icon.svg");
  if (icon) ctx.drawImage(icon, PAD, 18, 40, 40);
  setText(ctx, `600 26px ${SANS}`, p.foreground);
  ctx.fillText("The Crown", PAD + 54, 39);

  // The clock, cut into the face — the one genuine display in the chrome.
  const clock = clockOf(f.race.round, f.wall);
  const wellW = 132;
  const wellX = WIDTH - PAD - wellW;
  const well = ctx.createLinearGradient(0, 15, 0, 61);
  well.addColorStop(0, p.wellTop);
  well.addColorStop(1, p.wellBottom);
  ctx.beginPath();
  ctx.roundRect(wellX, 15, wellW, 46, 6);
  ctx.fillStyle = well;
  ctx.fill();
  ctx.strokeStyle = p.wellEdge;
  ctx.lineWidth = 1;
  ctx.stroke();
  setText(ctx, `500 30px ${MONO}`, p.foreground, "center");
  ctx.fillText(clock.value, wellX + wellW / 2, 39);
  const labelW = caption(ctx, p, clock.label, wellX - 16, 39, "right");

  // Who is wearing the crown into this round, left of the clock.
  const holder = f.race.round?.crownSymbol;
  if (!holder) return;
  const s = f.race.field.find((x) => x.symbol === holder) ?? f.race.entries.get(holder);
  if (!s) return;
  const right = wellX - 16 - labelW - 44;
  setText(ctx, `600 20px ${SANS}`, p.foreground, "right");
  ctx.fillText(s.ticker, right, 39);
  const tickerW = ctx.measureText(s.ticker).width;
  const iconX = right - tickerW - 10 - 30;
  coin(ctx, p, s, iconX, 24, 30);
  crown(ctx, iconX + 15, 22, 18);
  caption(ctx, p, "Wearing the crown", iconX - 12, 39, "right");
}

/** The round in three figures — `GameStats`, at broadcast size. */
function paintStats(ctx: CanvasRenderingContext2D, f: Frame, p: Palette): void {
  const movers = f.race.movers;
  const moved = (m: Mover) => m.from - m.to;
  const total = movers.reduce((n, m) => n + m.volume, 0);
  const climber = movers.reduce<Mover | null>((best, m) => (moved(m) > (best ? moved(best) : 0) ? m : best), null);
  const loser = movers.reduce<Mover | null>((worst, m) => (moved(m) < (worst ? moved(worst) : 0) ? m : worst), null);

  let x = PAD;
  x += caption(ctx, p, "Total volume", x, STATS_Y) + 12;
  setText(ctx, `500 20px ${MONO}`, p.foreground);
  ctx.fillText(`$${formatCompact(total)}`, x, STATS_Y);
  x += ctx.measureText(`$${formatCompact(total)}`).width + 44;

  for (const [label, m] of [
    ["Biggest climber", climber],
    ["Biggest loser", loser],
  ] as const) {
    x += caption(ctx, p, label, x, STATS_Y) + 12;
    if (!m) {
      setText(ctx, `500 20px ${MONO}`, p.muted);
      ctx.fillText("—", x, STATS_Y);
      x += 20 + 44;
      continue;
    }
    coin(ctx, p, m, x, STATS_Y - 12, 24);
    x += 32;
    setText(ctx, `600 19px ${SANS}`, p.foreground);
    ctx.fillText(m.ticker, x, STATS_Y);
    x += ctx.measureText(m.ticker).width + 8;
    const d = moved(m);
    setText(ctx, `500 18px ${MONO}`, d > 0 ? p.up : p.down);
    const delta = `${d > 0 ? "▲" : "▼"} ${Math.abs(d)}`;
    ctx.fillText(delta, x, STATS_Y);
    x += ctx.measureText(delta).width + 44;
  }

  caption(ctx, p, `Share of trailing ${f.race.window} volume`, WIDTH - PAD, STATS_Y, "right");
  ctx.fillStyle = p.hairline;
  ctx.fillRect(PAD, RULE_Y, WIDTH - PAD * 2, 1);
}

function paintChart(ctx: CanvasRenderingContext2D, f: Frame, p: Palette): void {
  if (f.chart && f.chart.width > 0 && f.chart.height > 0) {
    ctx.drawImage(f.chart, CHART.x, CHART.y, CHART.w, CHART.h);
    return;
  }
  setText(ctx, `500 16px ${SANS}`, p.muted, "center");
  ctx.fillText("collecting…", CHART.x + CHART.w / 2, CHART.y + CHART.h / 2);
}

/** The board, down the right: the legend the chart cannot carry. */
function paintField(ctx: CanvasRenderingContext2D, f: Frame, p: Palette): void {
  const { field, entries, round } = f.race;
  caption(ctx, p, "The field", FIELD.x, FIELD.y + 8);
  caption(ctx, p, "Share", FIELD.x + FIELD.w, FIELD.y + 8, "right");
  ctx.fillStyle = p.hairline;
  ctx.fillRect(FIELD.x, FIELD.y + 22, FIELD.w, 1);

  const rows = field.slice(0, 12);
  const top = FIELD.y + 28;
  const rowH = Math.min(46, (FIELD.y + FIELD.h - top) / Math.max(rows.length, 1));
  const total = field.reduce((n, s) => n + s.quoteVolume, 0);

  rows.forEach((s, i) => {
    const y = top + i * rowH;
    const cy = y + rowH / 2;
    // The coin standing first is the one the cut would crown.
    if (s.rank === 1) {
      ctx.fillStyle = fade(p.gold, 0.1);
      ctx.fillRect(FIELD.x, y + 1, FIELD.w, rowH - 2);
      ctx.fillStyle = p.gold;
      ctx.fillRect(FIELD.x, y + 1, 3, rowH - 2);
    }
    setText(ctx, `500 15px ${MONO}`, p.muted, "right");
    ctx.fillText(String(s.rank), FIELD.x + 30, cy);
    const iconSize = Math.min(28, rowH - 10);
    coin(ctx, p, s, FIELD.x + 40, cy - iconSize / 2, iconSize);

    let tx = FIELD.x + 40 + iconSize + 10;
    setText(ctx, `600 18px ${SANS}`, p.foreground);
    ctx.fillText(s.ticker, tx, cy);
    tx += ctx.measureText(s.ticker).width + 8;
    if (round?.crownSymbol === s.symbol) crown(ctx, tx + 9, cy + 6, 18);
    else if (entries.size && !entries.has(s.symbol)) {
      setText(ctx, `600 10px ${SANS}`, p.muted);
      ctx.letterSpacing = "1px";
      ctx.fillText("NEXT ROUND", tx, cy + 1);
      ctx.letterSpacing = "0px";
    }

    const entry = entries.get(s.symbol);
    const d = entry ? entry.startRank - s.rank : 0;
    if (d !== 0) {
      setText(ctx, `500 14px ${MONO}`, d > 0 ? p.up : p.down, "right");
      ctx.fillText(`${d > 0 ? "▲" : "▼"}${Math.abs(d)}`, FIELD.x + FIELD.w - 74, cy);
    }
    setText(ctx, `500 17px ${MONO}`, p.foreground, "right");
    ctx.fillText(total > 0 ? `${((100 * s.quoteVolume) / total).toFixed(1)}%` : "—", FIELD.x + FIELD.w, cy);

    if (i < rows.length - 1) {
      ctx.fillStyle = "rgba(0, 0, 0, 0.4)";
      ctx.fillRect(FIELD.x, y + rowH - 0.5, FIELD.w, 1);
    }
  });
}

function paintFooter(ctx: CanvasRenderingContext2D, f: Frame, p: Palette): void {
  ctx.fillStyle = p.hairline;
  ctx.fillRect(PAD, FOOT_RULE, WIDTH - PAD * 2, 1);
  setText(ctx, `400 15px ${SANS}`, p.secondary);
  ctx.fillText(
    "Ten coins race on volume. Back where each one's rank lands at the cut: higher, same or lower.",
    PAD,
    FOOT_Y
  );
  setText(ctx, `600 18px ${SANS}`, p.accentInk, "right");
  ctx.fillText(f.host, WIDTH - PAD, FOOT_Y);
}

/**
 * How long the crown takes: the chart fades out, the winner arrives and is held,
 * and the chart comes back. Times are milliseconds from the announcement.
 */
export const CROWNING_MS = 14_400;

function crowningAlphas(t: number): { content: number; overlay: number } {
  return {
    content: t < 13_400 ? 1 - easeInOut(progress(t, 0, 900)) : easeInOut(progress(t, 13_400, CROWNING_MS)),
    overlay: easeInOut(progress(t, 500, 1_300)) * (1 - easeInOut(progress(t, 13_000, 13_800))),
  };
}

/** "X took the crown": the winner's mark on its tile, the crown set on top of it. */
function paintCrowning(ctx: CanvasRenderingContext2D, f: Frame, p: Palette, t: number, alpha: number): void {
  const c = f.crowning!;
  const cx = WIDTH / 2;
  const size = 176;
  const tileY = 262;
  const glowY = tileY + size / 2 - 20;

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, HEADER + RAIL, WIDTH, FOOT_RULE - HEADER - RAIL);
  ctx.clip();
  ctx.globalAlpha = alpha;

  const glow = ctx.createRadialGradient(cx, glowY, 0, cx, glowY, 430);
  glow.addColorStop(0, fade(p.gold, 0.26));
  glow.addColorStop(1, fade(p.gold, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // Slow rays behind the tile.
  ctx.save();
  ctx.translate(cx, glowY);
  ctx.rotate(t / 9_000);
  const rays = ctx.createRadialGradient(0, 0, 80, 0, 0, 620);
  rays.addColorStop(0, fade(p.gold, 0.12));
  rays.addColorStop(1, fade(p.gold, 0));
  ctx.fillStyle = rays;
  for (let i = 0; i < 16; i++) {
    ctx.rotate((Math.PI * 2) / 16);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, 640, -0.05, 0.05);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();

  // The tile: lifted off the page, rimmed in gold.
  const tileIn = easeOutBack(progress(t, 500, 1_300));
  ctx.save();
  ctx.translate(cx, tileY + size / 2);
  ctx.scale(0.82 + 0.18 * tileIn, 0.82 + 0.18 * tileIn);
  const half = size / 2;
  const radius = 18;
  ctx.save();
  ctx.shadowColor = "rgba(0, 0, 0, 0.6)";
  ctx.shadowBlur = 40;
  ctx.shadowOffsetY = 14;
  const face = ctx.createLinearGradient(0, -half, 0, half);
  face.addColorStop(0, p.panelTop);
  face.addColorStop(1, p.panelBottom);
  ctx.beginPath();
  ctx.roundRect(-half, -half, size, size, radius);
  ctx.fillStyle = face;
  ctx.fill();
  ctx.restore();
  ctx.lineWidth = 3;
  ctx.strokeStyle = p.gold;
  ctx.stroke();
  mark(ctx, p, c, -half, -half, size, Math.round(size * 0.14), radius);
  ctx.restore();

  // Twinkles around it.
  for (let i = 0; i < 7; i++) {
    const angle = -Math.PI / 2 + (i - 3) * 0.55 + (i % 2 ? 0.2 : -0.1);
    const dist = 150 + (i % 3) * 22;
    const sx = cx + Math.cos(angle) * dist * 1.25;
    const sy = glowY + Math.sin(angle) * dist * 0.9 + 40;
    const tw = 0.5 + 0.5 * Math.sin(t / 380 + i * 1.7);
    const r = 3 + 4 * tw;
    ctx.save();
    ctx.globalAlpha = alpha * progress(t, 1_600, 2_400) * (0.35 + 0.65 * tw);
    ctx.translate(sx, sy);
    ctx.fillStyle = i % 3 ? p.gold : "#fff6d6";
    ctx.beginPath();
    ctx.moveTo(0, -r * 2);
    ctx.quadraticCurveTo(0, 0, r * 2, 0);
    ctx.quadraticCurveTo(0, 0, 0, r * 2);
    ctx.quadraticCurveTo(0, 0, -r * 2, 0);
    ctx.quadraticCurveTo(0, 0, 0, -r * 2);
    ctx.fill();
    ctx.restore();
  }

  // The crown drops onto the tile and settles at a tilt.
  const drop = progress(t, 1_100, 1_900);
  ctx.save();
  ctx.globalAlpha = alpha * progress(t, 1_100, 1_400);
  const baseY = tileY + 24 - (1 - easeOutBack(drop)) * 90;
  ctx.translate(cx, baseY);
  ctx.rotate(-0.1 + 0.14 * (1 - easeOutBack(drop)));
  crown(ctx, 0, 0, 132, true);
  ctx.restore();

  const textIn = easeInOut(progress(t, 1_700, 2_500));
  ctx.globalAlpha = alpha * textIn;
  const lineY = tileY + size + 66 - (1 - textIn) * 14;
  const rest = " took the crown";
  setText(ctx, `700 60px ${SANS}`, p.foreground);
  const tw = ctx.measureText(c.ticker).width;
  setText(ctx, `500 60px ${SANS}`, p.secondary);
  const rw = ctx.measureText(rest).width;
  const left = cx - (tw + rw) / 2;
  setText(ctx, `700 60px ${SANS}`, p.foreground);
  ctx.fillText(c.ticker, left, lineY);
  setText(ctx, `500 60px ${SANS}`, p.secondary);
  ctx.fillText(rest, left + tw, lineY);

  const detail = c.rehearsal
    ? "Rehearsal — nothing has been decided"
    : [
        c.startRank == null
          ? null
          : c.startRank === 1
            ? "Opened first, finished first"
            : `Up from rank ${c.startRank} at the open`,
        c.startsAt && c.endsAt ? `round ${utcTime(c.startsAt)}–${utcTime(c.endsAt)} UTC` : null,
      ]
        .filter(Boolean)
        .join(" · ");
  setText(ctx, `500 21px ${MONO}`, p.muted, "center");
  ctx.fillText(detail, cx, lineY + 54);
  ctx.restore();
}

export function paintScene(ctx: CanvasRenderingContext2D, f: Frame, p: Palette): void {
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.fillStyle = p.background;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  // A little light on the middle of the case, as there is in a room.
  const light = ctx.createRadialGradient(WIDTH / 2, HEIGHT * 0.55, 0, WIDTH / 2, HEIGHT * 0.55, WIDTH * 0.7);
  light.addColorStop(0, fade(p.surface, 0.55));
  light.addColorStop(1, fade(p.surface, 0));
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  const t = f.crowning ? f.now - f.crowning.at : Infinity;
  const { content, overlay } =
    t >= 0 && t < CROWNING_MS ? crowningAlphas(t) : { content: 1, overlay: 0 };

  if (content > 0.001) {
    ctx.save();
    ctx.globalAlpha = content;
    paintStats(ctx, f, p);
    paintChart(ctx, f, p);
    paintField(ctx, f, p);
    ctx.restore();
  }
  if (overlay > 0.001) paintCrowning(ctx, f, p, t, overlay);
  paintHeader(ctx, f, p);
  paintFooter(ctx, f, p);
  ctx.restore();
}
