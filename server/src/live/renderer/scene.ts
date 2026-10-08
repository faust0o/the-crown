import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GlobalFonts, Path2D, type Image, type SKRSContext2D } from "@napi-rs/canvas";
import type { Crowning, Mover, Race, Round } from "./board";
import { Chart, type ChartLine } from "./chart";
import type { Logos } from "./images";
import { rgb, type Palette, type RGB } from "./palette";

/**
 * The broadcast, drawn: one 1280×720 frame, thirty times a second.
 *
 * The case of the instrument — walnut rail, machined header, the clock cut into
 * it — then the round in three figures, the chart, and the field down the right
 * as the chart's legend. When a round is decided, everything below the header
 * fades out and the winner takes the crown in the middle of the screen.
 *
 * The stream is always the dark object, whatever theme anybody's browser is in.
 */

type Align = "left" | "right" | "center";

export const WIDTH = 1280;
export const HEIGHT = 720;

const PAD = 32;
const HEADER = 76;
const RAIL = 8;
const STATS_Y = 116;
const RULE_Y = 142;
const CHART = { x: PAD, y: 158, w: 864, h: 502 };
const FIELD = { x: 928, y: 158, w: WIDTH - PAD - 928, h: 502 };
const FOOT_RULE = 676;
const FOOT_Y = 698;

const FONTS = join(fileURLToPath(new URL(".", import.meta.url)), "../../../assets/fonts");
for (const file of ["Inter-Regular", "Inter-Medium", "Inter-SemiBold", "Inter-Bold"]) {
  GlobalFonts.registerFromPath(join(FONTS, `${file}.ttf`), "Inter");
}
for (const file of ["JetBrainsMono-Regular", "JetBrainsMono-Medium"]) {
  GlobalFonts.registerFromPath(join(FONTS, `${file}.ttf`), "JetBrains Mono");
}
const SANS = "Inter";
const MONO = "JetBrains Mono";

/** The brand crown, from public/crown-icon.svg, in that file's 32-unit box. */
const CROWN = new Path2D("M5.8 11 11.2 15.6 16 8.6 20.8 15.6 26.2 11 24.3 23.4 7.7 23.4Z");
const CROWN_TIPS: [number, number][] = [
  [5.8, 11],
  [16, 8.6],
  [26.2, 11],
];

/** How long the crown takes, in milliseconds from the announcement. */
export const CROWNING_MS = 14_400;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const progress = (t: number, from: number, to: number) => clamp01((t - from) / (to - from));
const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
const easeOutBack = (x: number) => 1 + 2.70158 * (x - 1) ** 3 + 1.70158 * (x - 1) ** 2;

function mmss(ms: number): string {
  if (ms <= 0) return "0:00";
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** UTC: the room watching a stream is in no one timezone. */
const utcTime = (t: string | number) =>
  new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });

/** 27_460_609 → "27.46M", as the site's `formatCompact` writes it. */
export function compact(n: number): string {
  for (const [at, unit] of [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ] as const) {
    if (Math.abs(n) >= at) {
      const v = n / at;
      return `${v.toFixed(Math.abs(v) >= 100 ? 0 : 2).replace(/\.?0+$/, "")}${unit}`;
    }
  }
  return Math.round(n).toString();
}

function clockOf(round: Round | null, wall: number): { label: string; value: string } {
  if (!round) return { label: "Next round", value: "–:––" };
  const lock = Date.parse(round.lockAt);
  const end = Date.parse(round.endsAt);
  if (round.status === "OPEN" && lock > wall) return { label: "Betting closes in", value: mmss(lock - wall) };
  if (round.status === "OPEN" || round.status === "LOCKED") {
    return { label: "The cut lands within", value: mmss(end - wall) };
  }
  return { label: "Next round in", value: mmss(end - wall) };
}

export class Scene {
  private readonly p: Palette;
  private readonly logos: Logos;
  private readonly chart = new Chart(CHART);
  private readonly host: string;
  private crownIcon: Image | null = null;
  private lines: { race: Race | null; lines: ChartLine[] } = { race: null, lines: [] };

  constructor(palette: Palette, logos: Logos, host: string, crownIcon: Image | null) {
    this.p = palette;
    this.logos = logos;
    this.host = host;
    this.crownIcon = crownIcon;
  }

