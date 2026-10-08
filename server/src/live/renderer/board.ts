/**
 * The race, as the stream knows it: polled from this server's own GraphQL API,
 * exactly as a visitor's browser polls it, so the broadcast can never show a
 * board the site does not.
 *
 * Also decides when a round has been won. See `Board.observe`.
 */

export interface Standing {
  symbol: string;
  ticker: string;
  rank: number;
  quoteVolume: number;
  imageUrl: string | null;
}

export interface Entry {
  symbol: string;
  ticker: string;
  imageUrl: string | null;
  startRank: number;
  cutRank: number | null;
  liveRank: number | null;
  liveVolume: number;
}

export interface Round {
  id: string;
  startsAt: string;
  lockAt: string;
  endsAt: string;
  status: "OPEN" | "LOCKED" | "CUT" | "SETTLED";
  crownSymbol: string | null;
  entries: Entry[];
}

export interface RankPoint {
  t: number;
  symbol: string;
  quoteVolume: number;
}

/** One coin in the race, as the stats count it. */
export interface Mover {
  symbol: string;
  ticker: string;
  imageUrl: string | null;
  from: number;
  to: number;
  volume: number;
}

export interface Race {
  field: Standing[];
  entries: ReadonlyMap<string, Entry>;
  movers: Mover[];
  round: Round | null;
  window: string;
  history: RankPoint[];
}

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

const BOARD = `
  query StreamBoard {
    cryptoStandings { symbol ticker rank quoteVolume imageUrl }
    oracleStatus { window }
    cryptoRankHistory(minutes: 90, maxPoints: 120) { t symbol quoteVolume }
    cryptoRound {
      id startsAt lockAt endsAt status crownSymbol
      entries { symbol ticker imageUrl startRank cutRank liveRank liveVolume }
    }
  }`;

const ROUNDS = `
  query StreamRounds {
    cryptoRounds(limit: 3) {
      id startsAt lockAt endsAt status crownSymbol
      entries { symbol ticker imageUrl startRank cutRank liveRank liveVolume }
    }
  }`;

const POLL_MS = 2_000;
/** How long a finished round is asked after before it is given up on. */
const GIVE_UP_MS = 120_000;

/**
 * Every coin the board has to show: the round's own coins — one pushed off the
 * board stands one below the last slot, where the cut will score it — and any
 * that trended in since, as spectators. The board page builds the same list.
 */
export function fieldOf(round: Round | null, standings: Standing[]): Standing[] {
  if (!round?.entries.length) return standings;
  const live = new Map(standings.map((s) => [s.symbol, s]));
  const inRound = round.entries.map(
    (e): Standing =>
      live.get(e.symbol) ?? {
        symbol: e.symbol,
        ticker: e.ticker,
        rank: e.liveRank ?? e.startRank,
        quoteVolume: e.liveVolume,
        imageUrl: e.imageUrl,
      }
  );
  const entered = new Set(round.entries.map((e) => e.symbol));
  return [...inRound, ...standings.filter((s) => !entered.has(s.symbol))].sort((a, b) => a.rank - b.rank);
}

/** The round's own coins, measured from where each opened. */
export function moversOf(field: Standing[], entries: ReadonlyMap<string, Entry>): Mover[] {
  return (entries.size ? field.filter((s) => entries.has(s.symbol)) : field).map((s) => ({
    symbol: s.symbol,
    ticker: s.ticker,
    imageUrl: s.imageUrl,
    from: entries.get(s.symbol)?.startRank ?? s.rank,
    to: s.rank,
    volume: s.quoteVolume,
  }));
}

export class Board {
  race: Race = { field: [], entries: new Map(), movers: [], round: null, window: "1h", history: [] };
  crowning: Crowning | null = null;
  /** When the last poll answered. A stale board is still drawn; the studio says so. */
  updatedAt = 0;

