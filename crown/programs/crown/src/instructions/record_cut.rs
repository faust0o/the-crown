use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::CrownError;
use crate::state::{Config, Round, RoundEntry, RoundStatus};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct RecordCutArgs {
    /// 1-based, and never 0 — 0 is how an unrecorded entry is spelled. A coin
    /// that has fallen off the board is recorded one place below the last visible
    /// slot, which is how `recordCut` in `rounds.ts` has always settled it.
    pub cut_rank: u16,
}

/// Freeze one coin's standing at the cut.
///
/// Recording at the cut rather than reconstructing it later is what makes the
/// result durable: the ranking only ever lives in the oracle's memory, so if the
/// server restarts between the cut and settlement there would be nothing left to
/// settle against.
///
/// The authority posts this because the ranking comes from off-chain market data
/// and nothing on-chain can check it. That is the one genuine trust assumption in
/// the design and it is worth naming plainly: the commit-reveal proves the house
/// did not choose *when* to look, and this instruction is the house saying what
/// it saw. Those are different guarantees and only the first is cryptographic.
#[derive(Accounts)]
pub struct RecordCut<'info> {
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ CrownError::NotAuthority,
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [ROUND_SEED, &round.index.to_le_bytes()],
        bump = round.bump,
    )]
    pub round: Account<'info, Round>,

    #[account(
        mut,
        seeds = [ENTRY_SEED, round.key().as_ref(), &[entry.index]],
        bump = entry.bump,
        constraint = entry.round == round.key() @ CrownError::NoSuchEntry,
    )]
    pub entry: Account<'info, RoundEntry>,

    pub authority: Signer<'info>,
}

pub fn record_cut_handler(ctx: Context<RecordCut>, args: RecordCutArgs) -> Result<()> {
    let round = &mut ctx.accounts.round;
    let entry = &mut ctx.accounts.entry;

    // Gated on the clock rather than on a status. `lock_at` is the fact; a
    // `Locked` state was only ever a restatement of it that something had to
    // spend a transaction to write down, and a server that fell over before
    // writing it could strand a round that had plainly closed.
    require!(
        round.status == RoundStatus::Open || round.status == RoundStatus::Cut,
        CrownError::WrongStatus
    );
    let now = Clock::get()?.unix_timestamp;
    require!(now >= round.lock_at, CrownError::CutNotReached);
    require!(args.cut_rank > 0, CrownError::NoCut);
    // Idempotent by refusal rather than by overwrite: a second recording with a
    // different rank would silently restate an outcome bets are already being
    // settled against.
    require!(entry.cut_rank == 0, CrownError::WrongStatus);

    entry.cut_rank = args.cut_rank;
    round.status = RoundStatus::Cut;

    Ok(())
}