  paint(ctx: SKRSContext2D, race: Race, crowning: Crowning | null, wall: number, now: number): void {
    const { p } = this;
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.fillStyle = rgb(p.background);
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    // A little light on the middle of the case, as there is in a room.
    const light = ctx.createRadialGradient(WIDTH / 2, HEIGHT * 0.55, 0, WIDTH / 2, HEIGHT * 0.55, WIDTH * 0.7);
    light.addColorStop(0, rgb(p.surface, 0.55));
    light.addColorStop(1, rgb(p.surface, 0));
    ctx.fillStyle = light;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    const t = crowning ? now - crowning.at : Infinity;
    const active = t >= 0 && t < CROWNING_MS;
    const content = active
      ? t < 13_400
        ? 1 - easeInOut(progress(t, 0, 900))
        : easeInOut(progress(t, 13_400, CROWNING_MS))
      : 1;
    const overlay = active ? easeInOut(progress(t, 500, 1_300)) * (1 - easeInOut(progress(t, 13_000, 13_800))) : 0;

    if (content > 0.001) {
      ctx.save();
      ctx.globalAlpha = content;
      this.stats(ctx, race);
      this.chart.draw(ctx, this.chartLines(race), wall, now, p);
      this.field(ctx, race);
      ctx.restore();
    }
    if (overlay > 0.001) this.crowning(ctx, crowning!, t, overlay);
    this.header(ctx, race, wall);
    this.footer(ctx);
    ctx.restore();
  }

  /**
   * Each coin's share of the field's volume at every sample, and now — the
   * site's chart plots the same (see `raceSeries`). Rebuilt once per poll.
   */
  private chartLines(race: Race): ChartLine[] {
    if (this.lines.race === race) {
      // The marks and colours land after the data does; pick them up.
      for (const l of this.lines.lines) {
        const s = race.field.find((f) => f.symbol === l.id);
        l.image = this.logos.image(s?.imageUrl);
        l.color = this.logos.color(l.id, s?.imageUrl);
      }
      return this.lines.lines;
    }
    const totalAt = new Map<number, number>();
    for (const pt of race.history) totalAt.set(pt.t, (totalAt.get(pt.t) ?? 0) + pt.quoteVolume);
    const bySymbol = new Map<string, { t: number; v: number }[]>();
    for (const pt of race.history) {
      const total = totalAt.get(pt.t) ?? 0;
      if (!bySymbol.has(pt.symbol)) bySymbol.set(pt.symbol, []);
      bySymbol.get(pt.symbol)!.push({ t: pt.t, v: total > 0 ? (100 * pt.quoteVolume) / total : 0 });
    }
    const liveTotal = race.field.reduce((n, s) => n + s.quoteVolume, 0);
    const lines = race.field
      .filter((s) => bySymbol.has(s.symbol))
      .map(
        (s): ChartLine => ({
          id: s.symbol,
          ticker: s.ticker,
          color: this.logos.color(s.symbol, s.imageUrl),
          image: this.logos.image(s.imageUrl),
          points: bySymbol.get(s.symbol)!.sort((a, b) => a.t - b.t),
          value: liveTotal > 0 ? (100 * s.quoteVolume) / liveTotal : 0,
        })
      );
    this.lines = { race, lines };
    return lines;
  }

  private text(ctx: SKRSContext2D, font: string, color: RGB, align: Align = "left") {
    ctx.font = font;
    ctx.fillStyle = rgb(color);
    ctx.textAlign = align;
    ctx.textBaseline = "middle";
    ctx.letterSpacing = "0px";
  }

  /** The engraved caption every section of the app is titled with. Returns its width. */
  private caption(ctx: SKRSContext2D, label: string, x: number, y: number, align: Align = "left"): number {
    this.text(ctx, `600 12px ${SANS}`, this.p.muted, align);
    ctx.letterSpacing = "1.4px";
    const upper = label.toUpperCase();
    ctx.fillText(upper, x, y);
    const w = ctx.measureText(upper).width;
    ctx.letterSpacing = "0px";
    return w;
  }

