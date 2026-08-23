use anchor_lang::prelude::*;

use crate::constants::DELEGATION_SEED;
use crate::state::Delegation;

/// Name the relayer allowed to place bets on the signer's behalf.
///
/// This is the *second half* of the no-popup flow and it is useless on its own —
/// so is the first half. A player's one-time setup is a single transaction
/// carrying three instructions: create the token account, SPL-`approve` the
/// config PDA for an allowance, and this. One wallet prompt, and from then on
/// betting costs none.
///
/// Splitting the authority in two is deliberate. The SPL allowance says *how
/// much* may be spent and is enforced by the token program; this says *who* may
/// spend it and is enforced here. Neither is sufficient: an allowance with no
/// named relayer is spendable by any passer-by, and a named relayer with no
/// allowance cannot move a credit. Revoking either one stops betting immediately,
/// and the player holds both switches.
///
/// Re-running it re-points the relayer without disturbing the allowance or the
/// nonce, which is what a key rotation on the server side needs.
/// The rent for this account is paid by `payer`, which need not be `owner`.
///
/// A player is their own payer — they are opening their own account and the cost
/// is a fraction of a cent. The desks are the reason the two are separable: they
/// are ordinary accounts holding nothing but credits, and requiring each of them
/// to hold SOL purely to fund its own delegation would mean dusting every desk at
/// seeding time and re-dusting whenever the roster changed. The house pays
/// instead, and a desk stays what it is meant to be — an account with credits and
/// no other resources.
///
/// `owner` still signs. The payer is buying the storage, not the authority.
#[derive(Accounts)]
pub struct AuthorizeRelayer<'info> {
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + Delegation::INIT_SPACE,
        seeds = [DELEGATION_SEED, owner.key().as_ref()],
        bump,
    )]
    pub delegation: Account<'info, Delegation>,

    pub owner: Signer<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn authorize_relayer_handler(ctx: Context<AuthorizeRelayer>, relayer: Pubkey) -> Result<()> {
    let delegation = &mut ctx.accounts.delegation;

    // `init_if_needed`, so this runs on re-authorisation too. The owner is written
    // once and never rewritten: it is what `place_bet` checks the bettor against,
    // and an account whose seeds say one owner and whose body says another would
    // let a delegation be pointed at somebody else's balance.
    if delegation.owner == Pubkey::default() {
        delegation.owner = ctx.accounts.owner.key();
        delegation.bump = ctx.bumps.delegation;
    }
    delegation.relayer = relayer;

    Ok(())
}
