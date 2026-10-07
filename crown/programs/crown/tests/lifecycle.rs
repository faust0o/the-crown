//! One round, end to end, against an in-process SVM.
//!
//! The unit tests in `pricing.rs` prove the arithmetic; this proves the parts
//! only a runtime can answer — that the PDAs derive the way the client will
//! derive them, that the delegate actually lets a relayer move a player's credits
//! without the player signing, that the vault balances, and that the
//! commit-reveal refuses a seed that does not match.

use {
    anchor_lang::{
        solana_program::instruction::Instruction, AccountDeserialize, InstructionData,
        ToAccountMetas,
    },
    litesvm::LiteSVM,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_pubkey::Pubkey,
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

use crown::state::{Bet, BetStatus, Delegation, Round, RoundEntry, RoundStatus};

const CROWN_SO: &[u8] = include_bytes!("../../../target/deploy/crown.so");

/// Credits are whole units — there is no such thing as half a credit anywhere in
/// this game, and giving the mint decimals would invent one.
const DECIMALS: u8 = 0;

struct Ctx {
    svm: LiteSVM,
    payer: Keypair,
    mint: Pubkey,
    config: Pubkey,
    vault: Pubkey,
    /// The house's own credits — where the opening auction's stake comes from.
    house_tokens: Pubkey,
}

fn pda(seeds: &[&[u8]]) -> (Pubkey, u8) {
    Pubkey::find_program_address(seeds, &crown::id())
}

fn send(svm: &mut LiteSVM, ixs: &[Instruction], payer: &Keypair, extra: &[&Keypair]) {
    let blockhash = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(ixs, Some(&payer.pubkey()), &blockhash);
    let mut signers: Vec<&Keypair> = vec![payer];
    signers.extend_from_slice(extra);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &signers).unwrap();
    let res = svm.send_transaction(tx);
    if let Err(e) = res {
        panic!("transaction failed: {:?}\nlogs: {:#?}", e.err, e.meta.logs);
    }
}

fn try_send(
    svm: &mut LiteSVM,
    ixs: &[Instruction],
    payer: &Keypair,
    extra: &[&Keypair],
) -> Result<(), String> {
    let blockhash = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(ixs, Some(&payer.pubkey()), &blockhash);
    let mut signers: Vec<&Keypair> = vec![payer];
    signers.extend_from_slice(extra);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &signers).unwrap();
    svm.send_transaction(tx)
        .map(|_| ())
        .map_err(|e| format!("{:?}", e.err))
}

/// Assert a transaction failed with a specific program error.
///
/// Matched on the numeric code rather than a name, because that is all a failed
/// transaction carries — `InstructionError(0, Custom(6011))` and nothing else.
/// Derived from the enum rather than written out, so reordering `CrownError`
/// cannot silently make one of these assertions pass for the wrong reason.
fn assert_error(err: &str, expected: crown::error::CrownError) {
    let code = expected as u32 + anchor_lang::error::ERROR_CODE_OFFSET;
    assert!(
        err.contains(&format!("Custom({code})")),
        "expected {expected:?} (Custom({code})), got {err}"
    );
}

/// True once an account has been closed and its rent returned.
fn is_closed(svm: &LiteSVM, key: &Pubkey) -> bool {
    svm.get_account(key).map(|a| a.data.is_empty() && a.lamports == 0).unwrap_or(true)
}

fn read<T: AccountDeserialize>(svm: &LiteSVM, key: &Pubkey) -> T {
    let acct = svm.get_account(key).expect("account missing");
    T::try_deserialize(&mut acct.data.as_slice()).expect("failed to deserialise")
}

fn token_balance(svm: &LiteSVM, key: &Pubkey) -> u64 {
    let acct = svm.get_account(key).expect("token account missing");
    // amount sits at offset 64 in an SPL token account.
    u64::from_le_bytes(acct.data[64..72].try_into().unwrap())
}

/// Set the clock forward. The round lifecycle is entirely driven by
/// `Clock::unix_timestamp`, so every stage past the lock needs this.
fn warp_to(svm: &mut LiteSVM, unix_timestamp: i64) {
    let mut clock: solana_clock::Clock = svm.get_sysvar();
    clock.unix_timestamp = unix_timestamp;
    svm.set_sysvar(&clock);
}

fn now(svm: &LiteSVM) -> i64 {
    let clock: solana_clock::Clock = svm.get_sysvar();
    clock.unix_timestamp
}

