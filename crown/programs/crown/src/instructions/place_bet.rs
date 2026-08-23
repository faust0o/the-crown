use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::error::CrownError;
use crate::events::BetPlaced;
use crate::pricing;
use crate::state::{Bet, BetStatus, Config, Delegation, Round, RoundEntry, RoundStatus};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct PlaceBetArgs {
    pub direction: u8,
    pub stake: u64,
    /// The worst price this order will accept, in cents.
    ///
    /// Not optional, and not a courtesy. A desk sizes its clip against the book
    /// it read a moment ago, and between that read and this instruction landing
    /// the book can have moved — seven other desks are trading the same coin at
    /// the same second, and every one of their fills re-marks it. Without a bound
    /// the order fills at whatever it finds, which is precisely the "buy big,
    /// close immediately" free-money case `average_mark` exists to close, run
    /// backwards. Pass `CAP_CENTS` to genuinely not care.
    pub max_cents: u16,
}

/// Buy a leg. The one path — players and desks alike.
///
/// The desks bet real credits out of real accounts, and the only way that is
/// honest is if they go through exactly what a player goes through: the same
/// checks, the same quote off the same book, the same transfer. Anything the
/// desks got to skip would be a thumb on the scale, and anything a player is
/// refused for the desks must be refused for too. That was true of `placeBet` in
/// `bets.ts` and it stays true here — the only difference between a desk and a
/// player at this instruction is which keypair signed the relayer slot.
///
/// ## Who signs
///
/// Not the bettor. `bettor` is an unsigned account, and two things stand in for
/// its signature:
///
/// - the SPL delegate on `bettor_tokens` must be the config PDA, which only this
///   program can sign for, and the allowance bounds the total spend;
/// - `delegation.relayer` must have signed, which bounds *who* may spend it.
///
/// Either one alone is not enough — see `Delegation`. Together they mean a player
/// signs once, ever, and every bet after that is free of a wallet prompt while
/// still being unreachable by anyone the player did not name.
#[derive(Accounts)]
#[instruction(args: PlaceBetArgs)]
pub struct PlaceBet<'info> {
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
        constraint = entry.round == round.key() @ CrownError::NoSuchEntry,
    )]
    pub entry: Box<Account<'info, RoundEntry>>,

    #[account(
        seeds = [DELEGATION_SEED, bettor.key().as_ref()],
        bump = delegation.bump,
        has_one = relayer @ CrownError::NotAuthority,
        constraint = delegation.owner == bettor.key() @ CrownError::NotAuthority,
    )]
    pub delegation: Box<Account<'info, Delegation>>,

    /// The position on this leg — opened on first contact, added to after.
    ///
    /// Keyed by the leg rather than by a counter, which is what lets a second buy
    /// merge into the first instead of paying rent for a second account. It also
    /// removes a failure mode: a nonce has to be read before the transaction is
    /// built, so two bets prepared in the same moment derived the same address and
    /// one of them simply failed to initialise. There is nothing left to race.
    #[account(
        init_if_needed,
        payer = relayer,
        space = 8 + Bet::INIT_SPACE,
        seeds = [
            BET_SEED,
            round.key().as_ref(),
            bettor.key().as_ref(),
            &[entry.index],
            &[args.direction],
        ],
        bump,
    )]
    pub bet: Box<Account<'info, Bet>>,

    /// CHECK: identified by the delegation PDA's seeds and its `owner` field; it
    /// signs nothing and is never written to.
    pub bettor: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = bettor_tokens.owner == bettor.key() @ CrownError::NotAuthority,
        constraint = bettor_tokens.mint == config.credit_mint @ CrownError::NotAuthority,
        // The delegate must be this program's PDA. Without this a bettor could be
        // pointed at a token account delegated to somebody else entirely.
        constraint = bettor_tokens.delegate == anchor_lang::solana_program::program_option::COption::Some(config.key())
            @ CrownError::NotAuthority,
    )]
    pub bettor_tokens: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [VAULT_SEED],
        bump = config.vault_bump,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    /// Pays the fee and the rent for the bet account, and is the key the player
    /// named. The desks pass their own keypair here and are their own relayer.
    #[account(mut)]
    pub relayer: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn place_bet_handler(ctx: Context<PlaceBet>, args: PlaceBetArgs) -> Result<()> {
    let round = &ctx.accounts.round;
    let entry = &mut ctx.accounts.entry;

    require!(args.stake > 0, CrownError::BadStake);
    let direction = args.direction as usize;
    require!(direction < 3, CrownError::BadDirection);

    // Betting is closed by the clock, not by whether anyone got around to calling
    // `lock_round` — a round whose lock has passed must refuse a bet even if its
    // status still says Open.
    require!(round.status == RoundStatus::Open, CrownError::RoundClosed);
    let now = Clock::get()?.unix_timestamp;
    require!(now < round.lock_at, CrownError::RoundClosed);

    // The crown cannot be bet on. Backing the challenger at rank 2 to go HIGHER
    // *is* betting the crown changes hands, so the interesting bet survives.
    require!(
        entry.symbol != round.crown_symbol,
        CrownError::Crown
    );

    // Fills at the price this stake walks the book through, not at the mark it
    // found on arrival. A clip large enough to move the pool pays its own way up;
    // billing it at the pre-trade mark would hand it the whole of its own impact.
    let fill_cents =
        pricing::fill_cents(&entry.book(), direction, args.stake).ok_or(CrownError::Unavailable)?;
    require!(fill_cents <= args.max_cents, CrownError::SlippageExceeded);

    // Move the credits first, so a book that cannot be paid for is never marked.
    let signer: &[&[&[u8]]] = &[&[CONFIG_SEED, &[ctx.accounts.config.bump]]];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.bettor_tokens.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
            },
            signer,
        ),
        args.stake,
    )?;

    // What this buy earns: one credit per share if the leg lands. Floored, so a
    // fill can never round its way into shares it did not pay for.
    let bought = ((args.stake as u128)
        .checked_mul(100)
        .ok_or(CrownError::Overflow)?
        / fill_cents as u128) as u64;

    let bet = &mut ctx.accounts.bet;
    if bet.owner == Pubkey::default() {
        bet.round = round.key();
        bet.owner = ctx.accounts.bettor.key();
        bet.entry_index = entry.index;
        bet.direction = args.direction;
        bet.start_rank = entry.start_rank;
        bet.status = BetStatus::Open;
        bet.payout = 0;
        bet.opened_at = now;
        bet.resolved_at = 0;
        bet.rent_payer = ctx.accounts.relayer.key();
        bet.bump = ctx.bumps.bet;
        bet.stake = 0;
        bet.shares = 0;
    } else {
        // `init_if_needed` hands back an account that already exists, so anything
        // the seeds do not pin has to be checked here. They pin the round, the
        // owner and the leg. They do not pin the status — and adding to a position
        // that has already settled or cashed out would resurrect it with its
        // payout still recorded against it.
        require!(bet.status == BetStatus::Open, CrownError::BetNotOpen);
        require!(bet.owner == ctx.accounts.bettor.key(), CrownError::NotAuthority);
    }

    bet.stake = bet.stake.checked_add(args.stake).ok_or(CrownError::Overflow)?;
    bet.shares = bet.shares.checked_add(bought).ok_or(CrownError::Overflow)?;

    // The fill moves the price, because price is order flow. Nothing else does.
    entry.flow[direction] = entry.flow[direction]
        .checked_add(args.stake)
        .ok_or(CrownError::Overflow)?;
    entry.last_cents = pricing::remark(&entry.book());

    // The *fill*, not the position — `stake` and `shares` here are what this buy
    // added, not the running total. This is where the lot-by-lot history lives now
    // that the account holds only the sum: the tape, the breakdown behind an
    // aggregate row, and the indexer's record all rebuild from these.
    emit!(BetPlaced {
        round: round.key(),
        owner: ctx.accounts.bettor.key(),
        entry_index: bet.entry_index,
        direction: bet.direction,
        stake: args.stake,
        shares: bought,
        fill_cents,
        marks: entry.last_cents,
        placed_at: now,
    });

    Ok(())
}
