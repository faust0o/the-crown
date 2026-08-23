use anchor_lang::prelude::*;

/// PDA seeds.
///
/// `CONFIG` earns its keep three times over: it is the config account, the owner
/// of the vault, and the SPL delegate a player approves. One PDA for all three
/// means a player's `approve` names an address that provably belongs to this
/// program, and the payout path signs with the same seeds it already had.
#[constant]
pub const CONFIG_SEED: &[u8] = b"config";
#[constant]
pub const VAULT_SEED: &[u8] = b"vault";
#[constant]
pub const ROUND_SEED: &[u8] = b"round";
#[constant]
pub const ENTRY_SEED: &[u8] = b"entry";
#[constant]
pub const BET_SEED: &[u8] = b"bet";
#[constant]
pub const DELEGATION_SEED: &[u8] = b"delegation";

/// The most coins a round can put on the board.
///
/// `BOARD_SIZE` in `server/src/oracle/index.ts` is ten. The cap is here so
/// `entry_count` and the index in a bet's seeds cannot disagree about what fits
/// in a `u8`.
pub const MAX_ENTRIES: u8 = 32;

/// How long after a round ends before its storage may be reclaimed.
///
/// Settlement is a sweep over every position and it reads the entry accounts to
/// decide each outcome, so closing them is only safe once the sweep can no
/// longer be running. An hour is far longer than a sweep takes and far shorter
/// than the rent matters over — and it leaves a player who wants to settle their
/// own position, which they may always do, a generous window to do it in.
pub const SETTLEMENT_GRACE_SECONDS: i64 = 3600;
