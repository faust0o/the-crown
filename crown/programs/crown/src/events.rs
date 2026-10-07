//! What happened, for whoever is keeping the history.
//!
//! These exist because the accounts do not survive. A lot's account must be
//! rent-exempt while it is open, and eight desks trading once a second open
//! fourteen thousand of them in a half-hour round — twenty-five SOL of rent
//! against seven hundredths of a SOL of fees. Keeping them after they resolve
//! would make the cost of running the market grow without bound, so `settle_bet`
//! and `close_bet` close the account and return the rent.
//!
//! That is the right trade, but it means the chain stops being the place you can
//! look up what a finished bet did. These events are what replaces it: the chain
//! holds live positions and the indexer holds the record, which is the same split
//! `server/src/rounds.ts` already had between the market's in-memory tape and the
//! `CryptoBet` table.
//!
//! The consequence worth stating plainly: a settled result is only as durable as
//! the indexer. Nothing in this program will tell you tomorrow what a bet paid.
//! The transaction that paid it is still on-chain and still carries these logs,
//! so the history is *recoverable* rather than *queryable* — recovering it means
//! replaying transactions, not reading an account.

use anchor_lang::prelude::*;

use crate::state::BetStatus;

/// A position resolved with the round — won, lost, or voided for want of a cut.
#[event]
pub struct BetSettled {
    pub round: Pubkey,
    pub owner: Pubkey,
    pub entry_index: u8,
    pub direction: u8,
    /// Credits put in across every buy that built this position.
    pub stake: u64,
    /// What it was owed if the leg landed — and what it was paid, if it did.
    pub shares: u64,
    pub start_rank: u16,
    /// Where the coin actually finished. 0 when no cut was recorded.
    pub cut_rank: u16,
    pub status: BetStatus,
    pub payout: u64,
    pub settled_at: i64,
}

/// A position sold back to the book before the cut.
#[event]
pub struct BetClosed {
    pub round: Pubkey,
    pub owner: Pubkey,
    pub entry_index: u8,
    pub direction: u8,
    pub stake: u64,
    pub shares: u64,
    /// The bid it closed into — walked through the pool by its own size, which is
    /// worse than the resting quote and is the number that actually paid.
    pub bid_cents: u16,
    pub payout: u64,
    pub closed_at: i64,
}

/// A fill, and the book it left behind.
///
/// The marks are carried so an indexer can rebuild the tape without re-deriving
/// prices — which it could do, since `server/src/chain/pricing.ts` is the same
/// arithmetic, but a record of what the book *was* at each fill is not something
/// a later read of the account can reconstruct.
#[event]
pub struct BetPlaced {
    pub round: Pubkey,
    pub owner: Pubkey,
    pub entry_index: u8,
    pub direction: u8,
    /// This buy's own stake and shares, not the position's running total.
    ///
    /// The account holds only the sum, so these are the lot-by-lot record: the
    /// tape, the breakdown behind an aggregate position, and a player's average
    /// entry all rebuild from the stream of these rather than from storage.
    pub stake: u64,
    pub shares: u64,
    pub fill_cents: u16,
    pub marks: [u16; 3],
    pub placed_at: i64,
}

/// A round given up on.
///
/// The one event that says a result will never exist. Emitted rather than
/// inferred from the account, because the account can be closed later and this is
/// the only durable record that the positions on this round refunded rather than
/// resolved — an indexer reading `Void` payouts otherwise cannot tell "no data
/// point for that coin" from "this whole round was abandoned".
#[event]
pub struct RoundVoided {
    pub round: Pubkey,
    pub index: u64,
    pub ends_at: i64,
    pub voided_at: i64,
}