  private readonly endpoint: string;
  private readonly racing = new Set<string>();
  private readonly announced = new Set<string>();
  private watching: string | null = null;
  private ended: { id: string; since: number } | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(endpoint: string) {
    this.endpoint = endpoint;
  }

  start(): void {
    const loop = async () => {
      await this.poll().catch(() => {});
      this.timer = setTimeout(loop, POLL_MS);
    };
    void loop();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  private async query<T>(query: string): Promise<T> {
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(8_000),
    });
    const body = (await res.json()) as { data?: T };
    if (!body.data) throw new Error(`GraphQL answered ${res.status} with no data`);
    return body.data;
  }

  private async poll(): Promise<void> {
    const data = await this.query<{
      cryptoStandings: Standing[];
      oracleStatus: { window: string } | null;
      cryptoRankHistory: RankPoint[];
      cryptoRound: Round | null;
    }>(BOARD);
    const round = data.cryptoRound;
    const entries = new Map((round?.entries ?? []).map((e) => [e.symbol, e]));
    const field = fieldOf(round, data.cryptoStandings ?? []);
    this.race = {
      field,
      entries,
      movers: moversOf(field, entries),
      round,
      window: data.oracleStatus?.window ?? "1h",
      history: data.cryptoRankHistory ?? [],
    };
    this.updatedAt = Date.now();
    this.observe(round);

    if (this.ended) {
      if (Date.now() - this.ended.since > GIVE_UP_MS) {
        this.ended = null;
      } else {
        const { cryptoRounds } = await this.query<{ cryptoRounds: Round[] }>(ROUNDS);
        const r = cryptoRounds.find((x) => x.id === this.ended?.id && (x.status === "CUT" || x.status === "SETTLED"));
        if (r) {
          this.crown(r);
          this.ended = null;
        }
      }
    }
  }

  /**
   * A round is crowned when the stream sees its cut: the live round goes from
   * racing (OPEN, LOCKED) to CUT with a coin at rank 1. The cut can land after
   * the round's own end — it waits for a market reading taken after its
   * instant — and then the round simply leaves the board; it is fetched from
   * the finished rounds until it shows how it was cut.
   *
   * Only a round seen racing is ever announced, so a stream that starts in a
   * cut window does not lead with a result from before it went on air, and a
   * round cut with no ranks — refunded, because the feed failed — has no winner
   * and passes without one.
   */
  observe(round: Round | null): void {
    if (!round) return; // between rounds: nothing has changed hands yet
    if (round.status === "OPEN" || round.status === "LOCKED") this.racing.add(round.id);
    else if (this.racing.has(round.id)) this.crown(round);

    const previous = this.watching;
    if (previous && previous !== round.id && this.racing.has(previous) && !this.announced.has(previous)) {
      this.ended = { id: previous, since: Date.now() };
    }
    this.watching = round.id;
  }

  private crown(r: Round): void {
    if (this.announced.has(r.id)) return;
    this.announced.add(r.id);
    const winner = r.entries.find((e) => e.cutRank === 1);
    if (!winner) return;
    this.crowning = {
      roundId: r.id,
      symbol: winner.symbol,
      ticker: winner.ticker,
      imageUrl: winner.imageUrl,
      startRank: winner.startRank,
      startsAt: r.startsAt,
      endsAt: r.endsAt,
      rehearsal: false,
      at: performance.now(),
    };
  }

  /** Run the crown moment on whoever leads now, to see it before the room does. */
  rehearse(): void {
    const leader = this.race.field[0];
    if (!leader) return;
    this.crowning = {
      roundId: `rehearsal-${Date.now()}`,
      symbol: leader.symbol,
      ticker: leader.ticker,
      imageUrl: leader.imageUrl,
      startRank: this.race.entries.get(leader.symbol)?.startRank ?? null,
      startsAt: this.race.round?.startsAt ?? null,
      endsAt: this.race.round?.endsAt ?? null,
      rehearsal: true,
      at: performance.now(),
    };
  }
}
