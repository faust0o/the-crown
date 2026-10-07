use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::CrownError;
use crate::events::RoundVoided;
use crate::state::{Round, RoundStatus};

/// Release a round that can never be settled.
///
/// ## The hole this closes
///
/// `settle_bet` requires `RoundStatus::Settled`, and a round only reaches it
/// through `reveal_seed`, which requires the seed. The seed is the one thing in
/// this design that lives off-chain until the reveal — that is what makes the
/// commitment worth anything — so a house that loses it strands every position on
/// that round permanently. Not delayed: stranded. The stake is in the vault, the
/// position accounts cannot close, and no instruction in the program could move
/// either.
///
/// It is not hypothetical. On devnet, rounds 20 and 198 sat at `Cut` holding 101
/// positions and about 3.1 million credits of stake, with their seeds gone from
/// the server's memory and their database rows long since replaced. Nothing
/// could ever have paid them.
///
/// ## Why it refunds rather than pays
///
/// `record_cut` may well have written every rank before the seed went missing,
/// so the outcomes are often sitting right there in the entries, and paying them
/// out is the tempting reading of "settle this round".
///
/// It is the wrong one. The seed is what proves the house did not choose the
/// moment it looked; a round whose seed is never revealed is a round whose result
/// nobody can check. Paying claims on unverifiable ranks would make "the house
/// lost the seed" a thing the house can *do*, and the whole commit-reveal exists
/// to make that impossible. So a voided round pays nobody and refunds everybody:
/// every position gets its stake back through `settle_bet`'s existing `Void`
/// path, which is the outcome that cannot be gamed in either direction.
///
/// ## Why anybody may call it, and only after a long wait
///
/// Permissionless for the same reason `settle_bet` is: this is the path a player
/// uses when the house is gone, and a rescue that needs the house's cooperation
/// is not a rescue. It can only ever move a round to a state where stakes are
/// returned, so there is nothing here for a caller to win.
///
/// The wait is what keeps it from being a way to *avoid* a settlement. A round
/// that is merely slow — a server restarting, a cluster congested, an authority
/// key being rotated — must resolve normally, and `VOID_AFTER_SECONDS` is set far
/// past any of that. A round that is genuinely lost is still lost a week later.
#[derive(Accounts)]
pub struct VoidRound<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, crate::state::Config>>,

    #[account(
        mut,
        seeds = [ROUND_SEED, &round.index.to_le_bytes()],
        bump = round.bump,
    )]
    pub round: Box<Account<'info, Round>>,
}

pub fn void_round_handler(ctx: Context<VoidRound>) -> Result<()> {
    let round = &mut ctx.accounts.round;

    // A settled round is finished business, and a round already voided has
    // nothing left to do. Both are `WrongStatus` rather than silent successes:
    // this is a rescue, and a rescue that quietly does nothing is worse than one
    // that says it did nothing.
    require!(
        round.status == RoundStatus::Open || round.status == RoundStatus::Cut,
        CrownError::WrongStatus
    );

    let now = Clock::get()?.unix_timestamp;
    let usable_at = round
        .ends_at
        .checked_add(VOID_AFTER_SECONDS)
        .ok_or(CrownError::Overflow)?;
    require!(now >= usable_at, CrownError::VoidTooEarly);

    round.status = RoundStatus::Voided;

    emit!(RoundVoided {
        round: round.key(),
        index: round.index,
        ends_at: round.ends_at,
        voided_at: now,
    });

    Ok(())
}
