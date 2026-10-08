import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { Board, fieldOf, type Crowning, type Round, type Standing } from "./renderer/board";
import { niceStep, spread } from "./renderer/chart";
import { inlineSvgClasses } from "./renderer/images";
import { PcmQueue } from "./renderer/mixer";
import { darkTokens, oklchToRgb, parseOklch, readPalette } from "./renderer/palette";
import { compact } from "./renderer/scene";
import { LiveInputError, LiveStore } from "./store";

describe("the stream's palette", () => {
  it("converts oklch to the sRGB a browser would show", () => {
    assert.deepEqual(oklchToRgb(1, 0, 0), [255, 255, 255]);
    assert.deepEqual(oklchToRgb(0, 0, 0), [0, 0, 0]);
    // CSS Color 4's own example: sRGB red is oklch(62.8% 0.2577 29.23).
    assert.deepEqual(oklchToRgb(0.62796, 0.25768, 29.2339), [255, 0, 0]);
    assert.equal(parseOklch("var(--x)"), null);
  });

  it("reads the dark tokens out of the stylesheet, following var()", () => {
    const tokens = darkTokens(`:root {\n  --gold: oklch(0.5 0.1 88);\n}\n:root[data-theme="dark"] {\n  --gold: oklch(0.82 0.14 92);\n  --sell: var(--gold);\n}\n`);
    assert.equal(tokens.get("--gold"), "oklch(0.82 0.14 92)");
    assert.equal(tokens.get("--sell"), "oklch(0.82 0.14 92)");
  });

  it("is the repository's own dark theme", () => {
    const p = readPalette();
    assert.deepEqual(p.gold, oklchToRgb(0.82, 0.14, 92));
    assert.ok(p.background[0] < 40, "a dark ground");
  });
});

describe("a coin's SVG mark", () => {
  it("keeps colours its stylesheet gave it, which Skia would drop", () => {
    const svg = `<svg><defs><style>.a,.b{fill:url(#g);}.b{stroke:#000}</style></defs><path class="a" d="M0 0"/><circle class="b" fill="#fff" r="1"/></svg>`;
    const out = inlineSvgClasses(svg);
    assert.match(out, /<path d="M0 0" fill="url\(#g\)"\/>/);
    // An attribute the element already has is left alone, and nothing is doubled.
    assert.match(out, /<circle fill="#fff" r="1" stroke="#000"\/>/);
    assert.equal(inlineSvgClasses("<svg><path d='x'/></svg>"), "<svg><path d='x'/></svg>");
  });
});

describe("the music", () => {
  it("hands out exact amounts in whole frames, filling with silence", () => {
    const q = new PcmQueue();
    // One stereo frame, and half of the next: a pipe split it.
    q.push(Buffer.from([1, 0, 2, 0, 3, 0]));
    assert.deepEqual([...q.pull(8, 1)], [1, 0, 2, 0, 0, 0, 0, 0]);
    // The rest arrives, and the frame plays whole, channels where they belong.
    q.push(Buffer.from([4, 0]));
    assert.deepEqual([...q.pull(4, 1)], [3, 0, 4, 0]);
  });

  it("plays at the volume asked for, clipped rather than wrapped", () => {
    const q = new PcmQueue();
    const loud = Buffer.alloc(4);
    loud.writeInt16LE(20_000, 0);
    loud.writeInt16LE(-20_000, 2);
    q.push(loud);
    const half = q.pull(4, 0.5);
    assert.equal(half.readInt16LE(0), 10_000);
    assert.equal(half.readInt16LE(2), -10_000);
    q.push(loud);
    const over = q.pull(4, 2);
    assert.equal(over.readInt16LE(0), 32_767);
    assert.equal(over.readInt16LE(2), -32_768);
  });
});

describe("the chart", () => {
  it("rules the axis at round steps", () => {
    assert.equal(niceStep(0.9), 1);
    assert.equal(niceStep(2.2), 2.5);
    assert.equal(niceStep(7), 10);
    assert.equal(niceStep(0.03), 0.05);
  });

  it("spreads marks that would overlap, staying in bounds and in order", () => {
    const ys = spread([100, 101, 102, 300], 24, 0, 400);
    for (let i = 1; i < 3; i++) assert.ok(ys[i] - ys[i - 1] >= 24 - 1e-9);
    assert.equal(ys[3], 300);
    const squeezed = spread([395, 398], 24, 0, 400);
    assert.ok(squeezed[1] <= 400 && squeezed[1] - squeezed[0] >= 24 - 1e-9);
  });

  it("writes volumes the way the site does", () => {
    assert.equal(compact(27_460_609), "27.46M");
    assert.equal(compact(1_000), "1K");
    assert.equal(compact(15_840_000), "15.84M");
  });
});

const round = (status: Round["status"], cut: Record<string, number | null> = {}): Round => ({
  id: "r1",
  startsAt: "2026-10-07T23:00:00Z",
  lockAt: "2026-10-07T23:29:00Z",
  endsAt: "2026-10-07T23:30:00Z",
  status,
  crownSymbol: null,
  entries: ["PUMP", "JUP"].map((s, i) => ({
    symbol: s,
    ticker: s,
    imageUrl: null,
    startRank: i + 1,
    cutRank: cut[s] ?? null,
    liveRank: null,
    liveVolume: 0,
  })),
});

describe("the crown moment", () => {
  it("is announced when a round the stream watched racing is cut", () => {
    const b = new Board("http://unused");
    b.observe(round("OPEN"));
    b.observe(round("LOCKED"));
    assert.equal(b.crowning, null);
    b.observe(round("CUT", { PUMP: 2, JUP: 1 }));
    const crowned = b.crowning as Crowning | null;
    assert.equal(crowned?.ticker, "JUP");
    assert.equal(crowned?.startRank, 2);
    // Once.
    const first = b.crowning;
    b.observe(round("SETTLED", { PUMP: 2, JUP: 1 }));
    assert.equal(b.crowning, first);
  });

  it("is not announced for a round already cut when the stream started", () => {
    const b = new Board("http://unused");
    b.observe(round("CUT", { PUMP: 1 }));
    assert.equal(b.crowning, null);
  });

  it("passes without a winner when the cut recorded no ranks", () => {
    const b = new Board("http://unused");
    b.observe(round("LOCKED"));
    b.observe(round("CUT"));
    assert.equal(b.crowning, null);
  });

  it("keeps a coin pushed off the board in the field, where the cut will score it", () => {
    const standings: Standing[] = [{ symbol: "PUMP", ticker: "PUMP", rank: 1, quoteVolume: 9, imageUrl: null }];
    const r = round("OPEN");
    r.entries[1].liveRank = 11;
    const field = fieldOf(r, standings);
    assert.deepEqual(field.map((s) => [s.symbol, s.rank]), [["PUMP", 1], ["JUP", 11]]);
  });
});

describe("the on-air switch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "crown-live-settings-"));
  after(() => rm(dir, { recursive: true, force: true }));

  it("is remembered across a restart, so the stream comes back by itself", async () => {
    await new LiveStore(dir).updateSettings({ onAir: true, volume: 0.5 });
    assert.deepEqual(await new LiveStore(dir).settings(), { onAir: true, volume: 0.5 });
    await assert.rejects(new LiveStore(dir).updateSettings({ volume: 2 }), LiveInputError);
  });
});
