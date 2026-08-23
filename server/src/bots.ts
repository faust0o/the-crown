import { placeBet, type RoundWithEntries } from "./bets";
import {
  DIRECTIONS,
  creditsToClose,
  fillCents,
  fairCents,
  openRound,
  quoteCents,
  recordFill,
  remainingFraction,
  resetMarket,
  type Direction,
  type RoundBook,
  type Trade as BotTrade,
} from "./market";
import { oracle, BOARD_SIZE, type Standing } from "./oracle/index";
import { prisma } from "./prisma";

/**
 * The market-making desks.
 *
 * They are not simulated any more. Each desk has a real account, capitalised
 * once and never topped up, and every clip it trades is a real `CryptoBet` row
 * placed through the same call a player's bet goes through — same checks, same
 * quote, same atomic debit. Their P&L persists across rounds: a desk that reads
 * the board badly gets poorer and trades smaller, and that is the point.
 *
 * They are also what sets the price. A line's mark is a function of the credits
 * bought on it, not of what the model thinks it is worth; `fairCents` only tells
 * a desk which side to take. So the desks are the counterparty a player is
 * really trading against, and the size they can bring is the only reason the
 * board moves.
 *
 * A desk is in the market continuously. It re-prices every asset it looks at
 * once a second off two things and only two — how far the coin sits from the
 * neighbours it would have to pass or lose to, and how much of the round is left
 * for that to happen in — and then buys whichever leg the book is asking least
 * for against that reading, sized by how much less. Buying the *cheapest* leg
 * rather than the *likeliest* one is what makes the mark converge: a desk stops
 * when the price reaches its number and takes the other side when it overshoots.
 *
 * On top of that sits the ramp, which is about conviction rather than direction.
 * Two gates, and a clip needs both: the signal must have **held** — this desk's
 * direction on this asset unchanged for a stretch — and the round must be
 * **nearly over**. A fresh signal with twenty-five minutes left trades moderately
 * however good it looks. A signal that has held all round trades many times that.
 * That is what keeps the odds from blowing out in the first minutes, and it is
 * what makes reading a move before the desks have finished pricing it profitable.
 *
 * Caught offside, a desk **hedges** rather than turns: it keeps what it holds
 * and buys the other side until its net exposure is back under control. It
 * therefore legitimately runs two positions on one asset in opposite directions,
 * and that hedge flow is what lets a mark come back down.
 *
 * One thing they still never do is invent volume: `volumeDrift` moves only when
 * the oracle publishes genuinely new numbers.
 */

/**
 * A tunable, read from the environment.
 *
 * Falls back rather than trusting `Number`: a typo in an env var yields NaN,
 * which propagates silently through the sizing arithmetic until every clip is
 * NaN, every stake fails its `>= 1` check, and the desks quietly stop trading
 * with nothing anywhere saying why. Found exactly that way.
 */
function tunable(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) ? raw : fallback;
}

/** Credits a desk is capitalised with, once, when its account is created. */
const DESK_BANKROLL = tunable("BOT_BANKROLL", 100_000_000);
/**
 * The share of a line's mispricing a desk closes on one visit, at rest.
 *
 * A desk buys however many credits it takes to move the mark this far toward
 * what it thinks the line is worth — so the clip is denominated in *the error it
 * is correcting*, and a price cannot stay wrong merely because the arithmetic
 * that sized the clip never looked at it. Multiplied by the ramp, so early in a
 * round a desk nudges and by the end it closes most of the gap in one go.
 */
const CLOSE_RATE = tunable("BOT_CLOSE_RATE", 0.003);
/** Never close more than this much of the gap at once, however ripe the ramp. */
const MAX_CLOSE = tunable("BOT_MAX_CLOSE", 0.34);
/** The most of its bankroll a desk will ever put on one clip. */
const MAX_SPEND = tunable("BOT_MAX_SPEND", 0.02);
/**
 * The most of its bankroll a desk will commit to one coin in one round.
 *
 * A position limit, which is the thing every real desk has and this one did not.
 * Sizing by the mispricing is right but unbounded on its own: what it costs to
 * move a mark by a cent scales with the pool, so once a line is nearly right and
 * the pool is enormous, closing the last two cents costs more than the whole
 * round has traded — and the desks, seeing a positive edge, paid it. They put
 * half their capital into correcting rounding.
 *
 * A cap on exposure per coin is the honest way to say no to that, because it is
 * a statement about risk rather than about price: an edge worth a hundred
 * million of someone else's money is not worth a hundred million of yours. It
 * also bounds the round — eight desks, ten coins — at a few per cent of the
 * desks' capital, which is what a market's turnover should look like against the
 * balance sheet behind it.
 */
