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

/** One side of a coin's book, aggregated from the tape that sets its price. */
export interface BookLevel {
  direction: Direction;
  /** Last traded price per share, in cents. */
  cents: number;
  /** Shares that changed hands on this line inside the server's book window. */
  size: number;
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

/**
 * Depth for one coin. It can't ride along on BOARD — that query takes no symbol
 * and the book is per-coin — so it is its own round trip, polled at the same
 * cadence so the bars and the board's price chips are never more than a tick
 * apart.
 */
export const CRYPTO_BOOK: TypedDocumentNode<
  { cryptoBook: BookLevel[] },
  { symbol: string }
> = gql`
  query CryptoBook($symbol: String!) {
    cryptoBook(symbol: $symbol) {
      direction
      cents
      size
    }
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

/** Settled rounds, for the results + verification panel. */
export const ROUNDS: TypedDocumentNode<{ cryptoRounds: Round[] }, { limit?: number }> = gql`
  query CryptoRounds($limit: Int) {
    cryptoRounds(limit: $limit) { ${ROUND_FIELDS} }
  }
`;

export const CASH_OUT: TypedDocumentNode<
  { cashOutCryptoBet: CryptoBet },
  { id: string }
> = gql`
  mutation CashOutCryptoBet($id: ID!) {
    cashOutCryptoBet(id: $id) {
      id
      status
      payout
      cutRank
    }
  }
`;
