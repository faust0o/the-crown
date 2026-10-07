//! On-chain state.
//!
//! The Prisma schema this replaces is in `server/prisma/schema.prisma`, and the
//! shapes are deliberately not identical. Three things changed in the move:
//!
//! - **Symbols became indices.** A bet used to carry `symbol` and `ticker` as
//!   strings. On-chain a round's entries are numbered, and a bet carries the
//!   index; the strings live once, in the entry. That keeps `Bet` small (they are
//!   the account this program creates most) and makes the book a fixed offset
//!   rather than a map lookup.
//! - **The book moved into the entry.** `market.ts` keeps `flow`, `opening` and
//!   `quoted` in three separate maps keyed by `symbol|direction`. Here they are
//!   `[_; 3]` arrays inside `RoundEntry`, so a fill touches exactly one account
//!   and a quote is one account read. Splitting them across per-leg accounts
//!   would have tripled the write set of the hottest instruction in the program.
//! - **Credits became an SPL token.** `User.credits` is gone. A player's balance
//!   is their token account balance, and the stake behind open bets sits in the
//!   program's vault. There is no row anywhere that says what someone is worth.

use anchor_lang::prelude::*;

/// Fixed-width symbol, padded with zeroes. Long enough for every ticker the
/// oracle has produced and short enough that `RoundEntry` stays small.
pub const SYMBOL_LEN: usize = 16;
pub const TICKER_LEN: usize = 12;

#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, PartialEq, Eq, Debug)]
pub enum RoundStatus {
    /// Betting is live.
    ///
    /// There is no separate "locked" state. Betting closes on `lock_at`, which
    /// `place_bet` checks directly — a status that only ever restated the clock
    /// bought nothing and cost a transaction per round to set.
    Open,
    /// The cut instant passed and ranks were recorded; settling.
    Cut,
    /// Seed revealed, bets payable.
    Settled,
    /// Given up on: the seed was never revealed and never will be, so every
    /// position on it refunds its stake. See `void_round`.
    ///
    /// Appended rather than inserted. The discriminant is the byte on chain, so
    /// putting this anywhere but last would silently re-read every `Settled`
    /// round in existence as something else.
    Voided,
}

#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, PartialEq, Eq, Debug)]
pub enum BetStatus {
    Open,
    Won,
    Lost,
    CashedOut,
    /// No decisive data point for that coin at the cut — stake refunded.
    Void,
}

/// Program-wide configuration, and the authority over the vault.
///
/// The `authority` opens rounds, posts entries and reveals seeds. It is *not*
/// able to move the vault arbitrarily: the vault's authority is this PDA, and the
/// only instructions that sign for it are the payout paths, whose amounts are
/// computed from bets the program itself wrote. That distinction is the whole
/// custody story — a compromised authority key can open a nonsense round, but it
/// cannot transfer a player's stake to itself.
#[account]
#[derive(InitSpace)]
pub struct Config {
    pub authority: Pubkey,
    /// The SPL mint credits are denominated in.
    pub credit_mint: Pubkey,
    /// Rounds opened so far — the seed for the next one.
    pub round_count: u64,
    pub bump: u8,
    /// Bump for the vault authority PDA, cached so payouts don't re-derive it.
    pub vault_bump: u8,
}

/// One round of competition.
///
/// The settlement instant ("the cut") is a random point inside the final minute,
/// so a pump timed at a known deadline cannot decide the outcome. It is committed
/// up front: `commit_hash` = sha256(seed) is published when the round opens,
/// `seed` is revealed at settlement, and `cut_at` is derived from the seed — so
/// anyone can verify the house did not pick a convenient moment. Moving this
/// on-chain is what makes that verification something a player can do without
/// trusting the server to serve them an honest `commitHash`.
#[account]
#[derive(InitSpace)]
pub struct Round {
    pub index: u64,
    pub starts_at: i64,
    /// Betting closes.
    pub lock_at: i64,
    /// `lock_at` plus the cut window.
    pub ends_at: i64,
    pub commit_hash: [u8; 32],
    /// All zeroes until `reveal_seed`. `status == Settled` is what says it has
    /// been revealed; a separate flag restated the same fact.
    pub seed: [u8; 32],
    /// Derived from the seed; set when the cut lands.
    pub cut_at: i64,
    /// The window this round actually used. Stored rather than read from config
    /// at verification time: the cut instant is derived as HMAC(seed, index) mod
    /// this value, so a later config change would otherwise make settled rounds
    /// fail their own verification.
    pub cut_window_seconds: u32,
    /// The coin wearing the crown. It cannot be bet on.
    pub crown_symbol: [u8; SYMBOL_LEN],
    pub status: RoundStatus,
    /// How many coins are on the board, so a reader knows how many entry
    /// accounts to fetch without probing indices.
    pub entry_count: u16,
    pub bump: u8,
}

