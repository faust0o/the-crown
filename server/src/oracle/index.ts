import { hasMainnetRpc, mainnetSlot } from "../chain/mainnet";
import { warmLogo } from "../logo-store";
import { prisma } from "../prisma";
import { fetchTrending, UpstreamError, WINDOW, type TrendingToken } from "./jupiter";

/** How many tokens compete. */
export const BOARD_SIZE = 10;
/**
 * Universe size to rank over — the board is the top BOARD_SIZE of these.
 *
 * Exported for the tests, which have to be able to put a coin past it: the pool
 * is where a relegated coin used to stop being measured, so "below the pool" is
 * the case worth writing down.
 */
export const POOL = 24;
/**
 * When to ask the upstream for a new board: as soon as it has one, and no
 * sooner.
 *
 * Measured rather than chosen. Jupiter recomputes its token stats about every
 * fifteen seconds and serves them from a cache that says so — `max-age=15`,
 * with an `age` counting up to it — on the keyed host and the keyless one
 * alike. Polling every two seconds returned the same body seven times running,
 * so a fixed fast poll spends the rate limit on copies of a reading already in
 * hand. Instead each poll lands just after the copy in hand expires, which
 * picks up every new reading within about a second of it existing, at four
 * requests a minute.
 *
 * The bounds are for a cache header that is missing or wrong: never ask more
 * often than `MIN_POLL_MS`, never go longer than `MAX_POLL_MS` without asking.
 */
const MIN_POLL_MS = Number(process.env.ORACLE_MIN_POLL_MS ?? 2_000);
const MAX_POLL_MS = Number(process.env.ORACLE_MAX_POLL_MS ?? 30_000);
/** What to assume when the upstream sends no cache header at all. */
const DEFAULT_POLL_MS = 15_000;
/** How long after the cached copy expires to ask, so we get the next one. */
const EXPIRY_SLACK_MS = 500;
/** The longest a failing upstream is left between attempts. */
const MAX_BACKOFF_MS = 60_000;
/** Solana's slot time, for turning a lag in slots into one in milliseconds. */
const SLOT_MS = 400;

/**
 * In-memory history for the chart. Must outlast a whole round — the chart shows
 * the market's full runtime, not the visitor's session, so a viewer arriving at
 * minute 50 still sees the first 50 minutes.
 */
const HISTORY_MINUTES = Number(process.env.ORACLE_HISTORY_MINUTES ?? 90);

/**
 * How old the numbers may be before the board stops calling itself live — and
 * before a round may open or be cut on it.
 *
 * Two minutes, against a feed that produces a reading every fifteen seconds
 * describing the market as of fifteen to thirty seconds ago. That is several
 * missed readings of slack, and nowhere near the hours a feed has actually been
 * frozen for while every part of this app reported "live".
 */
const STALE_AFTER_MS = Number(process.env.ORACLE_STALE_AFTER_MS ?? 2 * 60_000);

/**
 * How often a poll also tidies the sample table, and how much slack it leaves.
 *
 * The chart reads `HISTORY_MINUTES`; keeping a multiple of that means a restart
 * still finds a full window even if the process was down for a while, and means
 * the boundary is never exactly where somebody is looking.
 */
const PRUNE_ODDS = 0.02;
const PRUNE_KEEP_FACTOR = 3;

export const WINDOW_LABEL = WINDOW;

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
 * Live ranking oracle backed by Jupiter's token index.
 *
 * Ranks the trending pool by volume over a short window (see `WINDOW`) and
 * republishes the board whenever the upstream has a new reading. Everything downstream — rounds, the cut,
 * settlement — reads `standings()` and is agnostic to where the numbers came
 * from.
 */
