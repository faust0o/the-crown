import { objectType } from "nexus";

export const User = objectType({
  name: "User",
  definition(t) {
    t.nonNull.id("id");
    t.nonNull.string("handle");
    t.nonNull.int("credits");
    t.nonNull.field("createdAt", { type: "DateTime" });
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
 * A print on the simulated bot tape.
 *
 * Decoration, not ledger: no user, no stored bet, no effect on settlement. The
 * client must label it as simulated so it can never be read as the real flow.
 */
export const BotTrade = objectType({
  name: "BotTrade",
  definition(t) {
    t.nonNull.id("id");
    t.nonNull.float("at");
    /** Desk name, stable for the life of the process. */
    t.nonNull.string("bot");
    t.nonNull.string("symbol");
    t.nonNull.string("ticker");
    t.string("imageUrl");
    t.nonNull.field("direction", { type: "RankDirection" });
    /** Shares changing hands. */
    t.nonNull.int("size");
    /** Price per share in cents, on the same scale as RankLine.cents. */
    t.nonNull.int("cents");
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