/// Stand up the SVM, the credit mint, the config and the vault.
fn setup() -> Ctx {
    let mut svm = LiteSVM::new().with_default_programs();
    svm.add_program(crown::id(), CROWN_SO).unwrap();

    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 100_000_000_000).unwrap();

    // The credit mint, with the payer as mint authority.
    let mint_kp = Keypair::new();
    let mint = mint_kp.pubkey();
    let mint_rent = svm.minimum_balance_for_rent_exemption(82);
    let create_mint = solana_system_interface::instruction::create_account(
        &payer.pubkey(),
        &mint,
        mint_rent,
        82,
        &anchor_spl::token::ID,
    );
    let init_mint = anchor_spl::token::spl_token::instruction::initialize_mint(
        &anchor_spl::token::ID,
        &mint,
        &payer.pubkey(),
        None,
        DECIMALS,
    )
    .unwrap();
    send(&mut svm, &[create_mint, init_mint], &payer, &[&mint_kp]);

    let (config, _) = pda(&[crown::constants::CONFIG_SEED]);
    let (vault, _) = pda(&[crown::constants::VAULT_SEED]);

    let ix = Instruction::new_with_bytes(
        crown::id(),
        &crown::instruction::Initialize {}.data(),
        crown::accounts::Initialize {
            config,
            credit_mint: mint,
            vault,
            authority: payer.pubkey(),
            token_program: anchor_spl::token::ID,
            system_program: solana_system_interface::program::ID,
        }
        .to_account_metas(None),
    );
    send(&mut svm, &[ix], &payer, &[]);

    // The house's own credits. The opening auction is a real deposit now, so the
    // authority has to actually hold what it stakes — and a round that could not
    // fund its own book should fail at `add_entry` rather than at the first
    // winning settlement.
    let house_kp = Keypair::new();
    let house_tokens = house_kp.pubkey();
    let rent = svm.minimum_balance_for_rent_exemption(165);
    let create = solana_system_interface::instruction::create_account(
        &payer.pubkey(),
        &house_tokens,
        rent,
        165,
        &anchor_spl::token::ID,
    );
    let init = anchor_spl::token::spl_token::instruction::initialize_account(
        &anchor_spl::token::ID,
        &house_tokens,
        &mint,
        &payer.pubkey(),
    )
    .unwrap();
    let fund = anchor_spl::token::spl_token::instruction::mint_to(
        &anchor_spl::token::ID,
        &mint,
        &house_tokens,
        &payer.pubkey(),
        &[],
        1_000_000_000,
    )
    .unwrap();
    send(&mut svm, &[create, init, fund], &payer, &[&house_kp]);

    Ctx {
        svm,
        payer,
        mint,
        config,
        vault,
        house_tokens,
    }
}

/// A funded player whose token account is delegated to the program and who has
/// named `relayer` as the only key that may bet for them.
///
/// This is exactly the one-time setup the client performs in a single
/// transaction, and the point of doing it in one here is to prove that it *fits*
/// in one — a setup that needed two prompts would defeat the whole design.
fn open_player(ctx: &mut Ctx, relayer: &Pubkey, credits: u64) -> (Keypair, Pubkey, Pubkey) {
    let player = Keypair::new();
    ctx.svm.airdrop(&player.pubkey(), 10_000_000_000).unwrap();

    let tokens_kp = Keypair::new();
    let tokens = tokens_kp.pubkey();
    let rent = ctx.svm.minimum_balance_for_rent_exemption(165);
    let create = solana_system_interface::instruction::create_account(
        &ctx.payer.pubkey(),
        &tokens,
        rent,
        165,
        &anchor_spl::token::ID,
    );
    let init = anchor_spl::token::spl_token::instruction::initialize_account(
        &anchor_spl::token::ID,
        &tokens,
        &ctx.mint,
        &player.pubkey(),
    )
    .unwrap();
    let mint_to = anchor_spl::token::spl_token::instruction::mint_to(
        &anchor_spl::token::ID,
        &ctx.mint,
        &tokens,
        &ctx.payer.pubkey(),
        &[],
        credits,
    )
    .unwrap();
    send(
        &mut ctx.svm,
        &[create, init, mint_to],
        &ctx.payer.insecure_clone(),
        &[&tokens_kp],
    );

    // The two halves of the no-popup flow, in one transaction and therefore one
    // wallet prompt: the SPL allowance, and the named relayer.
    let approve = anchor_spl::token::spl_token::instruction::approve(
        &anchor_spl::token::ID,
        &tokens,
        &ctx.config,
        &player.pubkey(),
        &[],
        credits,
    )
    .unwrap();
    let (delegation, _) = pda(&[crown::constants::DELEGATION_SEED, player.pubkey().as_ref()]);
    let authorize = Instruction::new_with_bytes(
        crown::id(),
        &crown::instruction::AuthorizeRelayer { relayer: *relayer }.data(),
        crown::accounts::AuthorizeRelayer {
            delegation,
            owner: player.pubkey(),
            payer: player.pubkey(),
            system_program: solana_system_interface::program::ID,
        }
        .to_account_metas(None),
    );
    let player_clone = player.insecure_clone();
    send(&mut ctx.svm, &[approve, authorize], &player_clone, &[]);

    (player, tokens, delegation)
}

fn symbol_of(s: &str) -> [u8; 16] {
    let mut out = [0u8; 16];
    out[..s.len()].copy_from_slice(s.as_bytes());
    out
}

fn ticker_of(s: &str) -> [u8; 12] {
    let mut out = [0u8; 12];
    out[..s.len()].copy_from_slice(s.as_bytes());
    out
}