/// A coin's standing in one round, and the book on it.
///
/// `opening` is what the round's opening auction staked on each leg — the model's
/// one and only word on price, posted by the authority at `add_entry` because
/// computing it needs the priors. From there the mark is this pool's share of the
/// coin's, and every credit traded dilutes it.
#[account]
#[derive(InitSpace)]
pub struct RoundEntry {
    pub round: Pubkey,
    pub index: u8,
    pub symbol: [u8; SYMBOL_LEN],
    pub ticker: [u8; TICKER_LEN],
    pub start_rank: u16,
    /// 0 until the cut is recorded. Ranks are 1-based, so 0 is unambiguous.
    pub cut_rank: u16,
    /// Credits the opening auction staked on each leg.
    pub opening: [u64; 3],
    /// Credits bought on each leg since. The only thing that moves a price.
    pub flow: [u64; 3],
    /// Which legs are on the book. A leg can be real and still not be offered.
    pub quoted: [bool; 3],
    /// Cents the quoted legs divide between them — a hundred, less the share of
    /// any leg that is real but has no line.
    pub target: u16,
    /// The last mark on each leg, so a reader does not have to re-derive them.
    pub last_cents: [u16; 3],
    pub bump: u8,
}

impl RoundEntry {
    /// The book as the pricing module wants it.
    pub fn book(&self) -> crate::pricing::Book {
        let mut staked = [0u64; 3];
        for d in 0..3 {
            staked[d] = self.opening[d].saturating_add(self.flow[d]);
        }
        crate::pricing::Book {
            staked,
            quoted: self.quoted,
            target: self.target,
        }
    }
}

/// Who may place bets on a player's behalf, and out of what allowance.
///
/// This exists because the delegate flow removes the player's signature from
/// `place_bet`, and removing a signature without replacing it with something
/// would leave *anybody* able to trade a delegated player's balance. The SPL
/// allowance bounds how much can be spent; it says nothing about who may spend
/// it or on what. A griefer could not steal the credits, but could burn them on
/// the worst leg on the board, which is not a meaningfully better outcome.
///
/// So the player names a relayer, and `place_bet` requires that relayer's
/// signature. Two independent things now have to hold before a credit moves: the
/// SPL delegate must be this program's PDA, and the caller must be the relayer
/// this account names. The player can end it from either side — `revoke` on the
/// token account, or closing this — and neither needs the server's cooperation.
#[account]
#[derive(InitSpace)]
pub struct Delegation {
    pub owner: Pubkey,
    /// The only key that may place bets for `owner` without `owner` signing.
    pub relayer: Pubkey,
    pub bump: u8,
}

/// A position: everything one owner holds on one leg of one coin.
///
/// **Shares, not a price.** Buying the same leg twice adds to this account rather
/// than opening a second one, and that is lossless because what a position is
/// owed does not depend on how it was assembled: a buy of `s` credits at `c`
/// cents earns `s·100/c` shares, each worth one credit if the leg lands, so two
/// buys are worth exactly the sum of their shares however far apart their prices
/// were.
///
/// `specs/positions-and-bots.md` was right that a position's value cannot be
/// re-derived from *average odds* — that really does lose the information. What it
/// concluded from that was that lots must be stored separately, and storing shares
/// is the other way out: the average entry price is recoverable as
/// `stake·100/shares` for display, and nothing that decides money is computed from
/// it. The client already aggregates by `(round, symbol, direction)` for exactly
/// this reason, so this is the shape a player is shown anyway.
///
/// Why it matters here and not in Postgres: a row costs nothing and an account
/// costs rent. One account per *fill* made the cost of running the market a
/// function of how often the desks traded — fourteen thousand accounts and
/// twenty-eight SOL for a half-hour round at a one-second tick. One account per
/// *position* bounds it at desks × coins × legs, which no tick rate can move. The
/// desks can trade as often as the signal deserves.
///
/// The individual fills are not lost, they are just not *here*: every one emits a
/// `BetPlaced` carrying its own price and the book it left behind, which is what
/// the tape and the lot-by-lot breakdown are built from.
#[account]
#[derive(InitSpace)]
pub struct Bet {
    pub round: Pubkey,
    pub owner: Pubkey,
    pub entry_index: u8,
    pub direction: u8,
    /// Credits put in, cumulative. What the position cost, and what comes back
    /// out of the book's flow when it closes.
    pub stake: u64,
    /// What the position is owed if this leg lands, in credits. The only number
    /// settlement reads.
    pub shares: u64,
    /// Where the coin stood when the round opened — the thing the bet is a claim
    /// about. Copied in so settlement does not need the entry to decide an
    /// outcome it already has the facts for.
    pub start_rank: u16,
    pub status: BetStatus,
    pub payout: u64,
    pub opened_at: i64,
    pub resolved_at: i64,
    /// Who paid this account's rent, and who gets it back when it closes.
    ///
    /// A settled position is a finished fact and its account is dead weight, so
    /// `settle_bet` closes it and returns the rent. That makes rent a revolving
    /// requirement bounded by what is open right now, rather than one that grows
    /// with every position ever taken.
    pub rent_payer: Pubkey,
    pub bump: u8,
}

