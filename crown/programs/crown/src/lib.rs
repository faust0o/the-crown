//! **The Crown**, on-chain.
//!
//! A round asks, per coin, whether its rank at the cut lands HIGHER, LOWER or the
//! same (DRAW) as its rank when the round opened. This program owns the parts of
//! that a player should not have to take anybody's word for: what a bet filled
//! at, what the book looked like when it did, that the cut instant was committed
//! before the round ran, and what a winning position is owed.
//!
//! What it deliberately does **not** own is the *opinion* — `fairCents` and the
//! priors under it stay in `server/src/crypto-odds.ts`. See `pricing.rs` for why
//! that split is the right one rather than a shortcut.
//!
//! ## Signing
//!
//! A player signs **twice, ever**: once to connect, once to `approve` an SPL
//! delegate allowance. After that `place_bet` moves their credits under a PDA
//! delegate via `invoke_signed`, so betting costs no wallet prompt at all — and
//! the delegate being a *program* PDA rather than a server key means the only
//! code that can spend an allowance is `place_bet` itself. A compromised server
//! can refuse to relay; it cannot take an allowance. `revoke` is always available
//! to the player and settles the matter instantly.
//!
//! Payouts need no signature in either direction: the vault is owned by a PDA and
//! the amounts are computed from bets this program wrote.

pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod pricing;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("EyeF41ia1T93ZKtgoSH9xrpawYuyhHjmrLhkWRESFucF");

#[program]
pub mod crown {
    use super::*;

    /// Stand up the config and the vault. Once, ever.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        instructions::initialize::initialize_handler(ctx)
    }

    /// Open a round and publish the commitment to its cut instant.
    pub fn open_round(ctx: Context<OpenRound>, args: OpenRoundArgs) -> Result<()> {
        instructions::open_round::open_round_handler(ctx, args)
    }

    /// Put one coin on the board, with the opening auction's stake on each leg.
    pub fn add_entry(ctx: Context<AddEntry>, args: AddEntryArgs) -> Result<()> {
        instructions::add_entry::add_entry_handler(ctx, args)
    }


    /// Name the relayer allowed to bet on the signer's behalf. Half of the
    /// one-time setup that makes every later bet prompt-free; the SPL `approve`
    /// alongside it is the other half.
    pub fn authorize_relayer(ctx: Context<AuthorizeRelayer>, relayer: Pubkey) -> Result<()> {
        instructions::authorize_relayer::authorize_relayer_handler(ctx, relayer)
    }

    /// Buy a leg. The one path — players and desks alike.
    pub fn place_bet(ctx: Context<PlaceBet>, args: PlaceBetArgs) -> Result<()> {
        instructions::place_bet::place_bet_handler(ctx, args)
    }


    /// Reclaim a finished round's storage. Its entries go first — see
    /// `close_round_entry` — and the evidence lives in the transactions, not the
    /// account.
    pub fn close_round(ctx: Context<CloseRound>) -> Result<()> {
        instructions::close_round::close_round_handler(ctx)
    }

    /// Reclaim one finished entry's storage.
    pub fn close_round_entry(ctx: Context<CloseRoundEntry>) -> Result<()> {
        instructions::close_round::close_round_entry_handler(ctx)
    }

    /// Sell a lot back to the book before the cut, at the current bid.
    pub fn close_bet(ctx: Context<CloseBet>) -> Result<()> {
        instructions::close_bet::close_bet_handler(ctx)
    }

    /// Freeze one coin's standing at the cut.
    pub fn record_cut(ctx: Context<RecordCut>, args: RecordCutArgs) -> Result<()> {
        instructions::record_cut::record_cut_handler(ctx, args)
    }

    /// Reveal the seed, proving the cut instant was fixed before the round ran.
    pub fn reveal_seed(ctx: Context<RevealSeed>, seed: [u8; 32]) -> Result<()> {
        instructions::reveal_seed::reveal_seed_handler(ctx, seed)
    }

    /// Pay one settled lot what it is owed. Permissionless.
    pub fn settle_bet(ctx: Context<SettleBet>) -> Result<()> {
        instructions::settle_bet::settle_bet_handler(ctx)
    }

    /// Give up on a round whose seed will never arrive, so its positions can
    /// refund. Permissionless, and only long after the round ended.
    pub fn void_round(ctx: Context<VoidRound>) -> Result<()> {
        instructions::void_round::void_round_handler(ctx)
    }
}