/// Open a round with two coins on the board, both quoted on all three legs.
fn open_round(ctx: &mut Ctx, seed: [u8; 32], lock_in: i64) -> (Pubkey, Vec<Pubkey>) {
    let commit_hash = solana_sha256_hasher::hash(&seed).to_bytes();
    let starts_at = now(&ctx.svm);
    let lock_at = starts_at + lock_in;
    let ends_at = lock_at + 60;

    let config: crown::state::Config = read(&ctx.svm, &ctx.config);
    let (round, _) = pda(&[
        crown::constants::ROUND_SEED,
        &config.round_count.to_le_bytes(),
    ]);

    let ix = Instruction::new_with_bytes(
        crown::id(),
        &crown::instruction::OpenRound {
            args: crown::instructions::OpenRoundArgs {
                starts_at,
                lock_at,
                ends_at,
                commit_hash,
                cut_window_seconds: 60,
                crown_symbol: [0u8; 16],
            },
        }
        .data(),
        crown::accounts::OpenRound {
            config: ctx.config,
            round,
            authority: ctx.payer.pubkey(),
            system_program: solana_system_interface::program::ID,
        }
        .to_account_metas(None),
    );
    let payer = ctx.payer.insecure_clone();
    send(&mut ctx.svm, &[ix], &payer, &[]);

    // Two coins. The opening auction stakes each leg in proportion to the prior,
    // computed off-chain — here a flat 100k/100k/100k, so the book opens at
    // 33/33/34 and every leg is tradable.
    let mut entries = Vec::new();
    for (i, (sym, tick, rank)) in [("SOL", "SOL", 1u16), ("BONK", "BONK", 2u16)]
        .into_iter()
        .enumerate()
    {
        let (entry, _) = pda(&[crown::constants::ENTRY_SEED, round.as_ref(), &[i as u8]]);
        let ix = Instruction::new_with_bytes(
            crown::id(),
            &crown::instruction::AddEntry {
                args: crown::instructions::AddEntryArgs {
                    index: i as u8,
                    symbol: symbol_of(sym),
                    ticker: ticker_of(tick),
                    start_rank: rank,
                    quoted: [true, true, true],
                    opening: [100_000, 100_000, 100_000],
                    target: 100,
                },
            }
            .data(),
            crown::accounts::AddEntry {
                config: ctx.config,
                round,
                entry,
                authority_tokens: ctx.house_tokens,
                vault: ctx.vault,
                authority: ctx.payer.pubkey(),
                token_program: anchor_spl::token::ID,
                system_program: solana_system_interface::program::ID,
            }
            .to_account_metas(None),
        );
        send(&mut ctx.svm, &[ix], &payer, &[]);
        entries.push(entry);
    }

    (round, entries)
}

#[allow(clippy::too_many_arguments)]
fn bet_pda(round: Pubkey, owner: Pubkey, entry_index: u8, direction: u8) -> Pubkey {
    pda(&[
        crown::constants::BET_SEED,
        round.as_ref(),
        owner.as_ref(),
        &[entry_index],
        &[direction],
    ])
    .0
}

fn place_bet_ix(
    ctx: &Ctx,
    round: Pubkey,
    entry: Pubkey,
    delegation: Pubkey,
    bettor: Pubkey,
    bettor_tokens: Pubkey,
    relayer: Pubkey,
    entry_index: u8,
    direction: u8,
    stake: u64,
    max_cents: u16,
) -> Instruction {
    let bet = bet_pda(round, bettor, entry_index, direction);
    Instruction::new_with_bytes(
        crown::id(),
        &crown::instruction::PlaceBet {
            args: crown::instructions::PlaceBetArgs {
                direction,
                stake,
                max_cents,
            },
        }
        .data(),
        crown::accounts::PlaceBet {
            config: ctx.config,
            round,
            entry,
            delegation,
            bet,
            bettor,
            bettor_tokens,
            vault: ctx.vault,
            relayer,
            token_program: anchor_spl::token::ID,
            system_program: solana_system_interface::program::ID,
        }
        .to_account_metas(None),
    )
}

#[test]
fn a_relayer_bets_for_a_player_who_never_signs_again() {
    const DIR: u8 = crown::pricing::HIGHER as u8;
    let mut ctx = setup();
    let relayer = Keypair::new();
    ctx.svm.airdrop(&relayer.pubkey(), 10_000_000_000).unwrap();

    let (player, tokens, delegation) = open_player(&mut ctx, &relayer.pubkey(), 10_000);
    let (round, entries) = open_round(&mut ctx, [7u8; 32], 600);

    let before = token_balance(&ctx.svm, &tokens);
    // Measured as a delta: the vault already holds the opening auction's deposit
    // for every entry on the board, which is the point of `add_entry` staking it
    // for real.
    let vault_before = token_balance(&ctx.svm, &ctx.vault);
    let ix = place_bet_ix(
        &ctx,
        round,
        entries[0],
        delegation,
        player.pubkey(),
        tokens,
        relayer.pubkey(),
        0,
        crown::pricing::HIGHER as u8,
        1_000,
        99,
    );
    // Signed by the relayer alone. The player's keypair is not among the signers
    // and this is the whole claim of the design.
    send(&mut ctx.svm, &[ix], &relayer, &[]);

    assert_eq!(
        token_balance(&ctx.svm, &tokens),
        before - 1_000,
        "the stake should have left the player's account"
    );
    assert_eq!(
        token_balance(&ctx.svm, &ctx.vault) - vault_before,
        1_000,
        "and arrived in the vault"
    );

    let bet_key = bet_pda(round, player.pubkey(), 0, DIR);
    let bet: Bet = read(&ctx.svm, &bet_key);
    assert_eq!(bet.owner, player.pubkey());
    assert_eq!(bet.stake, 1_000);
    assert_eq!(bet.status, BetStatus::Open);

    // The book opened flat at 33/33/34, so a thousand credits into a 300k pool
    // should fill a shade above a third plus the spread. Recovered from the
    // position rather than stored on it: `stake·100/shares` is the average entry.
    let average = bet.stake * 100 / bet.shares;
    assert!(
        (34..=36).contains(&average),
        "average entry {average}c, expected mid-thirties"
    );

    let entry: RoundEntry = read(&ctx.svm, &entries[0]);
    assert_eq!(entry.flow[crown::pricing::HIGHER], 1_000);
    assert_eq!(
        entry.last_cents.iter().sum::<u16>(),
        100,
        "the three marks must still sum to the target"
    );

    let delegation_acct: Delegation = read(&ctx.svm, &delegation);
    assert_eq!(delegation_acct.owner, player.pubkey());
}

