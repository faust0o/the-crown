import { objectType } from "nexus";

export const User = objectType({
  name: "User",
  definition(t) {
    t.nonNull.id("id");
    t.nonNull.string("handle");
    t.nonNull.int("credits");
    /**
     * The wallet this account signs in with.
     *
     * Only ever the caller's own — `User` is returned by `me` and by the
     * sign-in payload and nowhere else. The page needs it to notice when the
     * wallet in front of the player stops being the one the session belongs to.
     */
    t.string("walletAddress");
    t.nonNull.field("createdAt", { type: "DateTime" });
  },
});

/** A nonce to sign, and the exact sentence the wallet will show. */
export const WalletChallenge = objectType({
  name: "WalletChallenge",
  definition(t) {
    t.nonNull.string("nonce");
    t.nonNull.string("message");
  },
});

export const AuthPayload = objectType({
  name: "AuthPayload",
  definition(t) {
    t.nonNull.string("token");
    t.nonNull.field("user", { type: "User" });
  },
});

// ---------- Crypto volume-rank oracle ----------

export const CryptoStanding = objectType({
  name: "CryptoStanding",
  definition(t) {
    t.nonNull.string("symbol");
    t.nonNull.string("ticker");
    t.nonNull.string("name");
    t.nonNull.int("rank");
    /** Rank a minute ago — null until the oracle has that much history. */
    t.int("previousRank");
    t.nonNull.float("quoteVolume");
    t.nonNull.float("price");
    t.string("imageUrl");
    t.nonNull.float("trades1h");
    t.nonNull.float("wallets1h");
    t.nonNull.float("priceChange1hPercent");
  },
});

export const CryptoRankPoint = objectType({
  name: "CryptoRankPoint",
  definition(t) {
    t.nonNull.float("t");
    t.nonNull.string("symbol");
    t.nonNull.int("rank");
    t.nonNull.float("quoteVolume");
  },
});

export const FlowEvent = objectType({
  name: "FlowEvent",
  definition(t) {
    t.nonNull.float("at");
    t.nonNull.string("symbol");
    t.nonNull.string("ticker");
    t.string("imageUrl");
    /** Previous rank, or null if it wasn't ranked before. */
    t.int("from");
    t.nonNull.int("to");
    t.nonNull.float("quoteVolume");
  },
});

/**
 * One real bet, as it happened.
 *
 * Ledger, not decoration — this is a `CryptoBet` row, the same row settlement
 * pays and the same credits that moved the price. It carries a handle because
 * every participant in this market is a person; there is nothing else trading.
 */
export const Order = objectType({
  name: "Order",
  definition(t) {
    t.nonNull.id("id");
    t.nonNull.float("at");
    /** The bettor's pseudonymous handle. */
    t.nonNull.string("handle");
    t.nonNull.string("symbol");
    t.nonNull.string("ticker");
    t.string("imageUrl");
    t.nonNull.field("direction", { type: "RankDirection" });
    t.nonNull.field("kind", { type: "OrderKind" });
    /** Credits staked on a BUY, credits returned on a SELL. */
    t.nonNull.int("credits");
    /** Price per share in cents, on the same scale as RankLine.cents. */
    t.nonNull.int("cents");
    /** Profit or loss against the stake, on a SELL only. */
    t.int("pnl");
  },
});

export const OracleStatus = objectType({
  name: "OracleStatus",
  definition(t) {
    t.nonNull.string("status");
    /**
     * How old the *upstream's* numbers are, in seconds.
     *
     * Not how long ago we fetched them. The feed has served a snapshot five
     * hours old while every fetch succeeded promptly, and with only a fetch
     * timestamp to go on the board reported itself live throughout — so the
     * chart looked broken and the board looked fine, when both were showing the
     * same frozen measurement.
     */
    t.nonNull.int("ageSeconds");
    t.nonNull.string("window");
    t.nonNull.float("updatedAt");
  },
});

export const RankLine = objectType({
  name: "RankLine",
  definition(t) {
    t.nonNull.field("direction", { type: "RankDirection" });
    t.nonNull.float("probability");
    t.nonNull.float("multiplier");
    t.nonNull.int("cents");
    t.nonNull.boolean("available");
  },
});

/**
 * A token's identity, decoupled from whether it is still trending.
 *
 * Everything that draws a coin off the live board can read `imageUrl` from
 * `CryptoStanding`; anything looking at a finished round has to come here, since
 * the board has long since moved on from what that round was racing.
 */
export const TokenMeta = objectType({
  name: "TokenMeta",
  definition(t) {
    t.nonNull.string("symbol");
    t.nonNull.string("ticker");
    t.nonNull.string("name");
    t.string("imageUrl");
  },
});