class Oracle {
  private tokens: TrendingToken[] = [];
  /**
   * Every token the upstream reported, busiest first, racing or not. Wider than
   * the pool on purpose, and wider than the racers too: a coin's numbers have to
   * survive both of the things that can happen to it mid-round — being relegated
   * past the pool, and failing an eligibility test for a poll or two.
   */
  private watched: TrendingToken[] = [];
  /**
   * The racing subset of `watched`, busiest first — plus the live round's field,
   * eligible or not (see `rerank`). This is what a rank *is*, and it is
   * deliberately not the same list as the one above: the board is a standing
   * among competitors, while a lookup is a measurement of a coin.
   */
  private ranked: TrendingToken[] = [];
  /** Keyed over `watched`, so a lookup outlives both of those. */
  private bySymbol = new Map<string, TrendingToken>();
  /**
   * The live round's field: symbols this oracle owes a continuous trail to
   * until the round ends, wherever they are on the board.
   *
   * The board is a top ten and everything downstream was written against it, so
   * a coin pushed out of it stopped being measured at exactly the moment its
   * round was about — no history sample, no persisted volume, and a row that
   * read "$0" for a coin that was still trading. Set by `track()`.
   */
  private tracked = new Set<string>();
  /**
   * Every token we've ever seen, not just the ones in the pool right now.
   * Hydrated from `Token` at boot and never evicted — see `remember`.
   */
  private readonly meta = new Map<string, TokenMeta>();
  private readonly history: Sample[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  /** Consecutive failed polls, for the backoff. */
  private failures = 0;

  status: "starting" | "live" | "stale" | "degraded" = "starting";
  /**
   * The moment the numbers we hold describe.
   *
   * The older of two clocks: Jupiter's own stamp for when it computed them, and
   * — when a mainnet RPC is configured — the slot its prices were read at,
   * measured against the slot the chain has actually reached. The second is the
   * one that cannot be mislabelled, which is the way the last two upstreams
   * failed: a freshly generated response carrying frozen numbers still carries
   * frozen slots.
   */
  updatedAt = 0;
  /** How far behind the chain the pool's prices were at the last poll, or null with no mainnet RPC. */
  lagMs: number | null = null;
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
    // **The board, plus whatever the live round has left on it.**
    //
    // Only the top BOARD_SIZE was written, which made relegation look like
    // delisting in the one copy that outlives the process: the moment a coin
    // dropped out its row stopped being recorded, so the replay had no volume
    // for it at the cut and a restart mid-round came back holding a board that
    // had never heard of it. `sampleAt` adds the round's field back, and there
    // are at most a handful of those off the board at once — a few rows a
    // minute, against a table that is already pruned below.
    //
    // The board and not the whole pool, because this table is read by the replay
    // and by a restart, and both draw the board and the round's field rather
    // than the ranks below them.
    const sample = this.sampleAt(at.getTime(), this.tokens.slice(0, BOARD_SIZE));
    try {
      await prisma.rankSample.createMany({
        data: [...sample.ranks].map(([symbol, rank]) => ({
          at,
          symbol,
          rank,
          volume: sample.vols.get(symbol) ?? 0,
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
      // Before the early-out, so a logo whose host failed is retried from here
      // once its backoff has run — the store makes this a set lookup otherwise.
      warmLogo(t.imageUrl);
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
        // Every coin ever raced, not just today's board: settled rounds and
        // replays draw them too, and a logo is fetched once and kept.
        warmLogo(t.imageUrl);
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
        this.watched = [...newest.ranks.entries()]
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
              // Everything in a stored sample was on the board or in the round's
              // field when it was written, so it raced.
              racing: true,
            };
          });
        // The stored board can now carry a round entry that had already been
        // relegated when the process died, sitting below the visible ten. Kept,
        // because a lookup on it is exactly what the live rows need; ordered by
        // the rank the sample recorded, so the board on top of it is the board
        // that was there. Below the board this renumbers by position and can
        // therefore read a place or two high — the first live poll replaces the
        // lot, and `status` says `stale` until it does.
        this.ranked = this.watched;
        this.tokens = this.ranked.slice(0, POOL);
        this.bySymbol = new Map(this.watched.map((t) => [t.symbol, t]));
        this.status = "stale";
        console.log(
          `📈  no upstream yet — serving the last known board of ${this.watched.length}, ` +
            `${Math.round((Date.now() - newest.t) / 60_000)} min old`
        );
      }
    } catch {
      // No history is survivable; a broken boot is not.
    }
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.hydrateMeta();
    await this.hydrate();
    if (!hasMainnetRpc()) {
      console.warn(
        [
          "⚠  No mainnet RPC — the board's freshness is Jupiter's word for it alone.",
          "   Point SOLANA_RPC_URL at Helius, or set CROWN_PRICE_RPC_URL, and the",
          "   oracle checks Jupiter's price slots against the chain itself.",
        ].join("\n")
      );
    }
    await this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * Whether the board is a current reading of the market — fit to open a round
   * on, or to cut one against.
   *
   * Asked of the clock rather than of the last poll, so a poll loop that has
   * stopped, or an upstream that has gone quiet, cannot leave this saying yes.
   */
  isLive(): boolean {
    return this.status === "live" && Date.now() - this.updatedAt <= STALE_AFTER_MS;
  }

  /**
   * One poll, then the next one scheduled for when it is worth making.
   *
   * A chain of timeouts rather than an interval, because the right gap is a
   * property of each response — the upstream's cache says when it will next have
   * something new — and because a chain cannot stack a slow poll behind itself.
   */
  private async tick(): Promise<void> {
    const wait = await this.refresh();
    if (this.running) this.timer = setTimeout(() => void this.tick(), wait);
  }

  /** Clamp a requested gap to the poll bounds. */
  private gap(ms: number): number {
    return Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, ms));
  }