#[test]
fn a_stranger_cannot_bet_with_someone_elses_allowance() {
    let mut ctx = setup();
    let relayer = Keypair::new();
    ctx.svm.airdrop(&relayer.pubkey(), 10_000_000_000).unwrap();

    let (player, tokens, delegation) = open_player(&mut ctx, &relayer.pubkey(), 10_000);
    let (round, entries) = open_round(&mut ctx, [7u8; 32], 600);

    // The griefing case the `Delegation` account exists to close. The allowance
    // is real and the delegate is the program, so the token program would happily
    // permit this transfer; what stops it is that the player never named this key.
    let stranger = Keypair::new();
    ctx.svm.airdrop(&stranger.pubkey(), 10_000_000_000).unwrap();

    let ix = place_bet_ix(
        &ctx,
        round,
        entries[0],
        delegation,
        player.pubkey(),
        tokens,
        stranger.pubkey(),
        0,
        crown::pricing::LOWER as u8,
        5_000,
        99,
    );
    let err = try_send(&mut ctx.svm, &[ix], &stranger, &[]).unwrap_err();
    assert_error(&err, crown::error::CrownError::NotAuthority);
    assert_eq!(
        token_balance(&ctx.svm, &tokens),
        10_000,
        "not a credit should have moved"
    );
}

#[test]
fn slippage_refuses_a_price_the_order_did_not_agree_to() {
    let mut ctx = setup();
    let relayer = Keypair::new();
    ctx.svm.airdrop(&relayer.pubkey(), 10_000_000_000).unwrap();

    let (player, tokens, delegation) = open_player(&mut ctx, &relayer.pubkey(), 100_000);
    let (round, entries) = open_round(&mut ctx, [7u8; 32], 600);

    // The book opens in the mid-thirties; refuse to pay more than 20c.
    let ix = place_bet_ix(
        &ctx,
        round,
        entries[0],
        delegation,
        player.pubkey(),
        tokens,
        relayer.pubkey(),
        0,
        crown::pricing::HIGHER as u8,
        1_000,
        20,
    );
    let err = try_send(&mut ctx.svm, &[ix], &relayer, &[]).unwrap_err();
    assert_error(&err, crown::error::CrownError::SlippageExceeded);
    assert_eq!(token_balance(&ctx.svm, &tokens), 100_000);
}

#[test]
fn the_commitment_refuses_a_seed_that_is_not_the_one_committed() {
    let mut ctx = setup();
    let seed = [42u8; 32];
    let (round, entries) = open_round(&mut ctx, seed, 10);
    let payer = ctx.payer.insecure_clone();

    let t = now(&ctx.svm) + 20;
    warp_to(&mut ctx.svm, t);


    for (i, entry) in entries.iter().enumerate() {
        let ix = Instruction::new_with_bytes(
            crown::id(),
            &crown::instruction::RecordCut {
                args: crown::instructions::RecordCutArgs { cut_rank: (i as u16) + 1 },
            }
            .data(),
            crown::accounts::RecordCut {
                config: ctx.config,
                round,
                entry: *entry,
                authority: payer.pubkey(),
            }
            .to_account_metas(None),
        );
        send(&mut ctx.svm, &[ix], &payer, &[]);
    }

    let t = now(&ctx.svm) + 120;
    warp_to(&mut ctx.svm, t);

    // A seed that is not the committed one must be refused, or the whole
    // commit-reveal is decoration.
    let wrong = Instruction::new_with_bytes(
        crown::id(),
        &crown::instruction::RevealSeed { seed: [9u8; 32] }.data(),
        crown::accounts::RevealSeed {
            config: ctx.config,
            round,
            authority: payer.pubkey(),
        }
        .to_account_metas(None),
    );
    let err = try_send(&mut ctx.svm, &[wrong], &payer, &[]).unwrap_err();
    assert_error(&err, crown::error::CrownError::BadReveal);

    // The real one is accepted, and fixes the cut instant.
    let right = Instruction::new_with_bytes(
        crown::id(),
        &crown::instruction::RevealSeed { seed }.data(),
        crown::accounts::RevealSeed {
            config: ctx.config,
            round,
            authority: payer.pubkey(),
        }
        .to_account_metas(None),
    );
    send(&mut ctx.svm, &[right], &payer, &[]);

    let r: Round = read(&ctx.svm, &round);
    assert_eq!(r.status, RoundStatus::Settled);
    assert_ne!(r.seed, [0u8; 32], "the seed should now be published");
    assert!(
        r.cut_at >= r.lock_at && r.cut_at < r.lock_at + r.cut_window_seconds as i64,
        "the cut must land inside the window it committed to"
    );
}

