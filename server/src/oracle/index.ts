import { prisma } from "../prisma";
import { fetchTrending, hasKey, VOLUME_FIELD, type TrendingToken } from "./birdeye";

/** How many tokens compete. */
export const BOARD_SIZE = 10;
/** Universe size to rank over — the board is the top BOARD_SIZE of these. */
const POOL = 24;
/**
 * How often the board is re-ranked.
 *
 * The upstream recomputes about once every 60s: volume1h and price moved for
 * 18/20 and 13/20 tokens at the 60s mark, and for none at all at 15s or 30s.
 * Every request is `x-vercel-cache: MISS` with `age: 0`, so we always reach
 * origin and no amount of polling makes it fresher than that recompute — the
 * only thing we control is how soon we notice. 10s gets us within 10 seconds of
 * a new value at 6 requests a minute, which is polite given they publish no
 * rate-limit headers.
 */
/**
 * How often to ask the upstream for a new board.
 *
 * Sixty seconds, and the number is set by billing rather than by taste. Birdeye
 * prices in compute units against a monthly allowance, and `/defi/v3/token/list`
 * is one of the dearer endpoints — this polled every ten seconds when it was
 * ported across from a source that charged per request, which is 8,640 calls a
 * day, and the month's allowance went in hours. The board then served nothing at
 * all, which is a far worse outcome than a board that is a minute behind.
 *
 * A minute is plenty for what is being measured. The ranking metric is an hour's
 * volume, so it moves slowly by construction, and a thirty-minute round still
 * gets thirty points on its chart.
 */
const POLL_MS = Number(process.env.ORACLE_POLL_MS ?? 60_000);
/**
 * In-memory history for the chart. Must outlast a whole round — the chart shows
 * the market's full runtime, not the visitor's session, so a viewer arriving at
 * minute 50 still sees the first 50 minutes.
 */
const HISTORY_MINUTES = Number(process.env.ORACLE_HISTORY_MINUTES ?? 90);
const HISTORY_POINTS = Math.ceil((HISTORY_MINUTES * 60_000) / POLL_MS);

/**
 * How old the upstream's own numbers may be before the board stops calling
 * itself live.
 *
 * Generous, because a feed that recomputes every few minutes is normal and a
 * board that cried stale at every gap would be noise. Anything past this is not
 * a gap — it is a feed that has stopped, which has happened, for hours, while
 * every part of this app reported "live".
 */
const STALE_AFTER_MS = Number(process.env.ORACLE_STALE_AFTER_MS ?? 15 * 60_000);

/**
 * How often a poll also tidies the sample table, and how much slack it leaves.
 *
 * The chart reads `HISTORY_MINUTES`; keeping a multiple of that means a restart
 * still finds a full window even if the process was down for a while, and means
 * the boundary is never exactly where somebody is looking.
 */
const PRUNE_ODDS = 0.02;
const PRUNE_KEEP_FACTOR = 3;

export const WINDOW_LABEL = VOLUME_FIELD.replace("volume", "").replace("USD", "");

export interface Standing {
  symbol: string;
  ticker: string;
  name: string;
  imageUrl: string | null;
  rank: number;
  previousRank: number | null;
  quoteVolume: number;
  price: number;
  trades1h: number;
  wallets1h: number;
  priceChange1hPercent: number;
}

export interface RankPoint {
  t: number;
  symbol: string;
  rank: number;
  quoteVolume: number;
}

/**
 * What to call a token and which mark to draw for it.
 *
 * Kept apart from `TrendingToken` because it outlives it: market data is only
 * meaningful for tokens currently in the pool, while the identity is needed for
 * any token that has ever appeared in a round or a sample.
 */
export interface TokenMeta {
  symbol: string;
  ticker: string;
  name: string;
  imageUrl: string | null;
}

/** A rank change, for the live flow feed. */
export interface FlowEvent {
  at: number;
  symbol: string;
  ticker: string;
  imageUrl: string | null;
  from: number | null;
  to: number;
  quoteVolume: number;
}

interface Sample {
  t: number;
  ranks: Map<string, number>;
  vols: Map<string, number>;
}

/**
 * Live ranking oracle backed by tokens.xyz.
 *
 * Ranks the trending pool by volume over a short window (see VOLUME_FIELD) and
 * republishes the board on a timer. Everything downstream — rounds, the cut,
 * settlement — reads `standings()` and is agnostic to where the numbers came
 * from.
 */