const MAX_ASSET_EXPOSURE = tunable("BOT_MAX_ASSET_EXPOSURE", 0.008);
/**
 * How much bigger than ordinary a fully-ripened signal trades: `e^RAMP_K`.
 *
 * Load-bearing, and now the *only* thing standing between a player and the
 * desks. The book does not damp anything — a line's price is its share of the
 * credits staked on the coin, full stop — so what keeps the odds from arriving
 * before anyone can trade them is that the desks accumulate slowly at first and
 * hard into the close, and nothing else does.
 *
 * At 8 that protection was so lopsided it became the opposite problem: the
 * exponent put nine tenths of a round's credits into its final tenth, so a coin
 * that had climbed at minute six and held sat at its opening print until minute
 * twenty and then gapped. Five spreads the same accumulation across the round —
 * the mark starts moving as soon as the desks agree and keeps lagging fair value
 * the whole way, which is the window a player is paid for reading.
 */
const RAMP_K = tunable("BOT_RAMP_K", 5);
/**
 * How much of the gap a desk closes per arrival while it is offside on an asset:
 * flat in about three fills, which is a hedge rather than a change of heart.
 */
const HEDGE_RATE = tunable("BOT_HEDGE_RATE", 0.35);

/**
 * How often a desk re-prices the board and trades.
 *
 * A desk is always in the market. It re-derives its view from scratch every
 * second and acts on it, rather than waking on a Poisson clock and again
 * whenever the oracle published — under that schedule a desk saw an asset a
 * handful of times a round, so the mark only caught up with the board in bursts
 * and mostly did not catch up at all. Continuous re-pricing is what makes the
 * tape read like a market being made rather than like news being reacted to.
 *
 * The signal itself still only moves when the oracle does, so most ticks
 * re-affirm what the desk already believed — which is the point: that is the
 * accumulation the book prices off.
 */
const TICK_MS = tunable("BOT_TICK_MS", 1_000);

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * How much bigger than ordinary this desk's clip is right now.
 *
 * `persistence` is how long it has held this direction on this asset as a
 * fraction of the round; `urgency` is how much of the round has run. Their
 * *product* goes in the exponent, so both have to be high — a long-held signal
 * early is still early, and a brand-new signal late is still a guess. Only a
 * signal that has held and a round that is nearly over gets the full `e^RAMP_K`.
 *
 * Note a signal cannot have held longer than the round has run, so persistence
 * is bounded above by urgency and the exponent by `urgency²`: the ramp is
 * genuinely back-loaded rather than merely gated.
 */
export function ramp(persistence: number, urgency: number): number {
  return Math.exp(RAMP_K * clamp(persistence, 0, 1) * clamp(urgency, 0, 1));
}

/**
 * How far through its *betting* window the round is — the ramp's urgency.
 *
 * Not how far through the round: betting closes at `lockAt`, a minute before the
 * end, and after that a desk cannot trade at all. Measuring urgency against the
 * moment its opportunity actually runs out is what makes the price arrive while
 * there is still somebody to trade with, instead of a minute after the book shut.
 */
export function urgencyOf(round: RoundBook, now: number): number {
  const close = (round.lockAt ?? round.endsAt).getTime();
  const total = close - round.startsAt.getTime();
  if (!(total > 0)) return 1;
  return clamp(1 - (close - now) / total, 0, 1);
}

const DESKS = [
  "Vega",
  "Kappa",
  "Halcyon",
  "Lattice",
  "Quanta",
  "Tessera",
  "Meridian",
  "Cinder",
  "Orbit",
  "Sable",
] as const;
const SUFFIX = ["Capital", "Systems", "Desk", "Labs", "Partners", "Trading"] as const;

/** Fold integers into one 32-bit key (FNV-1a). */
function key(...nums: number[]): number {
  let h = 2166136261 >>> 0;
  for (const n of nums) h = Math.imul(h ^ (n >>> 0), 16777619);
  return h >>> 0;
}