#[test]
fn a_winning_lot_is_paid_and_a_losing_one_is_not() {
    const DIR: u8 = crown::pricing::LOWER as u8;
    let mut ctx = setup();
    let relayer = Keypair::new();
    ctx.svm.airdrop(&relayer.pubkey(), 10_000_000_000).unwrap();
    let payer = ctx.payer.insecure_clone();

    let (player, tokens, delegation) = open_player(&mut ctx, &relayer.pubkey(), 10_000);
    let seed = [3u8; 32];
    let (round, entries) = open_round(&mut ctx, seed, 60);

    // SOL starts at rank 1. Back it to go LOWER, then record a cut where it does.
    let ix = place_bet_ix(
        &ctx,
        round,
        entries[0],
        delegation,
        player.pubkey(),
        tokens,
        relayer.pubkey(),
        0,
        crown::pricing::LOWER as u8,
        1_000,
        99,
    );
    send(&mut ctx.svm, &[ix], &relayer, &[]);

    let bet_key = bet_pda(round, player.pubkey(), 0, DIR);
    let bet: Bet = read(&ctx.svm, &bet_key);
    // Each share pays one credit when the leg lands, so the shares are the payout.
    let expected_payout = bet.shares;

    // The vault has to be able to pay a win. In production the desks' losing
    // stakes fund it; here the house tops it up so settlement is what is under
    // test rather than the funding.
    let top_up = anchor_spl::token::spl_token::instruction::mint_to(
        &anchor_spl::token::ID,
        &ctx.mint,
        &ctx.vault,
        &payer.pubkey(),
        &[],
        expected_payout,
    )
    .unwrap();
    send(&mut ctx.svm, &[top_up], &payer, &[]);

    let t = now(&ctx.svm) + 70;
    warp_to(&mut ctx.svm, t);

    // SOL (start rank 1) finishes 2nd — it went LOWER, so the bet lands.
    for (i, entry) in entries.iter().enumerate() {
        let cut_rank = if i == 0 { 2 } else { 1 };
        let ix = Instruction::new_with_bytes(
            crown::id(),
            &crown::instruction::RecordCut {
                args: crown::instructions::RecordCutArgs { cut_rank },
            }
            .data(),
            crown::accounts::RecordCut {
                config: ctx.config,
                round,
                entry: *entry,
                authority: payer.pubkey(),
            }
            .to_account_metas(None),
        );
        send(&mut ctx.svm, &[ix], &payer, &[]);
    }

    let t = now(&ctx.svm) + 120;
    warp_to(&mut ctx.svm, t);
    let reveal = Instruction::new_with_bytes(
        crown::id(),
        &crown::instruction::RevealSeed { seed }.data(),
        crown::accounts::RevealSeed {
            config: ctx.config,
            round,
            authority: payer.pubkey(),
        }
        .to_account_metas(None),
    );
    send(&mut ctx.svm, &[reveal], &payer, &[]);

    let before = token_balance(&ctx.svm, &tokens);

    // Settled by a stranger, which is the point of it being permissionless: the
    // payout is computed from the bet and can only reach the bet's owner.
    let stranger = Keypair::new();
    ctx.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    let settle = Instruction::new_with_bytes(
        crown::id(),
        &crown::instruction::SettleBet {}.data(),
        crown::accounts::SettleBet {
            config: ctx.config,
            round,
            entry: entries[0],
            bet: bet_key,
            owner_tokens: tokens,
            vault: ctx.vault,
            rent_receiver: relayer.pubkey(),
            token_program: anchor_spl::token::ID,
        }
        .to_account_metas(None),
    );
    send(&mut ctx.svm, &[settle], &stranger, &[]);

    assert!(is_closed(&ctx.svm, &bet_key), "a settled lot must not keep its rent");
    assert_eq!(
        token_balance(&ctx.svm, &tokens),
        before + expected_payout,
        "the payout should have reached the player, not the caller"
    );

    // Settling twice must not pay twice.
    let again = Instruction::new_with_bytes(
        crown::id(),
        &crown::instruction::SettleBet {}.data(),
        crown::accounts::SettleBet {
            config: ctx.config,
            round,
            entry: entries[0],
            bet: bet_key,
            owner_tokens: tokens,
            vault: ctx.vault,
            rent_receiver: relayer.pubkey(),
            token_program: anchor_spl::token::ID,
        }
        .to_account_metas(None),
    );
    assert!(
        try_send(&mut ctx.svm, &[again], &stranger, &[]).is_err(),
        "a settled bet must not settle again — its account no longer exists"
    );
}

#[test]
fn the_vault_holds_what_the_book_prices_off() {
    // The solvency property that `add_entry`'s deposit exists for: the pool every
    // mark is a share of must be credits the vault actually has. Before the
    // deposit was real this was 0 against a priced pool of 600k.
    let mut ctx = setup();
    let (_round, entries) = open_round(&mut ctx, [1u8; 32], 600);

    let mut priced = 0u64;
    for e in &entries {
        let entry: RoundEntry = read(&ctx.svm, e);
        priced += entry.opening.iter().sum::<u64>();
    }
    assert_eq!(
        token_balance(&ctx.svm, &ctx.vault),
        priced,
        "the vault must hold every credit the book is pricing against"
    );
}

