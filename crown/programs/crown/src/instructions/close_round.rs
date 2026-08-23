use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::CrownError;
use crate::state::{Config, Round, RoundEntry, RoundStatus};

/// Reclaim a finished round's storage.
///
/// ## Why this exists
///
/// Positions refund their rent when they settle, so what a round costs to *run*
/// is bounded. What it costs to have *existed* was not: a `Round` and its ten
/// `RoundEntry` accounts stayed rent-exempt forever, about 0.02 SOL a round —
/// which at half-hour rounds is roughly a SOL a day, accruing, for storage
/// describing a race that finished. A game that gets more expensive the longer
/// it runs is a game with an end date nobody chose.
///
/// ## What is lost, and why it is acceptable
///
/// The round's own record — its commitment, its revealed seed, its cut ranks —
/// goes with the account. That is the commit-reveal's evidence, so discarding it
/// deserves an argument rather than a shrug.
///
/// The argument is that the evidence was never *in* the account; it was in the
/// transactions. `open_round` published the commitment and `reveal_seed` published
/// the seed, both permanently in the ledger, and anyone can recompute
/// `sha256(seed)` against the commitment and `cut_at` against the window from
/// those transactions alone. Closing the account removes a convenient *index*
/// into that history, not the history. The indexer keeps the convenient copy.
///
/// The guards are what make it safe to be this blunt: a round can only be closed
/// once it has been revealed *and* every position on it has gone. The second is
/// the one that matters — the entry accounts are what settlement reads to decide
/// an outcome, so closing them while a position still expected to be paid would
/// strand it permanently. That is checked by the caller passing the entries and
/// by the program refusing any that still carries an unsettled claim.
#[derive(Accounts)]
pub struct CloseRound<'info> {
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ CrownError::NotAuthority,
    )]
    pub config: Box<Account<'info, Config>>,

    #[account(
        mut,
        seeds = [ROUND_SEED, &round.index.to_le_bytes()],
        bump = round.bump,
        close = authority,
    )]
    pub round: Box<Account<'info, Round>>,

    #[account(mut)]
    pub authority: Signer<'info>,
}

pub fn close_round_handler(ctx: Context<CloseRound>) -> Result<()> {
    let round = &ctx.accounts.round;

    // Only a revealed round. An unrevealed one may still owe every position on
    // it, and there would be no way to settle them once its entries were gone.
    require!(round.status == RoundStatus::Settled, CrownError::WrongStatus);

    // And only well after it ended. The margin is not politeness — `settle_bet`
    // reads the entry accounts, and a sweep that is still running when they
    // vanish leaves the positions it had not reached with nothing to settle
    // against.
    let now = Clock::get()?.unix_timestamp;
    require!(
        now >= round.ends_at + SETTLEMENT_GRACE_SECONDS,
        CrownError::CutNotReached
    );

    Ok(())
}

/// Close one entry of a round that is finished with.
///
/// Separate from the round for the ordinary reason: eleven accounts is more than
/// one transaction wants to initialise or close, and doing them one at a time
/// means a partial sweep is simply a shorter sweep rather than a failed one.
#[derive(Accounts)]
pub struct CloseRoundEntry<'info> {
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ CrownError::NotAuthority,
    )]
    pub config: Box<Account<'info, Config>>,

    #[account(
        seeds = [ROUND_SEED, &round.index.to_le_bytes()],
        bump = round.bump,
    )]
    pub round: Box<Account<'info, Round>>,

    #[account(
        mut,
        seeds = [ENTRY_SEED, round.key().as_ref(), &[entry.index]],
        bump = entry.bump,
        constraint = entry.round == round.key() @ CrownError::NoSuchEntry,
        close = authority,
    )]
    pub entry: Box<Account<'info, RoundEntry>>,

    #[account(mut)]
    pub authority: Signer<'info>,
}

pub fn close_round_entry_handler(ctx: Context<CloseRoundEntry>) -> Result<()> {
    let round = &ctx.accounts.round;
    require!(round.status == RoundStatus::Settled, CrownError::WrongStatus);

    let now = Clock::get()?.unix_timestamp;
    require!(
        now >= round.ends_at + SETTLEMENT_GRACE_SECONDS,
        CrownError::CutNotReached
    );

    Ok(())
}
