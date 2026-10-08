import { createCanvas, type Canvas, type Image, type SKRSContext2D } from "@napi-rs/canvas";
import { rgb, type Palette, type RGB } from "./palette";

/**
 * The race chart, drawn for the stream.
 *
 * The site's chart is liveline, a React component that needs a browser; the
 * stream is painted on the server, so it draws its own — the same picture by
 * the same rules: each coin's share of the field's volume over the window the
 * server holds, the right edge pinned to now so the lines run on between polls,
 * a dashed guide at each coin's current value, its mark at the line's end, and
 * the left edge faded out.
 *
 * Values and the axis ease toward each new reading instead of jumping, so a
 * two-second poll reads as motion rather than as a slideshow.
 */

export interface ChartLine {
  id: string;
  ticker: string;
  color: RGB;
  image: Image | null;
  /** Milliseconds since the epoch, and share of volume in percent. */
  points: { t: number; v: number }[];
  value: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const ICON = 24;
/** Room right of the plot: the marks, then the value labels. */
const GUTTER = ICON + 16;
const AXIS = 62;
const PAD = { top: 16, bottom: 38, left: 4 };
const FADE = 48;
const EASE_MS = 350;
const MIN_SPAN_MS = 60_000;

const MONO = "JetBrains Mono";
const SANS = "Inter";

/** A round step for about five gridlines: 1, 2, 2.5 or 5 times a power of ten. */
export function niceStep(raw: number): number {
  if (!(raw > 0)) return 1;
  const exp = 10 ** Math.floor(Math.log10(raw));
  const f = raw / exp;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * exp;
}

/**
 * Spread labels so none overlaps another, staying inside [lo, hi]: pushed down
 * in order, then back up from the bottom. Returns the new centres, in input order.
 */
export function spread(ys: number[], gap: number, lo: number, hi: number): number[] {
  const order = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y);
  for (let k = 0; k < order.length; k++) {
    const min = k === 0 ? lo : order[k - 1].y + gap;
    order[k].y = Math.max(order[k].y, min);
  }
  for (let k = order.length - 1; k >= 0; k--) {
    const max = k === order.length - 1 ? hi : order[k + 1].y - gap;
    order[k].y = Math.min(order[k].y, max);
  }
  const out = new Array<number>(ys.length);
  for (const o of order) out[o.i] = o.y;
  return out;
}

const TIME_STEPS_MIN = [1, 2, 5, 10, 15, 30, 60, 120, 240];
const utc = (t: number) =>
  new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });

export class Chart {
  private readonly layer: Canvas;
  private readonly ctx: SKRSContext2D;
  private readonly shown = new Map<string, number>();
  private lo = NaN;
  private hi = NaN;
  private last = 0;

  constructor(readonly rect: Rect) {
    this.layer = createCanvas(rect.w, rect.h);
    this.ctx = this.layer.getContext("2d");
  }

  draw(target: SKRSContext2D, lines: ChartLine[], wall: number, now: number, p: Palette): void {
    const { ctx } = this;
    const { w, h } = this.rect;
    ctx.clearRect(0, 0, w, h);

    const dt = this.last ? Math.min(now - this.last, 250) : 16;
    this.last = now;
    const k = 1 - Math.exp(-dt / EASE_MS);

    const plot = { left: PAD.left, top: PAD.top, right: w - AXIS - GUTTER, bottom: h - PAD.bottom };
    let first = Infinity;
    for (const l of lines) for (const pt of l.points) if (pt.t < first) first = pt.t;
    if (!Number.isFinite(first)) {
      ctx.font = `500 16px ${SANS}`;
      ctx.fillStyle = rgb(p.muted);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("collecting…", w / 2, h / 2);
      target.drawImage(this.layer, this.rect.x, this.rect.y);
      return;
    }
    const span = Math.max(MIN_SPAN_MS, wall - first);
    const t0 = wall - span;
    const x = (t: number) => plot.left + ((t - t0) / span) * (plot.right - plot.left);

    const seen = new Set<string>();
    for (const l of lines) {
      seen.add(l.id);
      const s = this.shown.get(l.id) ?? l.value;
      this.shown.set(l.id, s + (l.value - s) * k);
    }
    for (const id of this.shown.keys()) if (!seen.has(id)) this.shown.delete(id);

    let mn = Infinity;
    let mx = -Infinity;
    for (const l of lines) {
      const s = this.shown.get(l.id)!;
      mn = Math.min(mn, s);
      mx = Math.max(mx, s);
      for (const pt of l.points) {
        if (pt.t < t0) continue;
        mn = Math.min(mn, pt.v);
        mx = Math.max(mx, pt.v);
      }
    }
    const pad = Math.max((mx - mn) * 0.12, 0.5);
    const targetLo = Math.max(0, mn - pad);
    const targetHi = mx + pad;
    this.lo = Number.isNaN(this.lo) ? targetLo : this.lo + (targetLo - this.lo) * k;
    this.hi = Number.isNaN(this.hi) ? targetHi : this.hi + (targetHi - this.hi) * k;
    const { lo, hi } = this;
    const y = (v: number) => plot.bottom - ((v - lo) / (hi - lo)) * (plot.bottom - plot.top);

    // The value axis: faint rules across the plot, figures on the right.
    const step = niceStep((hi - lo) / 5);
    ctx.font = `500 14px ${MONO}`;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
      const yy = Math.round(y(v)) + 0.5;
      ctx.fillStyle = "rgba(255, 255, 255, 0.06)";
      ctx.fillRect(plot.left, yy, plot.right + GUTTER - plot.left, 1);
      ctx.fillStyle = "rgba(255, 255, 255, 0.42)";
      ctx.fillText(`${v.toFixed(1)}%`, w, yy);
    }