export const RoundEntry = objectType({
  name: "RoundEntry",
  definition(t) {
    t.nonNull.string("symbol");
    t.nonNull.string("ticker");
    t.string("imageUrl");
    t.nonNull.int("startRank");
    t.nonNull.float("startVolume");
    t.int("cutRank");
    t.int("liveRank");
    t.nonNull.float("liveVolume");
    /** Last trade, so a coin off the board can still price its own row. */
    t.nonNull.float("livePrice");
    t.nonNull.boolean("isCrown");
    t.nonNull.list.nonNull.field("lines", { type: "RankLine" });
  },
});

export const Round = objectType({
  name: "Round",
  definition(t) {
    t.nonNull.id("id");
    t.nonNull.field("startsAt", { type: "DateTime" });
    t.nonNull.field("lockAt", { type: "DateTime" });
    t.nonNull.field("endsAt", { type: "DateTime" });
    t.nonNull.field("status", { type: "RoundStatus" });
    /** sha256(seed), published when the round opens. */
    t.nonNull.string("commitHash");
    /** Revealed only after settlement, so the cut can be verified. */
    t.string("seed");
    t.field("cutAt", { type: "DateTime" });
    t.nonNull.int("cutWindowSeconds");
    /** Coin wearing the crown this round; unbettable. */
    t.string("crownSymbol");
    t.nonNull.list.nonNull.field("entries", { type: "RoundEntry" });
  },
});

export const CryptoBet = objectType({
  name: "CryptoBet",
  definition(t) {
    t.nonNull.id("id");
    t.nonNull.string("roundId");
    t.nonNull.string("symbol");
    t.nonNull.string("ticker");
    t.nonNull.field("direction", { type: "RankDirection" });
    t.nonNull.int("stake");
    t.nonNull.float("odds");
    t.nonNull.int("startRank");
    t.int("cutRank");
    t.nonNull.field("status", { type: "BetStatus" });
    t.nonNull.int("payout");
    /** Where the coin stands now; null once resolved. */
    t.int("liveRank");
    /** What closing this position would pay right now; null once resolved. */
    t.int("liveValue");
    t.nonNull.field("openedAt", { type: "DateTime" });
  },
});

/**
 * A sale of part or all of a position — quoted, or done.
 *
 * One type for both because they have to be the same three numbers. The panel
 * asks what selling would fetch and the mutation says what it fetched, and the
 * moment those are two shapes they become two calculations that can disagree —
 * which is exactly the bug `crypto-views.ts` documents, where the screen quoted
 * the resting bid and the payout used the size-aware one.
 */
export const CryptoSale = objectType({
  name: "CryptoSale",
  definition(t) {
    /** Credits of position closed. Never more than is held. */
    t.nonNull.int("sold");
    /** Credits returned for them. */
    t.nonNull.int("payout");
    /** The price per share it leaves at, in cents. */
    t.nonNull.int("cents");
  },
});

/**
 * What a stake would fill at and pay, before it is placed.
 *
 * The ticket's "to win". Not the board's price times the stake: a stake that is
 * large against the pool moves the line as it fills, and pays the average of
 * that move — see `quoteBet`.
 */
export const CryptoBuyQuote = objectType({
  name: "CryptoBuyQuote",
  definition(t) {
    /** The price the whole stake fills at, in cents. */
    t.nonNull.int("cents");
    /** What a win returns, stake included. */
    t.nonNull.int("payout");
  },
});

export const BookLevel = objectType({
  name: "BookLevel",
  definition(t) {
    t.nonNull.field("direction", { type: "RankDirection" });
    t.nonNull.int("cents");
    t.nonNull.int("size");
  },
});

/**
 * A setup transaction waiting for the player's signature.
 *
 * Base64 rather than a structured shape: what the wallet needs is exactly the
 * bytes the server signed, and re-encoding them through a schema would be an
 * opportunity for the two sides to disagree about a transaction one of them has
 * already committed a signature to.
 */
export const WalletSetup = objectType({
  name: "WalletSetup",
  definition(t) {
    t.nonNull.string("transaction");
    t.nonNull.string("blockhash");
    t.nonNull.int("lastValidBlockHeight");
    t.nonNull.string("relayer");
  },
});




/** A credit purchase waiting for the buyer's signature. */
export const PreparedPurchase = objectType({
  name: "PreparedPurchase",
  definition(t) {
    t.nonNull.string("transaction");
    t.nonNull.string("blockhash");
    t.nonNull.int("lastValidBlockHeight");
    /** Lamports the buyer pays, as a string — it does not fit a 32-bit Int. */
    t.nonNull.string("lamports");
    /** Credits they receive, decided server-side from the rate below. */
    t.nonNull.int("credits");
    t.nonNull.float("solPriceUsd");
  },
});

/** What a confirmed top-up added, and where the balance stands after it. */
export const CreditedPurchase = objectType({
  name: "CreditedPurchase",
  definition(t) {
    /** Credits added by this confirmation. Zero when it was already counted. */
    t.nonNull.int("credits");
    t.nonNull.int("balance");
  },
});
