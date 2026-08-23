use anchor_lang::prelude::*;
use solana_sha256_hasher::hash;

use crate::constants::*;
use crate::error::CrownError;
use crate::state::{Config, Round, RoundStatus};

/// Reveal the seed, proving the cut instant was fixed before the round ran.
///
/// The check is the entire point of the mechanism: `sha256(seed)` must equal the
/// `commit_hash` published at `open_round`, before a single bet existed. A house
/// that wanted to choose a convenient settlement moment would have to find a
/// second preimage of a hash it committed to half an hour earlier.
///
/// `cut_at` is then *derived* rather than accepted, for the same reason. Taking
/// it as an argument would leave the authority free to state any instant it liked
/// and reduce the commitment to decoration.
///
/// ## One deliberate divergence from `rounds.ts`
///
/// The server derives the offset as `HMAC-SHA256(seed, roundId) mod window`.
/// Here it is `sha256(seed || round_index) mod window`. HMAC is the right
/// primitive when the key is secret and the message is attacker-chosen; neither
/// holds at reveal time — the seed is published in this very instruction and the
/// index is a counter — so it buys nothing over a plain hash and costs a second
/// compression function on-chain. `verify.ts` on the client must be updated to
/// match, and a round settled under the old rule cannot be verified under the new
/// one, which is why this lands with the migration rather than after it.
#[derive(Accounts)]
pub struct RevealSeed<'info> {
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

    pub authority: Signer<'info>,
}

pub fn reveal_seed_handler(ctx: Context<RevealSeed>, seed: [u8; 32]) -> Result<()> {
    let round = &mut ctx.accounts.round;
    // The status is the guard against a second reveal: this sets it to Settled,
    // so a repeat call fails here rather than needing a flag to say so twice.
    require!(round.status == RoundStatus::Cut, CrownError::WrongStatus);

    // The commitment, checked against the reveal.
    let digest = hash(&seed);
    require!(
        digest.to_bytes() == round.commit_hash,
        CrownError::BadReveal
    );

    // Derived, never accepted. The first four bytes of sha256(seed || index),
    // taken big-endian and reduced modulo the window this round committed to —
    // the round's own window rather than the current config's, so a later change
    // cannot make a settled round fail its own verification.
    let mut message = [0u8; 40];
    message[..32].copy_from_slice(&seed);
    message[32..].copy_from_slice(&round.index.to_le_bytes());
    let mac = hash(&message).to_bytes();
    let offset = u32::from_be_bytes([mac[0], mac[1], mac[2], mac[3]]);

    let window = round.cut_window_seconds.max(1);
    let cut_at = round
        .lock_at
        .checked_add((offset % window) as i64)
        .ok_or(CrownError::Overflow)?;

    let now = Clock::get()?.unix_timestamp;
    require!(now >= cut_at, CrownError::CutNotReached);

    round.seed = seed;
    round.cut_at = cut_at;
    round.status = RoundStatus::Settled;

    Ok(())
}
