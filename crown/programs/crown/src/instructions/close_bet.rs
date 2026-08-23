use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::error::CrownError;
use crate::events::BetClosed;
use crate::pricing;
use crate::state::{Bet, BetStatus, Config, Round, RoundEntry, RoundStatus};

/// Sell a lot back to the book before the cut, at the current bid.
///
/// The inverse of the buy, and it has to exist in both halves. Paying out the bid
/// without taking the stake back out of the pool would let a large enough
/// position bid its own line up, sell into the bid it had just created, and book
/// the difference. `unwind` here removes exactly what was staked, so the round
/// trip costs precisely the spread — which is the price the design puts on it.
///
/// The owner signs this one. There is no relayer path and no delegate involved:
/// money is moving *out* of the vault toward the owner's token account, so the
/// only signature that could matter is theirs, and requiring it costs a player
/// one prompt on an action they took deliberately rather than one per bet.
#[derive(Accounts)]
pub struct CloseBet<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
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
        constraint = entry.index == bet.entry_index @ CrownError::NoSuchEntry,
    )]
    pub entry: Box<Account<'info, RoundEntry>>,

    #[account(
        mut,
        seeds = [
            BET_SEED,
            round.key().as_ref(),
            owner.key().as_ref(),
            &[bet.entry_index],
            &[bet.direction],
        ],
        bump = bet.bump,
        close = rent_receiver,
        has_one = owner @ CrownError::NotAuthority,
        constraint = bet.round == round.key() @ CrownError::NoSuchEntry,
    )]
    pub bet: Box<Account<'info, Bet>>,

    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        constraint = owner_tokens.owner == owner.key() @ CrownError::NotAuthority,
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

pub fn close_bet_handler(ctx: Context<CloseBet>) -> Result<()> {
    let round = &ctx.accounts.round;
    let entry = &mut ctx.accounts.entry;
    let bet = &mut ctx.accounts.bet;

    require!(bet.status == BetStatus::Open, CrownError::BetNotOpen);
    require!(round.status == RoundStatus::Open, CrownError::RoundClosed);

    let now = Clock::get()?.unix_timestamp;
    require!(now < round.lock_at, CrownError::RoundClosed);

    let direction = bet.direction as usize;
    require!(direction < 3, CrownError::BadDirection);

    // The bid over the same stretch of curve the opening trade walked up, so the
    // two agree to the cent before the spread and the spread is the whole cost.
    //
    // Priced against the position's whole stake, not against a resting quote: a
    // position sells into progressively worse prices as it walks the pool back
    // down, and the resting bid is only what its *first* credit out would fetch.
    let bid = pricing::close_cents(&entry.book(), direction, bet.stake)
        .ok_or(CrownError::Unavailable)?;

    // Shares are what the position is owed, so they are what it sells. No entry
    // price enters here — the average one is recoverable for display, but nothing
    // that decides money is computed from it.
    let value = (bet.shares as u128 * bid.min(100) as u128 / 100) as u64;

    require!(
        ctx.accounts.vault.amount >= value,
        CrownError::VaultUnderfunded
    );

    if value > 0 {
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
            value,
        )?;
    }

    bet.status = BetStatus::CashedOut;
    bet.payout = value;
    bet.resolved_at = now;

    // Take the position back out of the pool. Saturating rather than checked: the
    // flow can only have grown since this lot was opened, but a book that somehow
    // disagreed must not become unpriceable — a floor at zero keeps every
    // subsequent quote well-defined.
    entry.flow[direction] = entry.flow[direction].saturating_sub(bet.stake);
    entry.last_cents = pricing::remark(&entry.book());

    emit!(BetClosed {
        round: round.key(),
        owner: bet.owner,
        entry_index: bet.entry_index,
        direction: bet.direction,
        stake: bet.stake,
        shares: bet.shares,
        bid_cents: bid,
        payout: value,
        closed_at: now,
    });

    Ok(())
}