  /** Poll once. Resolves to how long to wait before the next poll. */
  private async refresh(): Promise<number> {
    try {
      const [{ tokens, watched, asOf, slot, freshInMs }, chainSlot] = await Promise.all([
        fetchTrending(POOL, this.tracked),
        // A cross-check, not a dependency: without it the board still runs, on
        // Jupiter's word for how fresh it is.
        hasMainnetRpc() ? mainnetSlot().catch(() => null) : Promise.resolve(null),
      ]);
      const received = Date.now();
      this.failures = 0;
      // The copy in hand is the upstream's current one until its cache expires;
      // asking before then only returns it again.
      const wait = this.gap(freshInMs == null ? DEFAULT_POLL_MS : freshInMs + EXPIRY_SLACK_MS);
      if (tokens.length) {
        // A poll can still land inside the upstream's recompute interval — a
        // cache that expired a moment before the origin produced the next
        // reading — and return byte-identical numbers. Those still get a history
        // sample, so the line always reaches "now". What they must NOT do is
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

        // The pool ranks; the wider list answers "what is this coin doing?".
        // Keying the lookup on the pool meant a coin that left it had no price
        // and no volume anywhere — reported as zero, which reads as a dead
        // market rather than as the demotion the round is scored on, or as the
        // liquidity reading that blinked.
        this.watched = watched;
        this.bySymbol = new Map(watched.map((t) => [t.symbol, t]));
        this.rerank();
        // Identities for the pool only. Everything wider is a coin no round has
        // raced, and `meta` is never evicted — remembering the whole page would
        // grow the table by the upstream's page size rather than by the game's.
        this.remember(this.tokens);
        // Freshness is the data's own time against the clock, not whether a
        // fetch succeeded. A response that arrives promptly and carries data
        // computed five hours ago is a successful fetch of stale data, and
        // calling that "live" is how an empty chart became a mystery.
        //
        // The older of the two clocks, so a provider that stamps frozen numbers
        // as new is caught by the slots, and one that is ahead of the chain
        // somehow is held to its own stamp.
        this.lagMs =
          chainSlot != null && slot != null ? Math.max(0, chainSlot - slot) * SLOT_MS : null;
        const describes = this.lagMs == null ? asOf : Math.min(asOf, received - this.lagMs);
        if (changed) this.updatedAt = describes;
        this.status = received - this.updatedAt > STALE_AFTER_MS ? "stale" : "live";
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
      return wait;
    } catch (err) {
      this.failures++;
      // One failed request does not make the numbers in hand any older. The
      // board says it is degraded once they are too old to call live — which
      // `isLive` works out from the clock regardless — rather than at the first
      // blip, when nothing a player can see has changed.
      if (Date.now() - this.updatedAt > STALE_AFTER_MS) this.status = "degraded";
      console.warn("⚠  oracle refresh:", err instanceof Error ? err.message : err);
      const asked = err instanceof UpstreamError ? err.retryInMs : undefined;
      return Math.min(
        MAX_BACKOFF_MS,
        asked ?? MIN_POLL_MS * 2 ** Math.min(this.failures - 1, 10)
      );
    }
  }

  /**
   * Follow these symbols until told otherwise — the live round's field.
   *
   * A round names ten coins and then runs for its length; where they sit on the
   * board after that is the thing being bet on, not a reason to stop measuring
   * them. Called from the one place that already answers "which round is live",
   * so a restart, a chain tick and an API poll all re-assert the same field.
   *
   * An empty set is the honest state between rounds: nothing is owed a trail
   * and the board is all there is.
   */
  track(symbols: Iterable<string>): void {
    this.tracked = new Set(symbols);
    // Now rather than at the next poll: who is racing depends on the field, and
    // a round opening or closing changes the field.
    this.rerank();
  }

  /**
   * Who is racing, busiest first, and the pool cut from it.
   *
   * **Eligibility decides who enters a round, not who is scored in one.**
   *
   * The liquidity floor and the stablecoin rules pick the field when a round
   * opens. Applying them again on every poll meant a field coin whose liquidity
   * dipped under the floor — $240k against $250k, on a coin turning over $2.6m
   * an hour and second on the board by volume — vanished from the ranking and
   * stood at `BOARD_SIZE + 1`: last on the board, and scored there at the cut,
   * while its row showed the volume of a coin near the top. A liquidity reading
   * that blinks is not an outcome, and it must not decide one; it would also
   * hand anyone who can pull a pool's liquidity at the cut a way to settle a
   * LOWER. So the live round's field ranks by volume like everything else, for
   * as long as the round lasts.
   */
  private rerank(): void {
    this.ranked = this.watched.filter((t) => t.racing || this.tracked.has(t.symbol));
    this.tokens = this.ranked.slice(0, POOL);
  }

  /**
   * A coin's place among the racers, or null if it is not one of them just now —
   * it may still be watched, and still have numbers. Ranks past the pool are
   * real positions, not "off the board": the board is the top BOARD_SIZE of
   * these, and a rank is a standing among coins that could take each other's
   * place.
   */
  private rankOf(symbol: string): number | null {
    const i = this.ranked.findIndex((t) => t.symbol === symbol);
    return i < 0 ? null : i + 1;
  }

  /**
   * Tracked coins a given set has already lost — the round's field, minus
   * whatever is still in the board or pool being written.
   *
   * This is the set that used to fall silent: relegation removed a coin from
   * every list the recorder looked at, so its trail ended mid-round and only
   * resumed if it climbed back.
   */
  private strays(within: TrendingToken[]): TrendingToken[] {
    if (!this.tracked.size) return [];
    const have = new Set(within.map((t) => t.symbol));
    const out: TrendingToken[] = [];
    for (const symbol of this.tracked) {
      if (have.has(symbol)) continue;
      const token = this.bySymbol.get(symbol);
      if (token) out.push(token);
    }
    return out.sort((a, b) => b.volume - a.volume);
  }

  /**
   * One measurement, as a sample: everything in `base`, plus the round's field
   * wherever it has got to.
   *
   * The second half is the whole point. A coin can be relegated out of the board
   * and then out of the pool, and every list this recorder had to hand lost it
   * at one of those two steps — so its trail ended mid-round, which is the one
   * stretch of it anybody is looking at. The buffer and the sample table both
   * take their membership from here, so they cannot disagree about who was in
   * the race.
   */
  private sampleAt(t: number, base: TrendingToken[]): Sample {
    const ranks = new Map<string, number>();
    const vols = new Map<string, number>();
    const add = (token: TrendingToken, rank: number) => {
      ranks.set(token.symbol, rank);
      vols.set(token.symbol, token.volume);
    };
    base.forEach((token, i) => add(token, i + 1));
    for (const token of this.strays(base)) {
      // Its real place among everything eligible. `BOARD_SIZE + 1` is what
      // settlement scores a relegated coin at, and it is deliberately not used
      // here: that is a rule about payout, while this is a measurement, and
      // flattening every place below the board into one would have the chart
      // claim a coin stopped moving the moment it dropped.
      add(token, this.rankOf(token.symbol) ?? base.length + 1);
    }
    return { t, ranks, vols };
  }

  /**
   * Snapshot the ordering into history every poll.
   *
   * Trimmed by age rather than by count: the gap between polls is set by the
   * upstream now, so a count would hold a different stretch of time depending
   * on how often it happened to publish.
   */
  private record(): void {
    this.history.push(this.sampleAt(Date.now(), this.tokens));
    const since = Date.now() - HISTORY_MINUTES * 60_000;
    let expired = 0;
    while (expired < this.history.length && this.history[expired].t < since) expired++;
    if (expired) this.history.splice(0, expired);
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
  seedForTest(
    rows: { symbol: string; volume: number; racing?: boolean }[],
    samples = 3
  ): void {
    const at = Date.now();
    this.watched = rows.map((r) => ({
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
      // Racing unless a case says otherwise, which is the ordinary market. The
      // exception is worth being able to write down: a coin can stop qualifying
      // for a poll or two — a liquidity reading that blinks — while trading the
      // whole time, and that is a different state from being relegated.
      racing: r.racing ?? true,
    }));
    // The pool is the prefix of the racers; anything past it is watched, and so
    // is anything that isn't racing at all.
    this.rerank();
    this.bySymbol = new Map(this.watched.map((t) => [t.symbol, t]));
    this.history.length = 0;
    // Through `sampleAt`, so a seeded history has the same membership a polled
    // one does — the pool, plus anything tracked that has fallen out of it.
    // Written out by hand, it quietly sampled coins the real recorder never
    // would, which is the wrong thing for a seam whose whole job is to stand in
    // for a poll.
    for (let n = samples; n > 0; n--) {
      this.history.push(this.sampleAt(at - n * DEFAULT_POLL_MS, this.tokens));
    }
  }
}

export const oracle = new Oracle();
