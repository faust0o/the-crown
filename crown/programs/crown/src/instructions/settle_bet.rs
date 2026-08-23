use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::error::CrownError;
use crate::events::BetSettled;
use crate::pricing;
use crate::state::{Bet, BetStatus, Config, Round, RoundEntry, RoundStatus};

/// Pay one settled lot what it is owed.
///
/// **Permissionless, and it has to be.** Settlement in `rounds.ts` was a loop the
/// server ran over every open bet; if the server was down, nobody got paid and
/// there was no other way to be paid. On-chain that would be a far worse
/// property, because the money is real and the server is not the only party who
/// should be able to move it. Anyone may call this for anyone's bet — the payout
/// is computed from the bet and the entry, and it can only go to the owner's
/// token account. A player whose house has vanished can still collect.
///
/// The three outcomes are the same three `settleRound` decided between:
///
/// - the coin's rank at the cut moved the way the bet claimed → **Won**, paid at
///   the price the lot filled at;
/// - it did not → **Lost**, nothing to pay;
/// - no cut was ever recorded for that coin → **Void**, stake refunded. Leaving
///   it open used to strand it forever, since the cut is an instant that has
///   passed and nothing would ever revisit it.
#[derive(Accounts)]
pub struct SettleBet<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(
        seeds = [ROUND_SEED, &round.index.to_le_bytes()],
        bump = round.bump,
    )]
    pub round: Box<Account<'info, Round>>,

    #[account(
        seeds = [ENTRY_SEED, round.key().as_ref(), &[entry.index]],
        bump = entry.bump,
        constraint = entry.index == bet.entry_index @ CrownError::NoSuchEntry,
        constraint = entry.round == round.key() @ CrownError::NoSuchEntry,
    )]
    pub entry: Box<Account<'info, RoundEntry>>,

    #[account(
        mut,
        seeds = [
            BET_SEED,
            round.key().as_ref(),
            bet.owner.as_ref(),
            &[bet.entry_index],
            &[bet.direction],
        ],
        bump = bet.bump,
        close = rent_receiver,
        constraint = bet.round == round.key() @ CrownError::NoSuchEntry,
    )]
    pub bet: Box<Account<'info, Bet>>,

    /// Where a winning payout goes. Constrained to the bet's owner, so calling
    /// this for somebody else's bet pays *them*, which is why it can be open to
    /// anyone.
    #[account(
        mut,
        constraint = owner_tokens.owner == bet.owner @ CrownError::NotAuthority,
        constraint = owner_tokens.mint == config.credit_mint @ CrownError::NotAuthority,
    )]
    pub owner_tokens: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [VAULT_SEED],
        bump = config.vault_bump,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    /// Gets the bet account's rent back when it closes.
    ///
    /// CHECK: pinned to the key that paid it. A lot's account costs ~0.0017 SOL
    /// to keep rent-exempt and eight desks open fourteen thousand of them in a
    /// half-hour round; left behind, that is twenty-five SOL a round of dead
    /// storage. Closing here makes the cost revolving rather than cumulative.
    #[account(mut, address = bet.rent_payer @ CrownError::NotAuthority)]
    pub rent_receiver: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

/// Which way the coin actually went, against where it started.
fn outcome_of(start_rank: u16, cut_rank: u16) -> u8 {
    // Rank 1 is the top of the board, so a *smaller* number is a better finish.
    if cut_rank < start_rank {
        pricing::HIGHER as u8
    } else if cut_rank > start_rank {
        pricing::LOWER as u8
    } else {
        pricing::DRAW as u8
    }
}

pub fn settle_bet_handler(ctx: Context<SettleBet>) -> Result<()> {
    let round = &ctx.accounts.round;
    let entry = &ctx.accounts.entry;
    let bet = &mut ctx.accounts.bet;

    require!(bet.status == BetStatus::Open, CrownError::BetNotOpen);
    require!(round.status == RoundStatus::Settled, CrownError::WrongStatus);

    let now = Clock::get()?.unix_timestamp;

    let (status, payout) = if entry.cut_rank == 0 {
        // No cut was recorded for that coin and none ever will be. Refund what
        // went in — the stake, not the shares: a void is the bet not happening,
        // so it pays back the cost rather than the claim.
        (BetStatus::Void, bet.stake)
    } else if outcome_of(bet.start_rank, entry.cut_rank) == bet.direction {
        // Each share is worth one credit when the leg lands, so the shares *are*
        // the payout. Whatever mix of prices built the position is already in
        // them, which is why nothing here needs to know how it was assembled.
        (BetStatus::Won, bet.shares)
    } else {
        (BetStatus::Lost, 0u64)
    };

    if payout > 0 {
        require!(
            ctx.accounts.vault.amount >= payout,
            CrownError::VaultUnderfunded
        );
        let signer: &[&[&[u8]]] = &[&[CONFIG_SEED, &[ctx.accounts.config.bump]]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.owner_tokens.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                signer,
            ),
            payout,
        )?;
    }

    bet.status = status;
    bet.payout = payout;
    bet.resolved_at = now;

    // The account closes at the end of this instruction and takes the record with
    // it, so this log is the only durable trace of what the lot did.
    emit!(BetSettled {
        round: round.key(),
        owner: bet.owner,
        entry_index: bet.entry_index,
        direction: bet.direction,
        stake: bet.stake,
        shares: bet.shares,
        start_rank: bet.start_rank,
        cut_rank: entry.cut_rank,
        status,
        payout,
        settled_at: now,
    });

    Ok(())
}
