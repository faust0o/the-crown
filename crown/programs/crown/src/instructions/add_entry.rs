use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::error::CrownError;
use crate::pricing::{self, FLOOR_CENTS};
use crate::state::{Config, Round, RoundEntry, RoundStatus, SYMBOL_LEN, TICKER_LEN};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct AddEntryArgs {
    pub index: u8,
    pub symbol: [u8; SYMBOL_LEN],
    pub ticker: [u8; TICKER_LEN],
    pub start_rank: u16,
    /// Which legs this coin is offered on.
    pub quoted: [bool; 3],
    /// The opening auction's stake on each leg, in credits.
    pub opening: [u64; 3],
    /// Cents the quoted legs divide between them — a hundred, less the share of
    /// any leg that is real but has no line.
    pub target: u16,
}

/// Put one coin on the board, with the opening auction's stake on each leg.
///
/// **The opening stake is posted, not derived.** Computing it needs the priors in
/// `crypto-odds.ts` — `probabilities`, and the `erf`/`probit` machinery under it —
/// which is exactly the floating-point model that `pricing.rs` explains does not
/// belong on-chain. So the authority computes the split off-chain and states it,
/// and from that moment the model has no further say: the mark is this pool's
/// share of the coin's, and every credit traded dilutes it.
///
/// What the program does enforce is that the posted numbers are *coherent* — a
/// quoted leg has to have stake behind it or its mark is a division by zero, and
/// the target has to be a reachable price. A dishonest opening print is visible
/// to anyone reading the account; an incoherent one would break the arithmetic
/// for everybody, so it is refused here rather than trusted.
#[derive(Accounts)]
#[instruction(args: AddEntryArgs)]
pub struct AddEntry<'info> {
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
    )]
    pub round: Box<Account<'info, Round>>,

    #[account(
        init,
        payer = authority,
        space = 8 + RoundEntry::INIT_SPACE,
        seeds = [ENTRY_SEED, round.key().as_ref(), &[args.index]],
        bump,
    )]
    pub entry: Box<Account<'info, RoundEntry>>,

    /// The opening stake is taken from here. It is a real deposit, not an
    /// accounting entry — see the note on the transfer below.
    #[account(
        mut,
        constraint = authority_tokens.mint == config.credit_mint @ CrownError::NotAuthority,
    )]
    pub authority_tokens: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [VAULT_SEED],
        bump = config.vault_bump,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn add_entry_handler(ctx: Context<AddEntry>, args: AddEntryArgs) -> Result<()> {
    let round = &mut ctx.accounts.round;
    require!(round.status == RoundStatus::Open, CrownError::WrongStatus);
    require!(args.index < MAX_ENTRIES, CrownError::NoSuchEntry);
    require!(
        args.target >= FLOOR_CENTS && args.target <= 100,
        CrownError::BadPrice
    );

    // A leg cannot be on the book with nothing behind it: the mark is its share
    // of the pool, so an empty quoted leg is a zero divisor at best and a free
    // option at worst. Equally, staking a leg nobody can trade would put credits
    // into a pool that no price is a share of.
    let mut any_quoted = false;
    for d in 0..3 {
        if args.quoted[d] {
            require!(args.opening[d] > 0, CrownError::BadPrice);
            any_quoted = true;
        } else {
            require!(args.opening[d] == 0, CrownError::BadPrice);
        }
    }
    require!(any_quoted, CrownError::Unavailable);

    let entry = &mut ctx.accounts.entry;
    entry.round = round.key();
    entry.index = args.index;
    entry.symbol = args.symbol;
    entry.ticker = args.ticker;
    entry.start_rank = args.start_rank;
    entry.cut_rank = 0;
    entry.opening = args.opening;
    entry.flow = [0; 3];
    entry.quoted = args.quoted;
    entry.target = args.target;
    entry.bump = ctx.bumps.entry;

    // Print the opening marks off the stake just posted, so the board quotes the
    // prior exactly and no reader ever meets a line that has never been marked.
    entry.last_cents = pricing::remark(&entry.book());

    round.entry_count = round
        .entry_count
        .checked_add(1)
        .ok_or(CrownError::Overflow)?;

    // The opening auction is a **deposit**, not an accounting entry.
    //
    // Every price on this coin is a share of `pool`, and `pool` counts the
    // opening stake — so a payout is computed against it whether or not anybody
    // put the credits up. Recording it without transferring it would mint
    // liabilities against liquidity that does not exist, and the shortfall would
    // not surface until the first winning position tried to settle. Moving the
    // credits here means the pool the book prices off is the pool the vault
    // holds.
    //
    // It does not make the book self-funding, and nothing could: buying `S` into
    // a leg holding `a` of a pool `P` earns `S + (P-a)·ln((a+S)/a)` shares against
    // a pool that only grew to `P+S`, so an informed trader who buys a cheap leg
    // that lands is paid out of the house's subsidy. That residual is what an
    // automated market maker *is*. Topping the vault up for it needs no
    // instruction — the vault is an ordinary token account, so the house transfers
    // in with the SPL program like anyone else.
    let staked: u64 = args
        .opening
        .iter()
        .try_fold(0u64, |sum, v| sum.checked_add(*v))
        .ok_or(CrownError::Overflow)?;

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.authority_tokens.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.authority.to_account_info(),
            },
        ),
        staked,
    )?;

    Ok(())
}