    // The time axis, in UTC, at the roundest interval that fits.
    const pxPerMin = (plot.right - plot.left) / (span / 60_000);
    const stepMin = TIME_STEPS_MIN.find((m) => m * pxPerMin >= 130) ?? 240;
    const stepMs = stepMin * 60_000;
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(255, 255, 255, 0.42)";
    for (let t = Math.ceil(t0 / stepMs) * stepMs; t <= wall; t += stepMs) {
      const xx = x(t);
      if (xx < plot.left + 30 || xx > plot.right - 30) continue;
      ctx.fillText(utc(t), xx, plot.bottom + 22);
    }

    // Lines, the leader last so it sits on top.
    const ordered = [...lines].sort((a, b) => this.shown.get(a.id)! - this.shown.get(b.id)!);
    ctx.save();
    ctx.beginPath();
    ctx.rect(plot.left, plot.top - 8, plot.right - plot.left + 2, plot.bottom - plot.top + 16);
    ctx.clip();
    for (const l of ordered) {
      const yNow = y(this.shown.get(l.id)!);
      ctx.setLineDash([2, 5]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = rgb(l.color, 0.3);
      ctx.beginPath();
      ctx.moveTo(plot.left, yNow);
      ctx.lineTo(plot.right, yNow);
      ctx.stroke();
      ctx.setLineDash([]);

      const pts = l.points.filter((pt, i, all) => pt.t >= t0 || all[i + 1]?.t >= t0);
      if (!pts.length) continue;
      const xs = pts.map((pt) => x(pt.t));
      const ys = pts.map((pt) => y(pt.v));
      ctx.beginPath();
      ctx.moveTo(xs[0], ys[0]);
      for (let i = 1; i < pts.length - 1; i++) {
        ctx.quadraticCurveTo(xs[i], ys[i], (xs[i] + xs[i + 1]) / 2, (ys[i] + ys[i + 1]) / 2);
      }
      if (pts.length > 1) ctx.lineTo(xs[pts.length - 1], ys[pts.length - 1]);
      ctx.lineTo(plot.right, yNow);
      ctx.lineWidth = 2.6;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.strokeStyle = rgb(l.color);
      ctx.stroke();
    }
    ctx.restore();

    // Each line's end: a dot on the line and the coin's mark beside it,
    // spread apart where two coins sit at nearly the same share.
    const ends = ordered.map((l) => y(this.shown.get(l.id)!));
    const marks = spread(ends, ICON + 2, plot.top + ICON / 2, plot.bottom - ICON / 2);
    ordered.forEach((l, i) => {
      const yEnd = ends[i];
      const yMark = marks[i];
      const mx = plot.right + 12;
      if (Math.abs(yMark - yEnd) > 2) {
        ctx.strokeStyle = rgb(l.color, 0.5);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(plot.right + 4, yEnd);
        ctx.lineTo(mx - 1, yMark);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(plot.right, yEnd, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = rgb(p.background);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(plot.right, yEnd, 3.2, 0, Math.PI * 2);
      ctx.fillStyle = rgb(l.color);
      ctx.fill();
      this.mark(l, mx, yMark - ICON / 2);
    });

    // Fade the oldest data out at the left, as liveline does.
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    const fade = ctx.createLinearGradient(0, 0, FADE, 0);
    fade.addColorStop(0, "rgba(0, 0, 0, 1)");
    fade.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = fade;
    ctx.fillRect(0, 0, FADE, h);
    ctx.restore();

    target.drawImage(this.layer, this.rect.x, this.rect.y);
  }

  /** The coin's mark on a rounded square, or its initial on its own colour. */
  private mark(l: ChartLine, x: number, y: number): void {
    const { ctx } = this;
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, ICON, ICON, 4);
    ctx.clip();
    if (l.image && l.image.width > 0) {
      const s = Math.min(ICON / l.image.width, ICON / l.image.height);
      const iw = l.image.width * s;
      const ih = l.image.height * s;
      ctx.drawImage(l.image, x + (ICON - iw) / 2, y + (ICON - ih) / 2, iw, ih);
    } else {
      ctx.fillStyle = rgb(l.color);
      ctx.fillRect(x, y, ICON, ICON);
      const luma = 0.299 * l.color[0] + 0.587 * l.color[1] + 0.114 * l.color[2];
      ctx.fillStyle = luma > 150 ? "#111" : "#fff";
      ctx.font = `600 ${Math.round(ICON * 0.55)}px ${SANS}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(l.ticker.slice(0, 1).toUpperCase(), x + ICON / 2, y + ICON / 2 + 1);
    }
    ctx.restore();
  }
}
