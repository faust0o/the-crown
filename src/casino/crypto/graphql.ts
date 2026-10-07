import { gql, type TypedDocumentNode } from "@apollo/client";

export type Direction = "HIGHER" | "DRAW" | "LOWER";

export interface Standing {
  symbol: string;
  ticker: string;
  name: string;
  rank: number;
  previousRank: number | null;
  quoteVolume: number;
  price: number;
  imageUrl: string | null;
  trades1h: number;
  wallets1h: number;
  priceChange1hPercent: number;
}

/** A rank change on the board — replaces the exchange trade tape. */
export interface FlowEvent {
  at: number;
  symbol: string;
  ticker: string;
  imageUrl: string | null;
  from: number | null;
  to: number;
  quoteVolume: number;
}

export interface RankPoint {
  t: number;
  symbol: string;
  rank: number;
  quoteVolume: number;
}

export interface Line {
  direction: Direction;
  probability: number;
  multiplier: number;
  cents: number;
  available: boolean;
}

/**
 * A token's identity, independent of the live board.
 *
 * The board only carries the ten coins trending right now, so anything drawing
 * a finished round has to be told what its coins looked like rather than
 * borrowing from `Standing`.
 */
export interface TokenMeta {
  symbol: string;
  ticker: string;
  name: string;
  imageUrl: string | null;
}

export interface Entry {
  symbol: string;
  ticker: string;
  imageUrl: string | null;
  startRank: number;
  startVolume: number;
  cutRank: number | null;
  liveRank: number | null;
  liveVolume: number;
  livePrice: number;
  isCrown: boolean;
  lines: Line[];
}

/**
 * A finished round: what it was, and how it ended.
 *
 * Deliberately without the book. `lines` are live prices on a race that is over,
 * and nothing in the results panel or the replay reads them — while asking for
 * them is what put the history query over the server's cost budget, so it was
 * rejected before a resolver ran and the panel showed "no rounds" forever.
 * `Round` extends this, so anything holding a live round can be replayed.
 */
export interface RoundResult {
  id: string;
  startsAt: string;
  lockAt: string;
  endsAt: string;
  status: "OPEN" | "LOCKED" | "CUT" | "SETTLED";
  commitHash: string;
  seed: string | null;
  cutAt: string | null;
  cutWindowSeconds: number;
  crownSymbol: string | null;
  entries: ResultEntry[];
}

/** An entry as a finished round knows it: where it started, where it ended. */
export interface ResultEntry {
  symbol: string;
  ticker: string;
  imageUrl: string | null;
  startRank: number;
  cutRank: number | null;
  isCrown: boolean;
}

export interface Round {
  id: string;
  startsAt: string;
  lockAt: string;
  endsAt: string;
  status: "OPEN" | "LOCKED" | "CUT" | "SETTLED";
  commitHash: string;
  seed: string | null;
  cutAt: string | null;
  cutWindowSeconds: number;
  /** Coin wearing the crown this round; unbettable. */
  crownSymbol: string | null;
  entries: Entry[];
}

export interface CryptoBet {
  id: string;
  roundId: string;
  ticker: string;
  symbol: string;
  direction: Direction;
  stake: number;
  odds: number;
  startRank: number;
  cutRank: number | null;
  status: "OPEN" | "WON" | "LOST" | "CASHED_OUT" | "VOID";
  payout: number;
  /** Where the coin stands now; null once resolved. */
  liveRank: number | null;
  /** What closing this position would pay right now; null once resolved. */
  liveValue: number | null;
  openedAt: string;
}

/**
 * A sale of part or all of a position — what it would fetch, and what it did.
 *
 * One shape for the quote and the receipt because the server computes them with
 * one function: the price depends on how much is being sold, so "what you would
 * get" is not something the client can derive from a per-lot value.
 */
export interface CryptoSale {
  /** Credits of position closed. Clamped to what is held. */
  sold: number;
  /** Credits returned for them. */
  payout: number;
  /** The price per share it leaves at, in cents. */
  cents: number;
}

export interface OracleStatus {
  status: string;
  /** Ranking window, e.g. "1h". */
  window: string;
  /** When the upstream last published new numbers. */
  updatedAt: number;
}

const BET_FIELDS = `
  id
  roundId
  symbol
  ticker
  direction
  stake
  odds
  startRank
  cutRank
  status
  payout
  liveRank
  liveValue
  openedAt
`;

const ROUND_FIELDS = `
  id
  startsAt
  lockAt
  endsAt
  status
  commitHash
  seed
  cutAt
  cutWindowSeconds
  crownSymbol
  entries {
    symbol
    ticker
    imageUrl
    startRank
    startVolume
    cutRank
    liveRank
    liveVolume
    livePrice
    isCrown
    lines { direction probability multiplier cents available }
  }
`;

/**
 * One round trip for the whole page. The oracle re-ranks every 2s server-side,
 * so the client polls at the same cadence rather than subscribing — same
 * freshness, none of the WebSocket plumbing.
 */