#[test]
fn closing_early_returns_the_bid_and_unwinds_the_flow() {
    const DIR: u8 = crown::pricing::HIGHER as u8;
    let mut ctx = setup();
    let relayer = Keypair::new();
    ctx.svm.airdrop(&relayer.pubkey(), 10_000_000_000).unwrap();

    let (player, tokens, delegation) = open_player(&mut ctx, &relayer.pubkey(), 10_000);
    let (round, entries) = open_round(&mut ctx, [5u8; 32], 600);

    let ix = place_bet_ix(
        &ctx, round, entries[0], delegation, player.pubkey(), tokens,
        relayer.pubkey(), 0, crown::pricing::HIGHER as u8, 1_000, 99,
    );
    send(&mut ctx.svm, &[ix], &relayer, &[]);

    let after_bet = token_balance(&ctx.svm, &tokens);
    let flowed: RoundEntry = read(&ctx.svm, &entries[0]);
    assert_eq!(flowed.flow[crown::pricing::HIGHER], 1_000);

    let bet_key = bet_pda(round, player.pubkey(), 0, DIR);
    let close = Instruction::new_with_bytes(
        crown::id(),
        &crown::instruction::CloseBet {}.data(),
        crown::accounts::CloseBet {
            config: ctx.config, round, entry: entries[0], bet: bet_key,
            owner: player.pubkey(), owner_tokens: tokens, vault: ctx.vault,
            rent_receiver: relayer.pubkey(),
            token_program: anchor_spl::token::ID,
        }.to_account_metas(None),
    );
    let player_kp = player.insecure_clone();
    send(&mut ctx.svm, &[close], &player_kp, &[]);

    // The lot's account is gone and its rent went back to the relayer that paid
    // it, so what it paid has to be read off the balance rather than the record.
    assert!(is_closed(&ctx.svm, &bet_key), "a closed lot must not keep its rent");
    let paid = token_balance(&ctx.svm, &tokens) - after_bet;

    // A round trip must cost the spread — never return more than it cost.
    assert!(
        paid > 0 && paid < 1_000,
        "closed for {paid} against a 1000 stake; a round trip must not be free"
    );

    // And the stake must come back out of the pool, or a position could bid its
    // own line up and sell into the bid it created.
    let unwound: RoundEntry = read(&ctx.svm, &entries[0]);
    assert_eq!(unwound.flow[crown::pricing::HIGHER], 0);
    assert_eq!(unwound.last_cents.iter().sum::<u16>(), 100);
}

#[test]
fn a_coin_with_no_recorded_cut_is_voided_and_refunded() {
    const DIR: u8 = crown::pricing::HIGHER as u8;
    let mut ctx = setup();
    let relayer = Keypair::new();
    ctx.svm.airdrop(&relayer.pubkey(), 10_000_000_000).unwrap();
    let payer = ctx.payer.insecure_clone();

    let (player, tokens, delegation) = open_player(&mut ctx, &relayer.pubkey(), 10_000);
    let seed = [11u8; 32];
    let (round, entries) = open_round(&mut ctx, seed, 60);

    let ix = place_bet_ix(
        &ctx, round, entries[0], delegation, player.pubkey(), tokens,
        relayer.pubkey(), 0, crown::pricing::HIGHER as u8, 1_000, 99,
    );
    send(&mut ctx.svm, &[ix], &relayer, &[]);
    let after_bet = token_balance(&ctx.svm, &tokens);

    let t = now(&ctx.svm) + 70;
    warp_to(&mut ctx.svm, t);

    // Record a cut for the *second* coin only. The first never gets one, which is
    // the case that used to strand a bet open forever.
    let ix = Instruction::new_with_bytes(
        crown::id(),
        &crown::instruction::RecordCut {
            args: crown::instructions::RecordCutArgs { cut_rank: 1 },
        }.data(),
        crown::accounts::RecordCut {
            config: ctx.config, round, entry: entries[1], authority: payer.pubkey(),
        }.to_account_metas(None),
    );
    send(&mut ctx.svm, &[ix], &payer, &[]);

    let t = now(&ctx.svm) + 120;
    warp_to(&mut ctx.svm, t);
    let reveal = Instruction::new_with_bytes(
        crown::id(),
        &crown::instruction::RevealSeed { seed }.data(),
        crown::accounts::RevealSeed {
            config: ctx.config, round, authority: payer.pubkey(),
        }.to_account_metas(None),
    );
    send(&mut ctx.svm, &[reveal], &payer, &[]);

    let bet_key = bet_pda(round, player.pubkey(), 0, DIR);
    let settle = Instruction::new_with_bytes(
        crown::id(),
        &crown::instruction::SettleBet {}.data(),
        crown::accounts::SettleBet {
            config: ctx.config, round, entry: entries[0], bet: bet_key,
            owner_tokens: tokens, vault: ctx.vault,
            rent_receiver: relayer.pubkey(),
            token_program: anchor_spl::token::ID,
        }.to_account_metas(None),
    );
    send(&mut ctx.svm, &[settle], &payer, &[]);

    assert!(is_closed(&ctx.svm, &bet_key));
    assert_eq!(
        token_balance(&ctx.svm, &tokens),
        after_bet + 1_000,
        "a void bet refunds the stake exactly"
    );
}