class Oracle {
  private tokens: TrendingToken[] = [];
  private bySymbol = new Map<string, TrendingToken>();
  /**
   * Every token we've ever seen, not just the ones in the pool right now.
   * Hydrated from `Token` at boot and never evicted — see `remember`.
   */
  private readonly meta = new Map<string, TokenMeta>();
  private readonly history: Sample[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;

  status: "starting" | "live" | "stale" | "degraded" = "starting";
  /** When the upstream last published numbers that differed from the previous poll. */
  updatedAt = 0;
  /**
   * The upstream's own timestamp for the numbers we are holding.
   *
   * Replaces a fingerprint of the volumes. Hashing the values answered "did
   * anything move?", which is a different question from "is this a new
   * measurement?" — a market that is genuinely flat between two recomputes
   * looks identical to a feed that has stopped, and only one of those should
   * stop the chart.
   */
  private asOf = 0;
  private listeners: ((standings: Standing[]) => void)[] = [];

  /**
   * Called once per *publish* — a poll that returned numbers we hadn't seen —
   * never on the identical polls in between. Anything reacting to the market
   * should hang off this rather than a timer of its own, or it will invent
   * activity the upstream never reported.
   */
  onPublish(listener: (standings: Standing[]) => void): void {
    this.listeners.push(listener);
  }

  private emit(): void {
    const board = this.standings();
    for (const listener of this.listeners) {
      try {
        listener(board);
      } catch (err) {
        // A subscriber is a spectator; it must never take the board down.
        console.warn("⚠  oracle listener:", err instanceof Error ? err.message : err);
      }
    }
  }

  /**
   * Write the current board so the chart survives a restart. Fire-and-forget:
   * the live board must not stall on the database.
   */
  private async persist(): Promise<void> {
    // **The sample's own time, not `updatedAt`.**
    //
    // `updatedAt` only moves when the upstream's numbers move, and the upstream
    // recomputes on its own schedule — measured, it returns byte-identical
    // volumes for half a minute at a stretch. Stamping every sample with it
    // meant repeated writes collided on `skipDuplicates` and were silently
    // dropped, so the table gained a row only when the market did something.
    //
    // That is the opposite of what the chart needs, and the comment in `refresh`
    // already said so: a point per poll, or the line is a handful of specks. The
    // in-memory `record()` honoured that and the persisted copy did not — and
    // the chart reads the persisted copy.
    const at = new Date(this.asOf || Date.now());
    try {
      await prisma.rankSample.createMany({
        data: this.tokens.slice(0, BOARD_SIZE).map((t, i) => ({
          at,
          symbol: t.symbol,
          rank: i + 1,
          volume: t.volume,
        })),
        skipDuplicates: true,
      });
      // **Pruned here, because it is now written on every poll.**
      //
      // While a row only appeared when the market moved, the table grew slowly
      // enough that nobody had to think about it. A point every ten seconds is
      // ten rows every ten seconds — about 86,000 a day — and the query only
      // ever reads the last `HISTORY_MINUTES` of them. Everything older is
      // storage nobody looks at.
      //
      // Occasionally rather than every time: deleting is a write against the
      // same table the chart reads, and doing it on every poll spends more on
      // tidying than on the data.
      if (Math.random() < PRUNE_ODDS) {
        const cutoff = new Date(Date.now() - HISTORY_MINUTES * 60_000 * PRUNE_KEEP_FACTOR);
        await prisma.rankSample.deleteMany({ where: { at: { lt: cutoff } } });
      }
    } catch {
      // History is a nicety; never let it break the board.
    }
  }

  /**
   * Take note of any token whose name or logo we don't already hold.
   *
   * The upstream repeats the same identities on every poll, so this compares
   * against the in-memory map first and only touches the database for genuinely
   * new information — in the steady state, never. Fire-and-forget for the same
   * reason `persist` is: the board must not stall on a write.
   */
  private remember(tokens: TrendingToken[]): void {
    const fresh: TokenMeta[] = [];
    for (const t of tokens) {
      const known = this.meta.get(t.symbol);
      if (known && known.name === t.name && known.imageUrl === t.imageUrl) continue;
      const entry: TokenMeta = {
        symbol: t.symbol,
        ticker: t.symbol,
        name: t.name,
        imageUrl: t.imageUrl,
      };
      this.meta.set(t.symbol, entry);
      fresh.push(entry);
    }
    if (!fresh.length) return;
    void (async () => {
      try {
        await Promise.all(
          fresh.map((m) =>
            prisma.token.upsert({
              where: { symbol: m.symbol },
              create: { symbol: m.symbol, name: m.name, imageUrl: m.imageUrl },
              update: { name: m.name, imageUrl: m.imageUrl },
            })
          )
        );
      } catch {
        // Identities are a nicety; never let them break the board.
      }
    })();
  }

  /** Reload the token identities, so logos survive a token leaving the pool. */
  private async hydrateMeta(): Promise<void> {
    try {
      for (const t of await prisma.token.findMany()) {
        this.meta.set(t.symbol, {
          symbol: t.symbol,
          ticker: t.symbol,
          name: t.name,
          imageUrl: t.imageUrl,
        });
      }
    } catch {
      // Falls back to whatever the first poll reports.
    }
  }

  /**
   * The most recent board on disk, at any age.
   *
   * Only used when the chart's window came back empty — an outage longer than
   * `HISTORY_MINUTES` — and only to put a field on the screen rather than to
   * draw anything with.
   */
  private async lastKnownBoard(): Promise<Sample | null> {
    try {
      const latest = await prisma.rankSample.findFirst({
        orderBy: { at: "desc" },
        select: { at: true },
      });
      if (!latest) return null;
      const rows = await prisma.rankSample.findMany({ where: { at: latest.at } });
      if (!rows.length) return null;
      const sample: Sample = { t: latest.at.getTime(), ranks: new Map(), vols: new Map() };
      for (const r of rows) {
        sample.ranks.set(r.symbol, r.rank);
        sample.vols.set(r.symbol, r.volume);
      }
      return sample;
    } catch {
      return null;
    }
  }

  /** Reload recent samples so a restart doesn't blank the chart. */
  private async hydrate(): Promise<void> {
    try {
      const since = new Date(Date.now() - HISTORY_MINUTES * 60_000);
      const rows = await prisma.rankSample.findMany({
        where: { at: { gte: since } },
        orderBy: { at: "asc" },
      });
      const byTime = new Map<number, Sample>();
      for (const r of rows) {
        const t = r.at.getTime();
        if (!byTime.has(t)) byTime.set(t, { t, ranks: new Map(), vols: new Map() });
        const sample = byTime.get(t)!;
        sample.ranks.set(r.symbol, r.rank);
        sample.vols.set(r.symbol, r.volume);
      }
      this.history.unshift(...[...byTime.values()].sort((a, b) => a.t - b.t));
      if (this.history.length) {
        console.log(`📈  restored ${byTime.size} chart samples from disk`);
      }

      // **And the board itself, from the newest of them.**
      //
      // Only the chart was restored here, so a boot that could not reach the
      // upstream came up with an empty board — no rows, no rounds, "oracle
      // down" — even with an hour of perfectly good samples on disk. That is
      // the exact moment the stored copy is worth having, and it was the one
      // moment it was not used.
      //
      // What comes back is what a sample holds: the field, its order and its
      // volumes. Price, liquidity and trade counts are not in there and are
      // left at zero rather than invented. The first successful refresh
      // replaces all of it, and `status` says `stale` until then, so nothing
      // downstream mistakes this for a live board.
      // Deliberately not the chart's window. Those are different questions: a
      // sample older than `HISTORY_MINUTES` is too stale to draw a line with,
      // and still the best board anyone has. Restricting the board to the chart's
      // window meant a day-old outage came up with nothing at all, which is
      // strictly worse than coming up with yesterday's field marked stale.
      const newest = this.history[this.history.length - 1] ?? (await this.lastKnownBoard());
      if (newest && !this.tokens.length) {
        // Both, because they answer to different readers: `asOf` is what the
        // next refresh compares against to decide it has a new measurement, and
        // `updatedAt` is what the API reports as the data's age. Setting only
        // the first left the age computed against zero and the status panel
        // claiming the board was half a million hours old.
        this.asOf = newest.t;
        this.updatedAt = newest.t;
        this.tokens = [...newest.ranks.entries()]
          .sort(([, a], [, b]) => a - b)
          .map(([symbol]) => {
            const known = this.meta.get(symbol);
            return {
              assetId: symbol,
              symbol,
              name: known?.name ?? symbol,
              imageUrl: known?.imageUrl ?? null,
              price: 0,
              volume: newest.vols.get(symbol) ?? 0,
              volume24h: 0,
              liquidity: 0,
              trades5m: 0,
              trades1h: 0,
              wallets1h: 0,
              priceChange1hPercent: 0,
            };
          });
        this.bySymbol = new Map(this.tokens.map((t) => [t.symbol, t]));
        this.status = "stale";
        console.log(
          `📈  no upstream yet — serving the last known board of ${this.tokens.length}, ` +
            `${Math.round((Date.now() - newest.t) / 60_000)} min old`
        );
      }
    } catch {
      // No history is survivable; a broken boot is not.
    }
  }

  async start(): Promise<void> {
    if (this.timer) return;
    // Before the key check: settled rounds are served from the database and
    // still want their marks, even on a box with no upstream credentials.
    await this.hydrateMeta();
    if (!hasKey()) {
      this.status = "degraded";
      console.warn(
        [
          "⚠  BIRDEYE_DATA_SECRET is not set — the board will be EMPTY.",
          "   Put it in server/.env. Note that only `bun` auto-loads .env;",
          "   the npm scripts pass --env-file-if-exists so any runner works.",
        ].join("\n")
      );
      return;
    }
    await this.hydrate();
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), POLL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async refresh(): Promise<void> {
    if (this.inFlight) return; // a slow poll must not stack up behind itself
    this.inFlight = true;
    try {
      const { tokens, asOf } = await fetchTrending(POOL);
      if (tokens.length) {
        // Most polls land inside the upstream's recompute interval and return
        // byte-identical numbers. Those still get a history sample — the chart
        // needs a point per poll or its line is a handful of specks and an
        // empty axis for the first minute after boot. What they must NOT do is
        // advance `updatedAt` or emit flow events, or the UI would claim fresh
        // data and invent rank changes that never happened.
        // **A new measurement, not a new poll.**
        //
        // The upstream stamps every response with when *it* computed the
        // numbers, and polling faster than that returns the same measurement
        // again. Keying on `asOf` is what stops ten seconds of impatience being
        // recorded as ten seconds of market history — and it is what makes a
        // frozen feed visible instead of looking like a flat market.
        const changed = asOf !== this.asOf;
        this.asOf = asOf;

        this.tokens = tokens;
        this.bySymbol = new Map(tokens.map((t) => [t.symbol, t]));
        this.remember(tokens);
        // Freshness is the upstream's timestamp against the clock, not whether
        // a fetch succeeded. A response that arrives promptly and carries data
        // computed five hours ago is a successful fetch of stale data, and
        // calling that "live" is how an empty chart became a mystery.
        this.status = Date.now() - asOf > STALE_AFTER_MS ? "stale" : "live";
        if (changed) this.updatedAt = asOf;
        this.record();
        // Both keyed on a new *measurement*. Persisting every poll wrote the
        // same numbers under a new timestamp and drew a chart of our own polling
        // rather than of the market; `skipDuplicates` on the measurement's own
        // `asOf` makes a repeat a no-op without needing to know it was one.
        if (changed) {
          void this.persist();
          this.emit();
        }
      }
    } catch (err) {
      this.status = "degraded";
      console.warn("⚠  oracle refresh:", err instanceof Error ? err.message : err);
    } finally {
      this.inFlight = false;
    }
  }

  private rankMap(): Map<string, number> {
    const m = new Map<string, number>();
    this.tokens.forEach((t, i) => m.set(t.symbol, i + 1));
    return m;
  }

  /** Snapshot the ordering into history every poll. */
  private record(): void {
    const now = Date.now();
    const ranks = this.rankMap();
    const vols = new Map(this.tokens.map((t) => [t.symbol, t.volume]));
    this.history.push({ t: now, ranks, vols });
    if (this.history.length > HISTORY_POINTS) {
      this.history.splice(0, this.history.length - HISTORY_POINTS);
    }

  }

  private rankAgo(symbol: string, agoMs: number): number | null {
    if (!this.history.length) return null;
    const cutoff = Date.now() - agoMs;
    if (this.history[0].t > cutoff) return null;
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i].t <= cutoff) return this.history[i].ranks.get(symbol) ?? null;
    }
    return null;
  }

  standings(limit = BOARD_SIZE): Standing[] {
    return this.tokens.slice(0, limit).map((t, i) => ({
      symbol: t.symbol,
      ticker: t.symbol,
      name: t.name,
      imageUrl: t.imageUrl,
      rank: i + 1,
      previousRank: this.rankAgo(t.symbol, 60_000),
      quoteVolume: t.volume,
      price: t.price,
      trades1h: t.trades1h,
      wallets1h: t.wallets1h,
      priceChange1hPercent: t.priceChange1hPercent,
    }));
  }

  /**
   * Rank lines for the chart.
   *
   * `symbols` pins which coins are drawn, and the caller passes the round's
   * field. The chart used to take the live top-N instead, which got the
   * membership wrong in both directions at once: a coin that opened the round
   * and has since been pushed off the board vanished from the chart — while
   * still being in the field, still holding positions, and still bettable, so
   * the one line a player needed to watch was the one that disappeared — and a
   * coin that trended into the top ten halfway through appeared on it, drawing a
   * competitor in a race it is not running.
   *
   * The field is fixed when a round opens and does not change for its duration.
   * That, not what is trending this minute, is what the chart is a picture of.
   */
  rankHistory(minutes: number, symbols?: Iterable<string>, maxPoints = 120): RankPoint[] {
    const since = Date.now() - minutes * 60_000;
    const board = new Set(symbols ?? this.standings(BOARD_SIZE).map((s) => s.symbol));
    const window = this.history.filter((s) => s.t >= since);
    if (!window.length) return [];

    // Drop consecutive samples that carry identical numbers.
    //
    // The buffer records every poll (10s) so the line always reaches "now", but
    // the upstream only republishes about once a minute — so six identical
    // points in a row rendered as a flat run followed by a vertical jump, i.e. a
    // staircase. Samples restored from disk are change-only and drew as smooth
    // slopes, which is why the line changed character at whatever point the
    // server last started. Collapsing repeats here gives both halves the same
    // granularity. The newest sample is always kept so the line still ends at
    // the present moment.
    const distinct: Sample[] = [];
    let last = "";
    for (const sample of window) {
      const sig = [...sample.vols.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}:${v}`)
        .join("|");
      if (sig !== last) {
        distinct.push(sample);
        last = sig;
      }
    }
    const newest = window[window.length - 1];
    if (distinct[distinct.length - 1] !== newest) distinct.push(newest);

    const stride = Math.max(1, Math.ceil(distinct.length / Math.max(1, maxPoints)));
    const picked: Sample[] = [];
    for (let i = distinct.length - 1; i >= 0; i -= stride) picked.push(distinct[i]);
    picked.reverse();

    const out: RankPoint[] = [];
    for (const sample of picked) {
      for (const symbol of board) {
        const rank = sample.ranks.get(symbol);
        if (rank == null) continue;
        out.push({ t: sample.t, symbol, rank, quoteVolume: sample.vols.get(symbol) ?? 0 });
      }
    }
    return out;
  }

  /**
   * Board movements, newest first.
   *
   * Derived from the history buffer rather than logged as they happen, because
   * history is restored from disk at boot — so this covers the whole round,
   * including moves that occurred before this process started, instead of only
   * what a live ring happened to catch.
   */
  recentFlow(limit = 40, since = 0): FlowEvent[] {
    const out: FlowEvent[] = [];
    for (let i = 1; i < this.history.length; i++) {
      const prev = this.history[i - 1];
      const cur = this.history[i];
      if (cur.t < since) continue;
      for (const [symbol, to] of cur.ranks) {
        if (to > BOARD_SIZE) continue;
        const from = prev.ranks.get(symbol) ?? null;
        if (from === to) continue;
        // From `meta`, not the live pool: the buffer reaches back further than
        // the pool's membership does, so a mover that has since dropped out of
        // it still has to arrive with its mark.
        const token = this.meta.get(symbol);
        out.push({
          at: cur.t,
          symbol,
          ticker: token?.ticker ?? symbol,
          imageUrl: token?.imageUrl ?? null,
          from,
          to,
          quoteVolume: cur.vols.get(symbol) ?? 0,
        });
      }
    }
    return out.slice(-limit).reverse();
  }

  tokenFor(symbol: string): TrendingToken | undefined {
    return this.bySymbol.get(symbol);
  }

  /**
   * A token's identity, whether or not it is still trading. Everything that
   * renders a coin outside the live board — settled rounds, replays, the tape —
   * should ask here rather than borrowing from `standings()`.
   */
  metaFor(symbol: string): TokenMeta | undefined {
    return this.meta.get(symbol);
  }

  /**
   * Test seam — stand in a board and a history without an upstream.
   *
   * `rows` is one entry per coin in board order, busiest first, and is written
   * into every sample so the whole window agrees on it. Enough to ask the one
   * question worth asking of `rankHistory`: which coins does it draw.
   */
  seedForTest(rows: { symbol: string; volume: number }[], samples = 3): void {
    const at = Date.now();
    this.tokens = rows.map((r) => ({
      assetId: r.symbol,
      symbol: r.symbol,
      name: r.symbol,
      imageUrl: null,
      price: 1,
      volume: r.volume,
      volume24h: r.volume,
      liquidity: 0,
      trades5m: 0,
      trades1h: 0,
      wallets1h: 0,
      priceChange1hPercent: 0,
    }));
    this.bySymbol = new Map(this.tokens.map((t) => [t.symbol, t]));
    this.history.length = 0;
    for (let n = samples; n > 0; n--) {
      this.history.push({
        t: at - n * POLL_MS,
        ranks: new Map(rows.map((r, i) => [r.symbol, i + 1])),
        vols: new Map(rows.map((r) => [r.symbol, r.volume])),
      });
    }
  }
}

export const oracle = new Oracle();