  /** A coin's mark on its square tile — `CoinIcon`, on canvas. */
  private coin(ctx: SKRSContext2D, s: { ticker: string; imageUrl: string | null }, x: number, y: number, size: number) {
    const r = Math.max(2, Math.round(size / 10));
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, size, size, r);
    ctx.globalAlpha *= 0.07;
    ctx.fillStyle = rgb(this.p.foreground);
    ctx.fill();
    ctx.restore();
    this.mark(ctx, s, x, y, size, Math.max(2, Math.round(size * 0.1)), r);
  }

  private mark(
    ctx: SKRSContext2D,
    s: { ticker: string; imageUrl: string | null },
    x: number,
    y: number,
    size: number,
    pad: number,
    radius: number
  ) {
    const img = this.logos.image(s.imageUrl);
    if (!img || !img.width) {
      this.text(ctx, `600 ${Math.round(size * 0.34)}px ${SANS}`, this.p.secondary, "center");
      ctx.fillText(s.ticker.slice(0, 3), x + size / 2, y + size / 2 + 1);
      return;
    }
    const box = size - pad * 2;
    const scale = Math.min(box / img.width, box / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    const ix = x + (size - w) / 2;
    const iy = y + (size - h) / 2;
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(ix, iy, w, h, Math.max(1, radius * (box / size)));
    ctx.clip();
    ctx.drawImage(img, ix, iy, w, h);
    ctx.restore();
  }

  /** The brand crown in gold, its base centred on (`cx`, `baseY`). */
  private crown(ctx: SKRSContext2D, cx: number, baseY: number, width: number, jewels = false) {
    const s = width / 20.4;
    ctx.save();
    ctx.translate(cx - 16 * s, baseY - 23.4 * s);
    ctx.scale(s, s);
    const path = CROWN;
    ctx.lineJoin = "round";
    // Outline first and fill over it, as the icon's `paint-order="stroke"` does.
    ctx.lineWidth = jewels ? 1.5 : 2;
    ctx.strokeStyle = "#1b1206";
    ctx.stroke(path);
    const g = ctx.createLinearGradient(0, 8.6, 0, 23.4);
    g.addColorStop(0, "#ffe7a3");
    g.addColorStop(0.45, "#f4c04e");
    g.addColorStop(1, "#d0731f");
    ctx.fillStyle = g;
    ctx.fill(path);
    if (jewels) {
      ctx.save();
      ctx.clip(path);
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

  private header(ctx: SKRSContext2D, race: Race, wall: number) {
    const { p } = this;
    const face = ctx.createLinearGradient(0, 0, 0, HEADER);
    face.addColorStop(0, rgb(p.panelTop));
    face.addColorStop(1, rgb(p.panelBottom));
    ctx.fillStyle = face;
    ctx.fillRect(0, 0, WIDTH, HEADER);
    ctx.fillStyle = rgb(p.panelEdge);
    ctx.fillRect(0, HEADER - 1, WIDTH, 1);

    // The walnut rail under the header, with its routed groove.
    const wood = ctx.createLinearGradient(0, HEADER, 0, HEADER + RAIL);
    wood.addColorStop(0, rgb(p.woodHi));
    wood.addColorStop(0.5, rgb(p.woodMid));
    wood.addColorStop(1, rgb(p.woodLo));
    ctx.fillStyle = wood;
    ctx.fillRect(0, HEADER, WIDTH, RAIL);
    ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
    ctx.fillRect(0, HEADER + RAIL / 2 - 0.5, WIDTH, 1);

    if (this.crownIcon) ctx.drawImage(this.crownIcon, PAD, 18, 40, 40);
    this.text(ctx, `600 26px ${SANS}`, p.foreground);
    ctx.fillText("The Crown", PAD + 54, 39);

    // The clock, cut into the face — the one genuine display in the chrome.
    const clock = clockOf(race.round, wall);
    const wellW = 132;
    const wellX = WIDTH - PAD - wellW;
    const well = ctx.createLinearGradient(0, 15, 0, 61);
    well.addColorStop(0, rgb(p.wellTop));
    well.addColorStop(1, rgb(p.wellBottom));
    ctx.beginPath();
    ctx.roundRect(wellX, 15, wellW, 46, 6);
    ctx.fillStyle = well;
    ctx.fill();
    ctx.strokeStyle = rgb(p.wellEdge);
    ctx.lineWidth = 1;
    ctx.stroke();
    this.text(ctx, `500 30px ${MONO}`, p.foreground, "center");
    ctx.fillText(clock.value, wellX + wellW / 2, 39);
    const labelW = this.caption(ctx, clock.label, wellX - 16, 39, "right");

    // Who is wearing the crown into this round.
    const holder = race.round?.crownSymbol;
    if (!holder) return;
    const s = race.field.find((x) => x.symbol === holder) ?? race.entries.get(holder);
    if (!s) return;
    const right = wellX - 16 - labelW - 44;
    this.text(ctx, `600 20px ${SANS}`, p.foreground, "right");
    ctx.fillText(s.ticker, right, 39);
    const iconX = right - ctx.measureText(s.ticker).width - 10 - 30;
    this.coin(ctx, s, iconX, 24, 30);
    this.crown(ctx, iconX + 15, 22, 18);
    this.caption(ctx, "Wearing the crown", iconX - 12, 39, "right");
  }

  /** The round in three figures — `GameStats`, at broadcast size. */
  private stats(ctx: SKRSContext2D, race: Race) {
    const { p } = this;
    const moved = (m: Mover) => m.from - m.to;
    const total = race.movers.reduce((n, m) => n + m.volume, 0);
    const climber = race.movers.reduce<Mover | null>((b, m) => (moved(m) > (b ? moved(b) : 0) ? m : b), null);
    const loser = race.movers.reduce<Mover | null>((b, m) => (moved(m) < (b ? moved(b) : 0) ? m : b), null);

    let x = PAD;
    x += this.caption(ctx, "Total volume", x, STATS_Y) + 12;
    this.text(ctx, `500 20px ${MONO}`, p.foreground);
    const volume = `$${compact(total)}`;
    ctx.fillText(volume, x, STATS_Y);
    x += ctx.measureText(volume).width + 44;

    for (const [label, m] of [
      ["Biggest climber", climber],
      ["Biggest loser", loser],
    ] as const) {
      x += this.caption(ctx, label, x, STATS_Y) + 12;
      if (!m) {
        this.text(ctx, `500 20px ${MONO}`, p.muted);
        ctx.fillText("—", x, STATS_Y);
        x += 20 + 44;
        continue;
      }
      this.coin(ctx, m, x, STATS_Y - 12, 24);
      x += 32;
      this.text(ctx, `600 19px ${SANS}`, p.foreground);
      ctx.fillText(m.ticker, x, STATS_Y);
      x += ctx.measureText(m.ticker).width + 8;
      const d = moved(m);
      this.text(ctx, `500 18px ${MONO}`, d > 0 ? p.up : p.down);
      const delta = `${d > 0 ? "▲" : "▼"} ${Math.abs(d)}`;
      ctx.fillText(delta, x, STATS_Y);
      x += ctx.measureText(delta).width + 44;
    }

    this.caption(ctx, `Share of trailing ${race.window} volume`, WIDTH - PAD, STATS_Y, "right");
    ctx.fillStyle = rgb(p.hairline);
    ctx.fillRect(PAD, RULE_Y, WIDTH - PAD * 2, 1);
  }

  /** The board, down the right: the legend the chart cannot carry. */
  private field(ctx: SKRSContext2D, race: Race) {
    const { p } = this;
    const { field, entries, round } = race;
    this.caption(ctx, "The field", FIELD.x, FIELD.y + 8);
    this.caption(ctx, "Share", FIELD.x + FIELD.w, FIELD.y + 8, "right");
    ctx.fillStyle = rgb(p.hairline);
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
        ctx.fillStyle = rgb(p.gold, 0.1);
        ctx.fillRect(FIELD.x, y + 1, FIELD.w, rowH - 2);
        ctx.fillStyle = rgb(p.gold);
        ctx.fillRect(FIELD.x, y + 1, 3, rowH - 2);
      }
      this.text(ctx, `500 15px ${MONO}`, p.muted, "right");
      ctx.fillText(String(s.rank), FIELD.x + 30, cy);
      const iconSize = Math.min(28, rowH - 10);
      this.coin(ctx, s, FIELD.x + 40, cy - iconSize / 2, iconSize);

      let tx = FIELD.x + 40 + iconSize + 10;
      this.text(ctx, `600 18px ${SANS}`, p.foreground);
      ctx.fillText(s.ticker, tx, cy);
      tx += ctx.measureText(s.ticker).width + 8;
      if (round?.crownSymbol === s.symbol) this.crown(ctx, tx + 9, cy + 6, 18);
      else if (entries.size && !entries.has(s.symbol)) {
        this.text(ctx, `600 10px ${SANS}`, p.muted);
        ctx.letterSpacing = "1px";
        ctx.fillText("NEXT ROUND", tx, cy + 1);
        ctx.letterSpacing = "0px";
      }

      const entry = entries.get(s.symbol);
      const d = entry ? entry.startRank - s.rank : 0;
      if (d !== 0) {
        this.text(ctx, `500 14px ${MONO}`, d > 0 ? p.up : p.down, "right");
        ctx.fillText(`${d > 0 ? "▲" : "▼"}${Math.abs(d)}`, FIELD.x + FIELD.w - 74, cy);
      }
      this.text(ctx, `500 17px ${MONO}`, p.foreground, "right");
      ctx.fillText(total > 0 ? `${((100 * s.quoteVolume) / total).toFixed(1)}%` : "—", FIELD.x + FIELD.w, cy);

      if (i < rows.length - 1) {
        ctx.fillStyle = "rgba(0, 0, 0, 0.4)";
        ctx.fillRect(FIELD.x, y + rowH - 0.5, FIELD.w, 1);
      }
    });
  }

  private footer(ctx: SKRSContext2D) {
    const { p } = this;
    ctx.fillStyle = rgb(p.hairline);
    ctx.fillRect(PAD, FOOT_RULE, WIDTH - PAD * 2, 1);
    this.text(ctx, `400 15px ${SANS}`, p.secondary);
    ctx.fillText(
      "Ten coins race on volume. Back where each one's rank lands at the cut: higher, same or lower.",
      PAD,
      FOOT_Y
    );
    this.text(ctx, `600 18px ${SANS}`, p.accentInk, "right");
    ctx.fillText(this.host, WIDTH - PAD, FOOT_Y);
  }

  /** "X took the crown": the winner's mark on its tile, the crown set on top of it. */
  private crowning(ctx: SKRSContext2D, c: Crowning, t: number, alpha: number) {
    const { p } = this;
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
    glow.addColorStop(0, rgb(p.gold, 0.26));
    glow.addColorStop(1, rgb(p.gold, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    // Slow rays behind the tile.
    ctx.save();
    ctx.translate(cx, glowY);
    ctx.rotate(t / 9_000);
    const rays = ctx.createRadialGradient(0, 0, 80, 0, 0, 620);
    rays.addColorStop(0, rgb(p.gold, 0.12));
    rays.addColorStop(1, rgb(p.gold, 0));
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
    face.addColorStop(0, rgb(p.panelTop));
    face.addColorStop(1, rgb(p.panelBottom));
    ctx.beginPath();
    ctx.roundRect(-half, -half, size, size, radius);
    ctx.fillStyle = face;
    ctx.fill();
    ctx.restore();
    ctx.lineWidth = 3;
    ctx.strokeStyle = rgb(p.gold);
    ctx.stroke();
    this.mark(ctx, c, -half, -half, size, Math.round(size * 0.14), radius);
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
      ctx.fillStyle = i % 3 ? rgb(p.gold) : "#fff6d6";
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
    ctx.translate(cx, tileY + 24 - (1 - easeOutBack(drop)) * 90);
    ctx.rotate(-0.1 + 0.14 * (1 - easeOutBack(drop)));
    this.crown(ctx, 0, 0, 132, true);
    ctx.restore();

    const textIn = easeInOut(progress(t, 1_700, 2_500));
    ctx.globalAlpha = alpha * textIn;
    const lineY = tileY + size + 66 - (1 - textIn) * 14;
    const rest = " took the crown";
    this.text(ctx, `700 60px ${SANS}`, p.foreground);
    const tw = ctx.measureText(c.ticker).width;
    this.text(ctx, `500 60px ${SANS}`, p.secondary);
    const rw = ctx.measureText(rest).width;
    const left = cx - (tw + rw) / 2;
    this.text(ctx, `700 60px ${SANS}`, p.foreground);
    ctx.fillText(c.ticker, left, lineY);
    this.text(ctx, `500 60px ${SANS}`, p.secondary);
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
    this.text(ctx, `500 21px ${MONO}`, p.muted, "center");
    ctx.fillText(detail, cx, lineY + 54);
    ctx.restore();
  }
}