#[test]
fn the_crown_cannot_be_bet_on_and_a_locked_round_takes_nothing() {
    let mut ctx = setup();
    let relayer = Keypair::new();
    ctx.svm.airdrop(&relayer.pubkey(), 10_000_000_000).unwrap();
    let payer = ctx.payer.insecure_clone();

    let (player, tokens, delegation) = open_player(&mut ctx, &relayer.pubkey(), 10_000);

    // Open a round whose crown is SOL — entry 0.
    let seed = [13u8; 32];
    let commit_hash = solana_sha256_hasher::hash(&seed).to_bytes();
    let starts_at = now(&ctx.svm);
    let config: crown::state::Config = read(&ctx.svm, &ctx.config);
    let (round, _) = pda(&[
        crown::constants::ROUND_SEED, &config.round_count.to_le_bytes(),
    ]);
    let open = Instruction::new_with_bytes(
        crown::id(),
        &crown::instruction::OpenRound {
            args: crown::instructions::OpenRoundArgs {
                starts_at, lock_at: starts_at + 60, ends_at: starts_at + 120,
                commit_hash, cut_window_seconds: 60,
                crown_symbol: symbol_of("SOL"),
            },
        }.data(),
        crown::accounts::OpenRound {
            config: ctx.config, round, authority: payer.pubkey(),
            system_program: solana_system_interface::program::ID,
        }.to_account_metas(None),
    );
    send(&mut ctx.svm, &[open], &payer, &[]);

    let mut entries = Vec::new();
    for (i, (sym, tick, rank)) in [("SOL", "SOL", 1u16), ("BONK", "BONK", 2u16)]
        .into_iter().enumerate()
    {
        let (entry, _) = pda(&[crown::constants::ENTRY_SEED, round.as_ref(), &[i as u8]]);
        let ix = Instruction::new_with_bytes(
            crown::id(),
            &crown::instruction::AddEntry {
                args: crown::instructions::AddEntryArgs {
                    index: i as u8, symbol: symbol_of(sym), ticker: ticker_of(tick),
                    start_rank: rank,
                    quoted: [true, true, true],
                    opening: [100_000, 100_000, 100_000], target: 100,
                },
            }.data(),
            crown::accounts::AddEntry {
                config: ctx.config, round, entry,
                authority_tokens: ctx.house_tokens, vault: ctx.vault,
                authority: payer.pubkey(),
                token_program: anchor_spl::token::ID,
                system_program: solana_system_interface::program::ID,
            }.to_account_metas(None),
        );
        send(&mut ctx.svm, &[ix], &payer, &[]);
        entries.push(entry);
    }

    // Backing the reigning coin is refused; backing the challenger is not.
    let ix = place_bet_ix(
        &ctx, round, entries[0], delegation, player.pubkey(), tokens,
        relayer.pubkey(), 0, crown::pricing::HIGHER as u8, 1_000, 99,
    );
    let err = try_send(&mut ctx.svm, &[ix], &relayer, &[]).unwrap_err();
    assert_error(&err, crown::error::CrownError::Crown);

    let ix = place_bet_ix(
        &ctx, round, entries[1], delegation, player.pubkey(), tokens,
        relayer.pubkey(), 1, crown::pricing::HIGHER as u8, 1_000, 99,
    );
    send(&mut ctx.svm, &[ix], &relayer, &[]);

    // Past the lock, the clock refuses a bet whether or not anyone called
    // `lock_round` — the status is a consequence, not the gate.
    let t = now(&ctx.svm) + 90;
    warp_to(&mut ctx.svm, t);
    let ix = place_bet_ix(
        &ctx, round, entries[1], delegation, player.pubkey(), tokens,
        relayer.pubkey(), 1, crown::pricing::DRAW as u8, 500, 99,
    );
    let err = try_send(&mut ctx.svm, &[ix], &relayer, &[]).unwrap_err();
    assert_error(&err, crown::error::CrownError::RoundClosed);
}

#[test]
fn buying_the_same_leg_twice_merges_without_losing_anything() {
    // The claim that lets one account serve a whole position: two buys at two
    // different prices are worth exactly the sum of their shares, so merging them
    // is lossless. If that were false, the desks' rent would be a function of how
    // often they traded and a one-second tick would cost twenty-eight SOL a round.
    //
    // Checked by arithmetic the account cannot influence: the shares each buy
    // *should* earn are computed here from the fill price the book quoted at the
    // time, and the merged position must equal their sum.
    const DIR: u8 = crown::pricing::HIGHER as u8;
    let mut ctx = setup();
    let relayer = Keypair::new();
    ctx.svm.airdrop(&relayer.pubkey(), 10_000_000_000).unwrap();

    let (player, tokens, delegation) = open_player(&mut ctx, &relayer.pubkey(), 200_000);
    let (round, entries) = open_round(&mut ctx, [21u8; 32], 600);

    let mut expected_shares = 0u64;
    let mut expected_stake = 0u64;
    let mut prices = Vec::new();

    // Three buys of very different sizes, so they fill at visibly different
    // prices — a merge that only worked at one price would prove nothing.
    for stake in [1_000u64, 50_000, 7_000] {
        let entry: RoundEntry = read(&ctx.svm, &entries[0]);
        let quoted = crown::pricing::fill_cents(&entry.book(), DIR as usize, stake)
            .expect("the leg must be on the book");

        let ix = place_bet_ix(
            &ctx, round, entries[0], delegation, player.pubkey(), tokens,
            relayer.pubkey(), 0, DIR, stake, 99,
        );
        send(&mut ctx.svm, &[ix], &relayer, &[]);

        expected_shares += stake * 100 / quoted as u64;
        expected_stake += stake;
        prices.push(quoted);
    }

    assert!(
        prices[0] != prices[1] || prices[1] != prices[2],
        "the three buys filled at the same price ({prices:?}) — this proves nothing"
    );

    // One account, not three.
    let position: Bet = read(&ctx.svm, &bet_pda(round, player.pubkey(), 0, DIR));
    assert_eq!(position.stake, expected_stake);
    assert_eq!(
        position.shares, expected_shares,
        "merged shares must equal what three separate lots would have earned \
         (filled at {prices:?})"
    );

    // And the average entry the client shows is recoverable, sitting between the
    // best and worst price paid rather than equal to either.
    let average = position.stake * 100 / position.shares;
    let (lo, hi) = (
        *prices.iter().min().unwrap() as u64,
        *prices.iter().max().unwrap() as u64,
    );
    assert!(
        (lo..=hi).contains(&average),
        "average entry {average}c should sit within the prices paid {prices:?}"
    );
}

