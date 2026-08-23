use anchor_lang::prelude::*;

/// Refusals.
///
/// `bets.ts` returns its refusals as values rather than throwing, because a desk
/// that cannot afford a clip simply does not place one and needs that to be an
/// ordinary Tuesday. On-chain there is no such option — an instruction either
/// succeeds or the transaction fails — so the desks' client is expected to
/// decide *not to send* rather than to send and be refused. These exist for the
/// cases a caller could not have known about: a race with the lock, a leg that
/// closed, a book that moved.
#[error_code]
pub enum CrownError {
    #[msg("Stake must be a positive whole number of credits.")]
    BadStake,

    #[msg("Betting is closed for this round.")]
    RoundClosed,

    #[msg("That outcome is not available for this coin.")]
    Unavailable,

    #[msg("That coin is wearing the crown and cannot be bet on.")]
    Crown,

    #[msg("This round is not in the state that operation needs.")]
    WrongStatus,

    #[msg("The revealed seed does not match the published commitment.")]
    BadReveal,

    #[msg("The cut has not landed yet.")]
    CutNotReached,

    #[msg("No cut was recorded for that coin.")]
    NoCut,

    #[msg("This bet is not open.")]
    BetNotOpen,

    #[msg("A price of zero cents would price an infinite payout.")]
    BadPrice,

    #[msg("The book has moved past the price this order was willing to pay.")]
    SlippageExceeded,

    #[msg("Only the round's authority may do that.")]
    NotAuthority,

    #[msg("That entry index is not in this round.")]
    NoSuchEntry,

    #[msg("Arithmetic overflowed.")]
    Overflow,

    #[msg("A direction must be 0 (HIGHER), 1 (DRAW) or 2 (LOWER).")]
    BadDirection,

    #[msg("The vault does not hold enough to pay this out.")]
    VaultUnderfunded,
}