export const BOARD: TypedDocumentNode<
  {
    cryptoStandings: Standing[];
    cryptoFlow: FlowEvent[];
    oracleStatus: OracleStatus;
    cryptoRound: Round | null;
    myCryptoBets: CryptoBet[];
    me: { id: string; handle: string; credits: number } | null;
    cryptoRankHistory: RankPoint[];
  },
  { tape?: number; minutes?: number }
> = gql`
  query CryptoBoard($tape: Int, $minutes: Int) {
    cryptoStandings {
      symbol
      ticker
      name
      rank
      previousRank
      quoteVolume
      price
      imageUrl
      trades1h
      wallets1h
      priceChange1hPercent
    }
    cryptoFlow(limit: $tape) {
      at
      symbol
      ticker
      imageUrl
      from
      to
      quoteVolume
    }
    oracleStatus {
      status
      window
      updatedAt
    }
    me {
      id
      handle
      credits
    }
    cryptoRankHistory(minutes: $minutes, maxPoints: 120) {
      t
      symbol
      rank
      quoteVolume
    }
    cryptoRound { ${ROUND_FIELDS} }
    myCryptoBets { ${BET_FIELDS} }
  }
`;

export const PLACE_BET: TypedDocumentNode<
  { placeCryptoBet: CryptoBet },
  { symbol: string; direction: Direction; stake: number }
> = gql`
  mutation PlaceCryptoBet($symbol: String!, $direction: RankDirection!, $stake: Int!) {
    placeCryptoBet(symbol: $symbol, direction: $direction, stake: $stake) { ${BET_FIELDS} }
  }
`;

/**
 * Everything a finished round needs to be replayed: every ordering the oracle
 * recorded while it ran, and the player's own lots on it.
 *
 * The bets are asked for by round rather than taken from the board query — that
 * one returns the most recent hundred across all rounds, so an old round's
 * positions would silently fall out of it.
 *
 * `roundTokens` rides along for the same reason: the samples carry coins that
 * were never entries, and by the time a round is replayed none of them need
 * still be on the board that would otherwise be lending out their logos.
 */
export const ROUND_REPLAY: TypedDocumentNode<
  { roundReplay: RankPoint[]; roundTokens: TokenMeta[]; myCryptoBets: CryptoBet[] },
  { roundId: string }
> = gql`
  query RoundReplay($roundId: String!) {
    roundReplay(roundId: $roundId) {
      t
      symbol
      rank
      quoteVolume
    }
    roundTokens(roundId: $roundId) {
      symbol
      ticker
      name
      imageUrl
    }
    myCryptoBets(roundId: $roundId) { ${BET_FIELDS} }
  }
`;

/**
 * Finished rounds, for the results + verification panel.
 *
 * Its own selection rather than `ROUND_FIELDS`, and the difference is the point:
 * a finished round has no book, so it asks for no `lines`, no `liveVolume` and
 * no `livePrice`. Twelve rounds of the full shape priced out at 44,621 against a
 * budget of 5,000 — the server rejected the document during validation, Apollo
 * handed back no data, and the panel said "no rounds have settled yet" whatever
 * the database held. Asking for what the panel draws costs about a twentieth of
 * that, and the fields it dropped were ones it never rendered.
 */
export const ROUNDS: TypedDocumentNode<
  { cryptoRounds: RoundResult[] },
  { limit?: number }
> = gql`
  query CryptoRounds($limit: Int) {
    cryptoRounds(limit: $limit) {
      id
      startsAt
      lockAt
      endsAt
      status
      commitHash
      seed
      cutAt
      cutWindowSeconds
      crownSymbol
      entries {
        symbol
        ticker
        imageUrl
        startRank
        cutRank
        isCrown
      }
    }
  }
`;

/**
 * What selling `stake` credits of one line would fetch right now.
 *
 * Polled with the ticket open, and re-asked whenever the amount changes: closing
 * walks the pool back down, so the price is a function of the size and only the
 * server holds that curve. Deriving it here from each lot's `liveValue` would
 * quote a number nobody could be paid — the exact mistake the server's own
 * comments record having made once already.
 */
export const SELL_QUOTE: TypedDocumentNode<
  { cryptoSellQuote: CryptoSale | null },
  { symbol: string; direction: Direction; stake: number }
> = gql`
  query CryptoSellQuote($symbol: String!, $direction: RankDirection!, $stake: Int!) {
    cryptoSellQuote(symbol: $symbol, direction: $direction, stake: $stake) {
      sold
      payout
      cents
    }
  }
`;

/**
 * Sell part or all of a position.
 *
 * Addressed by line — coin and direction — rather than by lot, because that is
 * what a position is to the player holding it. Which rows the server takes it
 * out of is bookkeeping, and it fills oldest first.
 */
export const SELL_POSITION: TypedDocumentNode<
  { sellCryptoPosition: CryptoSale },
  { symbol: string; direction: Direction; stake: number }
> = gql`
  mutation SellCryptoPosition($symbol: String!, $direction: RankDirection!, $stake: Int!) {
    sellCryptoPosition(symbol: $symbol, direction: $direction, stake: $stake) {
      sold
      payout
      cents
    }
  }
`;