/** Seeded uniform [0,1). Stateless per call site — same seed, same draw. */
function rand(seed: number): number {
  const s = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

interface Bot {
  id: number;
  name: string;
  /** Multiplies the ordinary clip, so the desks don't all trade the same size. */
  size: number;
}

/**
 * Identity is a pure function of the id, so a desk keeps its name — and now its
 * account, which is keyed on that name — across restarts.
 */
function makeBot(id: number): Bot {
  const s = key(id, 0x1d1);
  return {
    id,
    name: `${DESKS[id % DESKS.length]} ${SUFFIX[Math.floor(rand(s) * SUFFIX.length)]}`,
    size: 0.4 + rand(key(s, 2)) * 2.2,
  };
}

const BOTS: Bot[] = Array.from({ length: 8 }, (_, i) => makeBot(i));

/**
 * The desks' names, in id order.
 *
 * Exported so the seeder can open an account per desk without reconstructing the
 * naming — a desk's account is keyed on its name, so the two agreeing is what
 * makes seeding idempotent across restarts.
 */
export const DESK_NAMES: string[] = BOTS.map((b) => b.name);

let sequence = 0;

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

interface Account {
  userId: string;
  /** Last balance read, so sizing does not need a query per arrival. */
  credits: number;
  readAt: number;
}
const accounts = new Map<number, Account>();
/** How long a cached balance is good for before it is re-read. */
const BALANCE_TTL_MS = 10_000;

/**
 * Create the desks' accounts if they are not there yet.
 *
 * `isDesk` is the whole isolation mechanism: no invite code is consumed, no
 * session row is ever created, and every player-facing query filters on it. A
 * desk is unreachable as a player because nothing anywhere can mint a session
 * for one — `redeemInvite` only ever creates a *new* account.
 *
 * Deliberately not an upsert on `credits`. A desk's balance is its P&L, and a
 * restart must not quietly refill a desk that traded itself broke.
 */
export async function seedDesks(): Promise<void> {
  for (const bot of BOTS) {
    const existing = await prisma.user.findUnique({ where: { handle: bot.name } });
    if (existing) {
      if (existing.isDesk) accounts.set(bot.id, account(existing.id, existing.credits));
      continue;
    }
    try {
      const created = await prisma.user.create({
        data: { handle: bot.name, credits: DESK_BANKROLL, isDesk: true },
      });
      accounts.set(bot.id, account(created.id, created.credits));
    } catch {
      // Lost the race with another process opening the same desk — take theirs.
      const theirs = await prisma.user.findUnique({ where: { handle: bot.name } });
      if (theirs?.isDesk) accounts.set(bot.id, account(theirs.id, theirs.credits));
    }
  }
}

const account = (userId: string, credits: number): Account => ({
  userId,
  credits,
  readAt: Date.now(),
});

/**
 * What this desk has to trade with.
 *
 * Cached: sizing happens on every arrival and the balance only moves on a fill
 * or a settlement. A stale-high reading is harmless — `placeBet` debits
 * conditionally, so the worst case is a refusal we treat as "not today".
 */
async function bankroll(deskId: number): Promise<Account | null> {
  const held = accounts.get(deskId);
  if (!held) return null;
  if (Date.now() - held.readAt < BALANCE_TTL_MS) return held;
  const fresh = await prisma.user.findUnique({ where: { id: held.userId } });
  if (!fresh) return null;
  const next = account(held.userId, fresh.credits);
  accounts.set(deskId, next);
  return next;
}

/** Test seam — hand the desks accounts without a database. */
export function setDeskAccounts(credits = DESK_BANKROLL): void {
  accounts.clear();
  for (const bot of BOTS) accounts.set(bot.id, account(`desk-${bot.id}`, credits));
}

// ---------------------------------------------------------------------------
// What each desk believes, per asset
// ---------------------------------------------------------------------------

interface Book {
  /** The direction this desk currently backs on this asset. */
  signal: Direction;
  /** When it acquired that belief — the ramp's anchor, not the round's start. */
  since: number;
  /** Credits it has put on each direction of this asset this round. */
  staked: Partial<Record<Direction, number>>;
}
const books = new Map<string, Book>();
/** Which round those beliefs belong to. They do not outlive it. */
let booksRound: string | null = null;

/**
 * How much a desk needs to buy to get square, not how much it feels like buying.
 *
 * It cannot sell — there is no selling here, and a real desk caught offside does
 * not liquidate either; it buys the other side until its net exposure is back
 * under control. So the hedge is sized against the exposure it is offsetting
 * rather than against the ramp, which is the only way it can be big enough to
 * matter: the ramp's clock restarts on a flip, and a clip that had ripened for
 * twenty minutes cannot be answered by one that started ten seconds ago.
 *
 * Self-limiting, and that is the point. It is what the desk is *net* down by, so
 * it shrinks with every hedge fill and reaches zero the moment the two sides are
 * level — at which point the desk goes back to trading its ordinary ramp.
 */
function hedgeStake(book: Book, signal: Direction): number {
  let offside = 0;
  for (const direction of DIRECTIONS) {
    if (direction !== signal) offside += book.staked[direction] ?? 0;
  }
  const onside = book.staked[signal] ?? 0;
  return Math.max(0, offside - onside) * HEDGE_RATE;
}

export interface Intent {
  direction: Direction;
  stake: number;
  /** Every leg's fair value, which the book needs to mark the untradable ones. */
  model: Record<Direction, number>;
  /** Whether this arrival found the desk's signal changed since it last looked. */
  flipped: boolean;
  /** Cents of value the model saw in the leg it took, against the book's ask. */
  edge: number;
}

/**
 * The book a desk is pricing against.
 *
 * Injected rather than imported, because there are now two of them and they must
 * not be allowed to drift. In production the book is `RoundEntry.flow` on-chain;
 * in the tests it is the in-memory market, which is the only way to run a round's
 * worth of accumulation without a validator and thousands of transactions.
 *
 * A desk's *reasoning* is the same either way and lives below. What changes is
 * only where the numbers it reasons about come from — so this seam is the whole
 * of the difference, and there is no second copy of the decision to keep in step.
 */
export interface MarketView {
  quote(symbol: string, direction: Direction): { mark: number; ask: number; bid: number } | null;
  creditsToClose(
    symbol: string,
    direction: Direction,
    fairCents: number,
    fraction: number
  ): number;
}

/** The process-local book. What the tests and the simulation path price against. */
export const inMemoryMarket: MarketView = {
  quote: (symbol, direction) => quoteCents(symbol, direction),
  creditsToClose: (symbol, direction, fair, fraction) =>
    creditsToClose(symbol, direction, fair, fraction),
};

/**
 * What a desk trades on a line it has no argument with, as a fraction of its
 * bankroll.
 *
 * Sizing by the mispricing means a correctly-priced line asks for nothing, and a
 * market whose desks fall silent the moment they agree with it is not a market —
 * the tape stops, the depth panel empties, and a player watching a fair price
 * sees an abandoned one. So a desk keeps turning over a token clip regardless.
 * Small enough by two orders of magnitude that it is noise against the pool: it
 * keeps the book alive without being able to argue with it.
 */
const PRESENCE_CLIP = tunable("BOT_PRESENCE_CLIP", 0.0000001);

/**
 * What this desk wants to do on this asset right now.
 *
 * The desk prices all three legs off the signal, then takes **the one the book is
 * asking least for relative to that** — not simply the one most likely to happen.
 * Those come apart constantly and the difference is the whole character of the
 * market: backing the likeliest outcome regardless of price is a desk that keeps
 * buying a line it already ran to the bound, while buying the largest discount is
 * a desk that stops when the mark reaches its number, and turns round and buys
 * the other side when the mark overshoots. The second one is why the mark
 * converges on the signal during a round rather than pinning at an extreme, and
 * why a player who reads a move first is trading against something that will
 * eventually agree with them rather than against something that never stops.
 *
 * Split out from the placing of the bet so a test can run a round's worth of
 * accumulation — the only way to say anything about where prices end up — without
 * ten thousand round-trips to Postgres.
 */
export function deskIntent(opts: {
  deskId: number;
  entry: RoundBook["entries"][number];
  standing: Standing;
  board: Standing[];
  remaining: number;
  /** How far through the betting window the round is — see `urgencyOf`. */
  urgency: number;
  /** Length of that betting window, which is what persistence is measured in. */
  windowMs: number;
  credits: number;
  now?: number;
  /** Where the prices come from. Defaults to the process-local book. */
  market?: MarketView;
}): Intent | null {
  const { deskId, entry, standing, board, remaining, urgency, windowMs, credits } = opts;
  const now = opts.now ?? Date.now();
  const market = opts.market ?? inMemoryMarket;

  // Price every leg off the signal, and measure each against what the book wants
  // for it. The losing legs' values are what the book needs in order to mark the
  // outcomes that are real but have no line.
  //
  // Two different answers come out of this loop and conflating them cost the
  // desks their bankroll. `view` is the outcome this desk believes in — what it
  // would say if you asked. `favoured` is the leg it buys, which is whichever is
  // furthest below what the desk thinks it is worth, and that is a different
  // question: a desk convinced of HIGHER buys DRAW when the book has marked
  // HIGHER up past its number. Only the first is a change of mind.
  const model = {} as Record<Direction, number>;
  let view: Direction | null = null;
  let favoured: Direction | null = null;
  let edge = 0;
  for (const direction of DIRECTIONS) {
    model[direction] = fairCents(standing, board, direction, entry.startRank, remaining);
    const quote = market.quote(entry.symbol, direction);
    if (!quote) continue; // the crown, or a leg that cannot happen
    if (view === null || model[direction] > model[view]) view = direction;
    // What the desk thinks it is worth, less what it would have to pay.
    const value = model[direction] - quote.ask;
    if (favoured === null || value > edge) {
      favoured = direction;
      edge = value;
    }
  }
  if (!favoured || !view) return null;

  const id = `${deskId}|${entry.symbol}`;
  let book = books.get(id);
  // A new view starts its own clock. Desks notice a flip whenever they next
  // arrive on the asset, which is at different moments for each of them — that
  // stagger is what makes the board look like participants rather than a chorus.
  const flipped = !!book && book.signal !== view;
  if (!book || flipped) {
    book = { signal: view, since: now, staked: book?.staked ?? {} };
    books.set(id, book);
  }

  const persistence = windowMs > 0 ? (now - book.since) / windowMs : 0;
  const bot = BOTS[deskId % BOTS.length];

  // A desk trades *to a price*, not to a size.
  //
  // This is the whole difference between a market that arrives and one that
  // merely drifts. Sizing a clip in credits — a slice of bankroll times a ramp —
  // says nothing about how wrong the price currently is, so a line twenty cents
  // adrift got the same clip as one that was already right, and a coin that had
  // demonstrably climbed two places could sit at a third of what it was worth
  // all round because the arithmetic that set the clip had never heard of the
  // mark. Asking the book how many credits would close the gap, and buying that,
  // removes the question: whatever the pool is, the desk knows what moving it
  // costs and can pay it.
  //
  // What the ramp now scales is the *fraction* of the mispricing a desk closes
  // on this visit — small early, most of it by the end. That is the same
  // back-loading as before and it protects the same window, but it is expressed
  // in the units that matter. A desk cannot leave a price wrong just because it
  // happens to be poor; it can only be slow to correct it.
  const closing = clamp(
    CLOSE_RATE * ramp(persistence, urgency) * bot.size *
      (0.6 + rand(key(sequence, deskId, 0x512e)) * 0.8),
    0,
    MAX_CLOSE
  );
  // The presence clip has a floor of one credit, and it needs one.
  //
  // As a bare fraction of bankroll it silently stops existing when the bankroll
  // shrinks: at the in-memory desks' hundred million it was ten credits, and at
  // the chain desks' five million it is half of one, which floors to nothing.
  // The whole point of it is that a correctly-priced line still gets traded — a
  // market whose desks fall silent the moment they agree with it shows a player
  // watching a fair price an abandoned one. That failure is invisible in exactly
  // the case it matters: prices are right, so nothing looks wrong, and the tape
  // is simply empty.
  //
  // One credit is noise against a pool of hundreds of thousands, which is what
  // makes it safe to guarantee rather than merely aim for.
  const wanted = Math.max(
    market.creditsToClose(entry.symbol, favoured, model[favoured], closing),
    Math.max(1, credits * PRESENCE_CLIP)
  );

  // Whichever is larger: what it wants to buy, or what it needs to buy to stop
  // being short the outcome it now believes in. Measured against the view rather
  // than against the leg being bought — a desk buying the cheap leg of an asset
  // it is already long is executing, not scrambling, and sizing that against its
  // whole position turns ordinary trading into a feedback loop.
  const wantedOrOwed =
    favoured === view ? Math.max(wanted, hedgeStake(book, view)) : wanted;

  // What this desk has left before it is as long this coin as it is willing to
  // be. Counted across both directions, since a hedge is exposure too.
  const committed = DIRECTIONS.reduce((sum, d) => sum + (book.staked[d] ?? 0), 0);
  const room = credits * MAX_ASSET_EXPOSURE - committed;

  // A broke desk — or one already full on this coin — simply does not trade: no
  // clip, no throw, and nothing anywhere that could take it below zero.
  const stake = Math.min(
    Math.floor(wantedOrOwed),
    Math.floor(credits * MAX_SPEND),
    Math.floor(room),
    credits
  );
  if (!(stake >= 1)) return null;

  return { direction: favoured, stake, model, flipped, edge };
}

/**
 * Book a fill: the ledger, the flow that moves the price, and the desk's own
 * record of what it now holds on this asset.
 */
function bookFill(opts: {
  deskId: number;
  entry: RoundBook["entries"][number];
  standing: Standing;
  intent: Intent;
  cents: number;
  at: number;
}): BotTrade {
  const { deskId, entry, standing, intent, cents, at } = opts;
  const bot = BOTS[deskId % BOTS.length];
  const fill: BotTrade = {
    id: `${sequence++}-${deskId}`,
    at,
    bot: bot.name,
    symbol: entry.symbol,
    ticker: entry.ticker,
    imageUrl: standing.imageUrl,
    direction: intent.direction,
    size: intent.stake,
    cents,
  };

  const book = books.get(`${deskId}|${entry.symbol}`);
  if (book) {
    book.staked[intent.direction] = (book.staked[intent.direction] ?? 0) + intent.stake;
  }
  const held = accounts.get(deskId);
  if (held) held.credits = Math.max(0, held.credits - intent.stake);

  recordFill(fill, intent.model);
  return fill;
}

/** Forget every belief when the round they were about changes. */
function rollBooks(roundId: string): void {
  if (roundId === booksRound) return;
  books.clear();
  booksRound = roundId;
}

/**
 * Record a fill the desks made somewhere other than here.
 *
 * `books` is where `MAX_ASSET_EXPOSURE` and `hedgeStake` read a desk's position
 * from, and until this existed the only thing that ever wrote to it was
 * `bookFill` on the Postgres arrival path. The chain desks call `deskIntent` —
 * reading these very entries, under the same desk ids — and then place their bet
 * on chain without telling this map anything.
 *
 * So the one position limit in the system was being computed for a chain desk
 * out of a *different* desk's trades, and `hedgeStake` read the same foreign
 * numbers. Neither failure is visible: the desks keep trading and nothing logs a
 * cap that was never reached.
 *
 * Separate from `bookFill` because the rest of what that does is Postgres-path
 * bookkeeping — decrementing an in-memory credit balance the chain desks do not
 * have, and emitting a tape entry the chain path emits for itself.
 */
export function recordChainStake(opts: {
  roundId: string;
  deskId: number;
  symbol: string;
  direction: Direction;
  stake: number;
}): void {
  // The chain path is the only caller, so the roll has to happen here too —
  // otherwise a book opened in one round is still being added to in the next.
  rollBooks(opts.roundId);
  const book = books.get(`${opts.deskId}|${opts.symbol}`);
  if (!book) return;
  book.staked[opts.direction] = (book.staked[opts.direction] ?? 0) + opts.stake;
}

// ---------------------------------------------------------------------------
// Arrivals
// ---------------------------------------------------------------------------

/**
 * One desk's arrival: it buys the leg the model favours on one asset, for real.
 *
 * The bet goes through `placeBet`, which is the player path — so a desk is
 * refused for a locked round, the crown, a closed leg or an empty balance
 * exactly as a player would be, and cannot bet itself negative. A refusal is not
 * an error here; it is a desk deciding not to trade, which is an ordinary thing
 * for a desk to do.
 *
 * The fill then moves the price, because price is order flow. Nothing else does.
 */
export async function tradeOnArrival(
  deskId: number,
  opts: { symbol?: string; standings?: Standing[]; round?: RoundWithEntries | null } = {}
): Promise<BotTrade | null> {
  const board = (opts.standings ?? oracle.standings(BOARD_SIZE)).slice(0, BOARD_SIZE);
  if (!board.length) return null;

  const live = "round" in opts ? opts.round : await liveRound();
  if (!live) return null;

  openRound(live);
  rollBooks(live.id);

  const at = Date.now();
  const remaining = remainingFraction(live);

  const entry = opts.symbol
    ? live.entries.find((e) => e.symbol === opts.symbol)
    : live.entries[Math.floor(Math.random() * live.entries.length)];
  if (!entry) return null;

  const held = await bankroll(deskId);
  if (!held) return null; // no account yet; the desks are not open for business

  // Driven off the round's entries, not the live board: a coin that has dropped
  // out still has positions on it, and its lines still have to be priced.
  const standing = board.find((s) => s.symbol === entry.symbol) ?? delisted(entry);
  const intent = deskIntent({
    deskId,
    entry,
    standing,
    board,
    remaining,
    urgency: urgencyOf(live, at),
    windowMs: live.lockAt.getTime() - live.startsAt.getTime(),
    credits: held.credits,
    now: at,
  });
  if (!intent) return null;

  const placed = await placeBet({
    prisma,
    userId: held.userId,
    round: live,
    symbol: entry.symbol,
    direction: intent.direction,
    stake: intent.stake,
  });
  if (!placed.ok) {
    // Most likely the balance moved under the cached reading, or the round just
    // locked. Re-read next time rather than guessing.
    held.readAt = 0;
    return null;
  }

  return bookFill({ deskId, entry, standing, intent, cents: placed.cents, at });
}

/**
 * The same decision and the same price impact, without the `CryptoBet` row.
 *
 * Test seam. A round is thousands of arrivals and the questions worth asking of
 * this — where does the price end up, how far does it stray from the model,
 * does it run away early — need all of them.
 */
export function simulateArrival(
  deskId: number,
  opts: { symbol: string; standings: Standing[]; round: RoundBook; now?: number }
): BotTrade | null {
  const board = opts.standings.slice(0, BOARD_SIZE);
  if (!board.length) return null;

  openRound(opts.round);
  rollBooks(opts.round.id);

  const at = opts.now ?? Date.now();
  const entry = opts.round.entries.find((e) => e.symbol === opts.symbol);
  if (!entry) return null;

  const held = accounts.get(deskId);
  if (!held) return null;

  const standing = board.find((s) => s.symbol === entry.symbol) ?? delisted(entry);
  const intent = deskIntent({
    deskId,
    entry,
    standing,
    board,
    remaining: remainingFraction(opts.round, at),
    urgency: urgencyOf(opts.round, at),
    windowMs:
      (opts.round.lockAt ?? opts.round.endsAt).getTime() - opts.round.startsAt.getTime(),
    credits: held.credits,
    now: at,
  });
  if (!intent) return null;

  // The same price `placeBet` would charge, walked through the pool by this
  // clip's own size — otherwise a simulated round is cheaper than a real one and
  // says the wrong thing about where prices end up.
  const cents = fillCents(entry.symbol, intent.direction, intent.stake);
  if (cents == null) return null;
  return bookFill({ deskId, entry, standing, intent, cents, at });
}

/**
 * Where a coin that has fallen out of the board stands. `recordCut` settles it
 * as one place below the last visible slot, so the book has to price it there or
 * the market and the settlement would disagree at the cut.
 */
function delisted(entry: RoundBook["entries"][number]): Standing {
  const meta = oracle.metaFor(entry.symbol);
  return {
    symbol: entry.symbol,
    ticker: entry.ticker,
    // Falling off the board costs a coin its market data, not its identity —
    // the mark and the name are still on file, and the fills this standing
    // produces carry them into the ledger.
    name: meta?.name ?? entry.ticker,
    imageUrl: meta?.imageUrl ?? null,
    rank: BOARD_SIZE + 1,
    previousRank: null,
    quoteVolume: 0,
    price: 0,
    trades1h: 0,
    wallets1h: 0,
    priceChange1hPercent: 0,
  };
}

// ---------------------------------------------------------------------------
// What the desks hold
// ---------------------------------------------------------------------------

let tapeCache: { until: number; rows: BotTrade[] } | null = null;
const TAPE_TTL_MS = 2_000;

/**
 * What the desks are holding, most recently added to first.
 *
 * Read from the bets themselves rather than from a ring in memory: the desks
 * have accounts and their positions are `CryptoBet` rows like anyone's, so the
 * panel and the portfolio cannot disagree about what a desk owns. One row per
 * (desk, asset, direction) — a desk that has hedged shows twice on one asset,
 * once each way, and that pair *is* its net exposure.
 *
 * `size` is credits at risk, not shares: credits are what moves the price now,
 * and what a desk has actually committed is the honest number to show.
 */
export async function botTape(limit = 40): Promise<BotTrade[]> {
  if (tapeCache && Date.now() < tapeCache.until) return tapeCache.rows.slice(0, limit);

  const round = await liveRound();
  const ids = [...accounts.values()].map((a) => a.userId);
  if (!round || !ids.length) return [];

  const grouped = await prisma.cryptoBet.groupBy({
    by: ["userId", "symbol", "direction"],
    where: { roundId: round.id, userId: { in: ids } },
    _sum: { stake: true },
    _max: { openedAt: true },
  });

  const nameOf = new Map<string, string>();
  for (const [deskId, held] of accounts) nameOf.set(held.userId, BOTS[deskId % BOTS.length].name);
  const tickerOf = new Map(round.entries.map((e) => [e.symbol, e.ticker]));

  const rows = grouped
    .map((row) => ({
      id: `${row.userId}|${row.symbol}|${row.direction}`,
      at: row._max.openedAt?.getTime() ?? 0,
      bot: nameOf.get(row.userId) ?? "Desk",
      symbol: row.symbol,
      ticker: tickerOf.get(row.symbol) ?? row.symbol,
      // From the oracle's token record rather than the live board: a desk holds
      // positions on every entry in the round, and an entry that has since
      // fallen out of the top BOARD_SIZE is absent from `standings()` — which
      // drew exactly those rows, and only sometimes, as lettered discs.
      imageUrl: oracle.metaFor(row.symbol)?.imageUrl ?? null,
      direction: row.direction as Direction,
      size: row._sum.stake ?? 0,
      cents: quoteCents(row.symbol, row.direction as Direction)?.mark ?? 0,
    }))
    .sort((a, b) => b.at - a.at);

  tapeCache = { until: Date.now() + TAPE_TTL_MS, rows };
  return rows.slice(0, limit);
}

/** Test seam: forget the ledger, every belief and every cached read. */
export function resetBots(): void {
  resetMarket();
  books.clear();
  booksRound = null;
  sequence = 0;
  cachedRound = null;
  tapeCache = null;
}

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

/** How long the desks may reuse the round they last read. */
const ROUND_CACHE_MS = 5_000;
let cachedRound: { until: number; round: RoundWithEntries | null } | null = null;

/**
 * The round the book is on, read-only — the desks never open or write one.
 *
 * Cached, because this is on the arrival path and eight desks arrive many times
 * a minute. A round that has already ended is never served from the cache, and a
 * null is cached too, or the gap between rounds would be the busiest the
 * database ever gets.
 */
async function liveRound(): Promise<RoundWithEntries | null> {
  const now = Date.now();
  const usable =
    cachedRound &&
    now < cachedRound.until &&
    (cachedRound.round === null || cachedRound.round.endsAt.getTime() > now);
  if (usable) return cachedRound!.round;

  const round = await prisma.round.findFirst({
    where: { endsAt: { gt: new Date(now) } },
    orderBy: { startsAt: "desc" },
    include: { entries: true },
  });
  cachedRound = { until: now + ROUND_CACHE_MS, round };
  return round;
}

const timers = new Map<number, ReturnType<typeof setTimeout>>();
let running = false;

const complain = (err: unknown) =>
  console.warn("⚠  bots:", err instanceof Error ? err.message : err);

/**
 * Put a desk back on the clock a tick after the one it just finished.
 *
 * Chained rather than an interval, because a tick does a database round trip and
 * an interval would stack a second one on top of a slow write. The next tick is
 * measured from the end of the last, so the desks throttle themselves under load
 * instead of queueing.
 *
 * They no longer wait for the oracle either. A publish used to be the only thing
 * that could change a desk's mind, so the schedule was built around it; a desk
 * that re-prices every second finds the same news within a second of it landing,
 * and does so without eight desks being yanked onto the same moment to do it.
 */
function schedule(deskId: number, delayMs = TICK_MS): void {
  const timer = setTimeout(() => {
    timers.delete(deskId);
    void tradeOnArrival(deskId)
      .catch(complain)
      .finally(() => {
        if (running) schedule(deskId);
      });
  }, delayMs);
  // The desks are never a reason for the process to stay up.
  timer.unref?.();
  timers.set(deskId, timer);
}

/**
 * Start the desks ticking.
 *
 * Idempotent: a second set of timers would double what the desks spend for the
 * life of the process, and it would not announce itself — the board would just
 * move twice as fast as it should.
 *
 * The first ticks are spread across one tick rather than all fired at once. That
 * is about the database, not the market: eight desks opening a transaction on
 * the same millisecond every second is a load spike with no purpose, and the
 * prices they trade at are set by what they buy, not by the order they arrive in.
 */
export function startBots(): void {
  if (running) return;
  running = true;
  for (const bot of BOTS) schedule(bot.id, (TICK_MS * bot.id) / BOTS.length);
}

/** Stop the desks. Safe to call twice, and safe to call before `startBots`. */
export function stopBots(): void {
  running = false;
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
}

/** Test seam — whether the desks are arriving. */
export function botsTicking(): boolean {
  return running;
}

export type { BotTrade };