/// A round whose seed never arrives must not keep everybody's stake.
///
/// The seed is the one part of the design that lives off-chain until the reveal,
/// which is what makes the commitment worth anything — and it means a house that
/// loses it used to strand every position on that round permanently: the stake in
/// the vault, the accounts unclosable, and no instruction in the program able to
/// move either. It had already happened twice on devnet, to 101 positions and
/// about 3.1 million credits.
#[test]
fn a_round_that_can_never_reveal_gives_the_stakes_back() {
    const DIR: u8 = crown::pricing::LOWER as u8;
    const STAKE: u64 = 1_000;
    let mut ctx = setup();
    let relayer = Keypair::new();
    ctx.svm.airdrop(&relayer.pubkey(), 10_000_000_000).unwrap();
    let payer = ctx.payer.insecure_clone();

    let (player, tokens, delegation) = open_player(&mut ctx, &relayer.pubkey(), 10_000);
    let (round, entries) = open_round(&mut ctx, [7u8; 32], 60);

    let before = token_balance(&ctx.svm, &tokens);
    let ix = place_bet_ix(
        &ctx, round, entries[0], delegation, player.pubkey(), tokens,
        relayer.pubkey(), 0, DIR, STAKE, 99,
    );
    send(&mut ctx.svm, &[ix], &relayer, &[]);
    let bet_key = bet_pda(round, player.pubkey(), 0, DIR);
    assert_eq!(token_balance(&ctx.svm, &tokens), before - STAKE, "the stake went to the vault");

    // The ranks are recorded, so the outcome is sitting right there — and it is
    // still not payable, because nothing has proved when the house looked.
    for (i, entry) in entries.iter().enumerate() {
        let cut_rank = if i == 0 { 2 } else { 1 };
        let ix = Instruction::new_with_bytes(
            crown::id(),
            &crown::instruction::RecordCut {
                args: crown::instructions::RecordCutArgs { cut_rank },
            }
            .data(),
            crown::accounts::RecordCut {
                config: ctx.config, round, entry: *entry, authority: payer.pubkey(),
            }
            .to_account_metas(None),
        );
        let t = now(&ctx.svm) + if i == 0 { 70 } else { 0 };
        warp_to(&mut ctx.svm, t);
        send(&mut ctx.svm, &[ix], &payer, &[]);
    }

    let void_ix = || Instruction::new_with_bytes(
        crown::id(),
        &crown::instruction::VoidRound {}.data(),
        crown::accounts::VoidRound { config: ctx.config, round }.to_account_metas(None),
    );

    // A round that is merely slow must resolve normally. Voiding early would make
    // "the house lost the seed" something the house could choose to do.
    let err = try_send(&mut ctx.svm, &[void_ix()], &payer, &[]).unwrap_err();
    assert_error(&err, crown::error::CrownError::VoidTooEarly);

    // A week later it is genuinely lost.
    let r: Round = read(&ctx.svm, &round);
    warp_to(&mut ctx.svm, r.ends_at + crown::constants::VOID_AFTER_SECONDS + 1);

    // By a stranger: this is the path a player takes when the house is gone, so
    // it cannot need the house.
    let stranger = Keypair::new();
    ctx.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    send(&mut ctx.svm, &[void_ix()], &stranger, &[]);

    let r: Round = read(&ctx.svm, &round);
    assert_eq!(r.status, RoundStatus::Voided);
    assert_eq!(r.seed, [0u8; 32], "nothing was revealed, and nothing should claim to be");

    // And now the stake comes back — the stake, not the claim. The bet would have
    // *won* on the recorded ranks, and it is deliberately not paid as a winner:
    // an unverifiable result pays nobody.
    let settle = Instruction::new_with_bytes(
        crown::id(),
        &crown::instruction::SettleBet {}.data(),
        crown::accounts::SettleBet {
            config: ctx.config, round, entry: entries[0], bet: bet_key,
            owner_tokens: tokens, vault: ctx.vault, rent_receiver: relayer.pubkey(),
            token_program: anchor_spl::token::ID,
        }
        .to_account_metas(None),
    );
    send(&mut ctx.svm, &[settle], &stranger, &[]);

    assert_eq!(
        token_balance(&ctx.svm, &tokens), before,
        "a voided round must return exactly what was staked — no more, no less"
    );
    assert!(is_closed(&ctx.svm, &bet_key), "and the position's rent comes back with it");

    // Voiding is not a second bite at a finished round.
    assert!(
        try_send(&mut ctx.svm, &[void_ix()], &stranger, &[]).is_err(),
        "a voided round must not void again"
    );
}
