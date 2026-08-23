use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::CrownError;
use crate::state::{Config, Round, RoundStatus, SYMBOL_LEN};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct OpenRoundArgs {
    pub starts_at: i64,
    pub lock_at: i64,
    pub ends_at: i64,
    /// sha256(seed). The seed itself is withheld until `reveal_seed`.
    pub commit_hash: [u8; 32],
    pub cut_window_seconds: u32,
    /// The coin wearing the crown, or all zeroes for the very first round.
    pub crown_symbol: [u8; SYMBOL_LEN],
}

/// Open a round and publish the commitment to its cut instant.
///
/// Publishing `commit_hash` *here*, before a single bet exists, is the whole
/// point of the commit-reveal: it fixes the settlement instant in a way anybody
/// can check later without having to believe the server was showing them an
/// honest commitment at the time. That last clause is what moving it on-chain
/// buys — the commitment is now in a place the house does not serve.
#[derive(Accounts)]
pub struct OpenRound<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ CrownError::NotAuthority,
    )]
    pub config: Account<'info, Config>,

    #[account(
        init,
        payer = authority,
        space = 8 + Round::INIT_SPACE,
        seeds = [ROUND_SEED, &config.round_count.to_le_bytes()],
        bump,
    )]
    pub round: Account<'info, Round>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn open_round_handler(ctx: Context<OpenRound>, args: OpenRoundArgs) -> Result<()> {
    require!(args.lock_at > args.starts_at, CrownError::RoundClosed);
    require!(args.ends_at >= args.lock_at, CrownError::RoundClosed);

    let config = &mut ctx.accounts.config;
    let round = &mut ctx.accounts.round;

    round.index = config.round_count;
    round.starts_at = args.starts_at;
    round.lock_at = args.lock_at;
    round.ends_at = args.ends_at;
    round.commit_hash = args.commit_hash;
    round.seed = [0u8; 32];
    round.cut_at = 0;
    round.cut_window_seconds = args.cut_window_seconds;
    round.crown_symbol = args.crown_symbol;
    round.status = RoundStatus::Open;
    round.entry_count = 0;
    round.bump = ctx.bumps.round;

    config.round_count = config
        .round_count
        .checked_add(1)
        .ok_or(CrownError::Overflow)?;

    Ok(())
}
