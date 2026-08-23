use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::constants::*;
use crate::state::Config;

/// Stand up the config and the vault. Once, ever.
///
/// The vault is a token account owned by the config PDA rather than by the
/// authority, which is the line between "the house runs the game" and "the house
/// holds the money". The authority can open rounds and reveal seeds; it has no
/// instruction anywhere that moves a token out of the vault to an address of its
/// choosing. Every transfer out is computed by `close_bet` or `settle_bet` from a
/// bet this program itself wrote.
#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, Config>,

    pub credit_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = authority,
        seeds = [VAULT_SEED],
        bump,
        token::mint = credit_mint,
        token::authority = config,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn initialize_handler(ctx: Context<Initialize>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.authority = ctx.accounts.authority.key();
    config.credit_mint = ctx.accounts.credit_mint.key();
    config.round_count = 0;
    config.bump = ctx.bumps.config;
    config.vault_bump = ctx.bumps.vault;
    Ok(())
}
