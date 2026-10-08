import { gql, type TypedDocumentNode } from "@apollo/client";
import type { Entry, OracleStatus, RankPoint, Round, Standing } from "../casino/crypto/graphql";

/** An entry as the stream draws it: no book, since nobody bets from the stream. */
export type StreamEntry = Omit<Entry, "lines">;
export type StreamRound = Omit<Round, "entries"> & { entries: StreamEntry[] };

/**
 * The board, as the livestream needs it.
 *
 * The board page's query with the player taken out — no `me`, no bets — and
 * no prices, which the stream never shows. The room watching a broadcast is
 * not signed in as anybody, and neither is the page drawing it.
 */
export const STREAM_BOARD: TypedDocumentNode<
  {
    cryptoStandings: Standing[];
    oracleStatus: OracleStatus;
    cryptoRound: StreamRound | null;
    cryptoRankHistory: RankPoint[];
  },
  { minutes: number }
> = gql`
  query StreamBoard($minutes: Int) {
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
    oracleStatus {
      status
      window
      updatedAt
    }
    cryptoRankHistory(minutes: $minutes, maxPoints: 120) {
      t
      symbol
      rank
      quoteVolume
    }
    cryptoRound {
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
      }
    }
  }
`;
