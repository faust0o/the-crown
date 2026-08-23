/**
 * One round, end to end, against a real validator.
 *
 * The Rust tests run the program inside an in-process SVM; this runs it the way
 * the server will — over RPC, through the Anchor TypeScript client, with the
 * account encodings and PDA derivations that client computes rather than the ones
 * the program computes. Those are two independent implementations of the same
 * seeds, and the failure mode when they disagree is silent: a wrong seed derives
 * a different valid address, and the error surfaces later as a missing account.
 *
 * It also checks the thing neither test suite can on its own — that the price the
 * TypeScript quotes off `pricing.ts` is the price the chain actually charged.
 *
 * ```sh
 * solana-test-validator --reset --quiet &
 * anchor deploy --provider.cluster http://127.0.0.1:8899 --provider.wallet <treasury>
 * node --import tsx server/src/chain/smoke.ts
 * ```
 */

import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createApproveInstruction,
  createAssociatedTokenAccountInstruction,
  createInitializeMintInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  getAccount,
  getMinimumBalanceForRentExemptMint,
  MINT_SIZE,
} from "@solana/spl-token";

import {
  BN,
  betPda,
  configPda,
  connection,
  crownProgram,
  delegationPda,
  entryPda,
  roundPda,
  vaultPda,
} from "./program";
import { fillCents, remark, type Book } from "./pricing";
import { readBoard, closeFor, quoteFor } from "./book";

const conn = connection();

/** Credits are whole units; a mint with decimals would invent half a credit. */
const DECIMALS = 0;
/** What the opening auction stakes on each leg of each coin. */
const OPENING: [bigint, bigint, bigint] = [100_000n, 100_000n, 100_000n];

const pad = (s: string, n: number) => {
  const b = Buffer.alloc(n);
  b.write(s);
  return Array.from(b);
};

const ok = (label: string) => console.log(`  ✓ ${label}`);
const fail = (label: string, detail: string): never => {
  console.error(`  ✗ ${label}\n    ${detail}`);
  process.exit(1);
};

async function fund(kp: Keypair, sol = 10) {
  const sig = await conn.requestAirdrop(kp.publicKey, sol * LAMPORTS_PER_SOL);
  const bh = await conn.getLatestBlockhash();
  await conn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
}

async function main() {
  const version = await conn.getVersion();
  console.log(`validator ${version["solana-core"]} at ${conn.rpcEndpoint}\n`);

  const authority = Keypair.generate();
  const relayer = Keypair.generate();
  const player = Keypair.generate();
  await Promise.all([fund(authority, 50), fund(relayer, 50), fund(player, 5)]);

  const program = crownProgram(authority, conn);

  // --- the credit mint -----------------------------------------------------
  const mintKp = Keypair.generate();
  const mint = mintKp.publicKey;
  const lamports = await getMinimumBalanceForRentExemptMint(conn);
  await sendAndConfirmTransaction(
    conn,
    new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: authority.publicKey,
        newAccountPubkey: mint,
        space: MINT_SIZE,
        lamports,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMintInstruction(mint, DECIMALS, authority.publicKey, null)
    ),
    [authority, mintKp]
  );
  ok(`credit mint ${mint.toBase58().slice(0, 8)}…`);

  // --- config + vault ------------------------------------------------------
  const config = configPda();
  const vault = vaultPda();
  await program.methods
    .initialize()
    .accounts({
      config,
      creditMint: mint,
      vault,
      authority: authority.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  ok("initialize — config and vault stood up");

  // The house's own credits, which the opening auction is deposited from.
  const houseAta = getAssociatedTokenAddressSync(mint, authority.publicKey);
  await sendAndConfirmTransaction(
    conn,
    new Transaction().add(
      createAssociatedTokenAccountInstruction(authority.publicKey, houseAta, authority.publicKey, mint),
      createMintToInstruction(mint, houseAta, authority.publicKey, 1_000_000_000)
    ),
    [authority]
  );

  // --- a round with two coins ---------------------------------------------
  const seed = Buffer.alloc(32, 7);
  const { createHash } = await import("node:crypto");
  const commitHash = createHash("sha256").update(seed).digest();

  const cfg = await (program.account as any).config.fetch(config);
  const round = roundPda(BigInt(cfg.roundCount.toString()));

  const nowSec = Math.floor(Date.now() / 1000);
  const LOCK_IN = 12;
  await program.methods
    .openRound({
      startsAt: new BN(nowSec),
      lockAt: new BN(nowSec + LOCK_IN),
      endsAt: new BN(nowSec + LOCK_IN + 5),
      commitHash: Array.from(commitHash),
      cutWindowSeconds: 5,
      crownSymbol: pad("", 16),
    })
    .accounts({
      config,
      round,
      authority: authority.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  ok(`open_round — commitment published before any bet exists`);

  const coins = [
    { symbol: "SOL", ticker: "SOL", startRank: 1 },
    { symbol: "BONK", ticker: "BONK", startRank: 2 },
  ];
  const entries: PublicKey[] = [];
  for (const [i, coin] of coins.entries()) {
    const entry = entryPda(round, i);
    await program.methods
      .addEntry({
        index: i,
        symbol: pad(coin.symbol, 16),
        ticker: pad(coin.ticker, 12),
        startRank: coin.startRank,
        quoted: [true, true, true],
        opening: OPENING.map((v) => new BN(v.toString())),
        target: 100,
      })
      .accounts({
        config,
        round,
        entry,
        authorityTokens: houseAta,
        vault,
        authority: authority.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    entries.push(entry);
  }

  const vaultAfterOpen = await getAccount(conn, vault);
  const expectedBacking = BigInt(coins.length) * OPENING.reduce((a, b) => a + b, 0n);
  if (vaultAfterOpen.amount !== expectedBacking) {
    fail(
      "the vault must hold every credit the book prices against",
      `vault ${vaultAfterOpen.amount} vs priced ${expectedBacking}`
    );
  }
  ok(`add_entry ×${coins.length} — opening auction deposited (${vaultAfterOpen.amount} credits backing the book)`);

  // --- the hand-rolled decoder, against Anchor's own -----------------------
  //
  // `book.ts` reads RoundEntry by byte offset rather than through the Anchor
  // client, so that quoting the board needs no signing wallet. Hand-written
  // offsets are exactly the thing that goes subtly wrong and stays wrong, so
  // they are checked here against the client that generates its layout from the
  // IDL. A drift between these two would misprice every line on the board.
  const decoded = await readBoard(BigInt(cfg.roundCount.toString()), coins.length);
  if (decoded.length !== coins.length) {
    fail("decoder found the wrong number of entries", `${decoded.length} vs ${coins.length}`);
  }
  for (const [i, d] of decoded.entries()) {
    const viaAnchor = await (program.account as any).roundEntry.fetch(entries[i]);
    const mismatch =
      d.symbol !== coins[i].symbol ||
      d.ticker !== coins[i].ticker ||
      d.startRank !== viaAnchor.startRank ||
      d.index !== viaAnchor.index ||
      d.book.target !== viaAnchor.target ||
      JSON.stringify(d.lastCents) !== JSON.stringify(viaAnchor.lastCents) ||
      d.book.staked.some(
        (v, k) =>
          v !==
          BigInt(viaAnchor.opening[k].toString()) + BigInt(viaAnchor.flow[k].toString())
      );
    if (mismatch) {
      fail(
        "the byte-offset decoder disagrees with Anchor",
        `entry ${i}: decoded ${JSON.stringify({ ...d, book: { ...d.book, staked: d.book.staked.map(String) } })}`
      );
    }
  }
  ok(`book.ts decoder agrees with Anchor on all ${decoded.length} entries`);

  // --- the player's one-time setup, in a single transaction ----------------
  const playerAta = getAssociatedTokenAddressSync(mint, player.publicKey);
  const ALLOWANCE = 50_000;
  const delegation = delegationPda(player.publicKey);

  await sendAndConfirmTransaction(
    conn,
    new Transaction().add(
      createAssociatedTokenAccountInstruction(authority.publicKey, playerAta, player.publicKey, mint),
      createMintToInstruction(mint, playerAta, authority.publicKey, ALLOWANCE)
    ),
    [authority]
  );

  // One transaction, therefore one wallet prompt: the SPL allowance and the
  // named relayer. Everything after this costs the player no signature at all.
  const setup = new Transaction().add(
    createApproveInstruction(playerAta, config, player.publicKey, ALLOWANCE),
    await program.methods
      .authorizeRelayer(relayer.publicKey)
      .accounts({
        delegation,
        owner: player.publicKey,
        payer: player.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .instruction()
  );
  await sendAndConfirmTransaction(conn, setup, [player]);
  ok("player setup — approve + authorize_relayer in ONE transaction (one prompt, ever)");

  // --- a bet the player does not sign --------------------------------------
  const entryBefore = await (program.account as any).roundEntry.fetch(entries[0]);
  const book: Book = {
    staked: [0, 1, 2].map((d) =>
      BigInt(entryBefore.opening[d].toString()) + BigInt(entryBefore.flow[d].toString())
    ) as [bigint, bigint, bigint],
    quoted: entryBefore.quoted,
    target: entryBefore.target,
  };
  const STAKE = 1_000n;
  const quoted = fillCents(book, 0, STAKE);
  const quotedMarks = remark(book);

  const relayerProgram = crownProgram(relayer, conn);
  await relayerProgram.methods
    .placeBet({ direction: 0, stake: new BN(STAKE.toString()), maxCents: 99 })
    .accounts({
      config,
      round,
      entry: entries[0],
      delegation,
      bet: betPda(round, player.publicKey, 0, 0),
      bettor: player.publicKey,
      bettorTokens: playerAta,
      vault,
      relayer: relayer.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  const bet = await (program.account as any).bet.fetch(betPda(round, player.publicKey, 0, 0));
  // The account stores shares, not a price — the average entry is recovered from
  // `stake·100/shares`, and for a single buy that is exactly the fill.
  const filled = Number(
    (BigInt(bet.stake.toString()) * 100n) / BigInt(bet.shares.toString())
  );
  if (filled !== quoted) {
    fail(
      "the board's quote must be the price the chain charged",
      `pricing.ts said ${quoted}c, the chain filled at ${filled}c`
    );
  }
  ok(`place_bet — relayer-signed, player never signed. Quoted ${quoted}c, filled ${filled}c — identical`);

  const playerAfter = await getAccount(conn, playerAta);
  if (playerAfter.amount !== BigInt(ALLOWANCE) - STAKE) {
    fail("stake did not leave the player's account", `${playerAfter.amount}`);
  }
  ok(`delegate moved ${STAKE} credits without the player's signature`);

  const entryAfter = await (program.account as any).roundEntry.fetch(entries[0]);
  const chainMarks = entryAfter.lastCents;
  const nextBook: Book = { ...book, staked: [book.staked[0] + STAKE, book.staked[1], book.staked[2]] };
  const predicted = remark(nextBook);
  if (JSON.stringify(chainMarks) !== JSON.stringify(predicted)) {
    fail("re-marking disagrees", `chain ${chainMarks} vs pricing.ts ${predicted}`);
  }
  ok(`book re-marked ${quotedMarks} → ${chainMarks}, and pricing.ts predicted it exactly`);

  // --- what a position would really close for ------------------------------
  //
  // The bug this migration fixes: the app valued open positions at the *resting*
  // bid while cashing out paid the bid the position's own size could actually
  // reach. The screen was therefore always at least as generous as the wallet,
  // and the gap grew with size. These two numbers must differ, and the
  // size-aware one must be the smaller — if they ever agree for a large
  // position, the size-awareness has been lost again.
  const fresh = await readBoard(BigInt(cfg.roundCount.toString()), coins.length);
  const restingBid = quoteFor(fresh[0], 0)!.bid;
  const realBidSmall = closeFor(fresh[0], 0, STAKE)!;
  const realBidLarge = closeFor(fresh[0], 0, 40_000n)!;
  if (!(realBidLarge < restingBid)) {
    fail(
      "closing a large position must not fetch the resting bid",
      `resting ${restingBid}c, size-aware ${realBidLarge}c`
    );
  }
  ok(
    `close value is size-aware — resting bid ${restingBid}c, ` +
      `${STAKE} closes at ${realBidSmall}c, 40000 closes at ${realBidLarge}c`
  );

  // --- the cut, the reveal, the payout -------------------------------------
  console.log(`\n  waiting ${LOCK_IN}s for the lock…`);
  await new Promise((r) => setTimeout(r, (LOCK_IN + 2) * 1000));

  // SOL started 1st and finishes 2nd — it went LOWER. The bet was HIGHER, so it
  // loses; entry 1 is where the winning side would be.
  for (const [i, entry] of entries.entries()) {
    await program.methods
      .recordCut({ cutRank: i === 0 ? 2 : 1 })
      .accounts({ config, round, entry, authority: authority.publicKey })
      .rpc();
  }
  ok("record_cut — the board frozen at the cut");

  await new Promise((r) => setTimeout(r, 6000));
  try {
    await program.methods
      .revealSeed(Array.from(Buffer.alloc(32, 9)))
      .accounts({ config, round, authority: authority.publicKey })
      .rpc();
    fail("a wrong seed was accepted", "the commitment is decoration");
  } catch {
    ok("reveal_seed refuses a seed that is not the one committed");
  }

  await program.methods
    .revealSeed(Array.from(seed))
    .accounts({ config, round, authority: authority.publicKey })
    .rpc();
  const settledRound = await (program.account as any).round.fetch(round);
  const cutAt = Number(settledRound.cutAt);
  const lockAt = Number(settledRound.lockAt);
  if (!(cutAt >= lockAt && cutAt < lockAt + settledRound.cutWindowSeconds)) {
    fail("the cut landed outside its committed window", `${cutAt} vs [${lockAt}, +${settledRound.cutWindowSeconds})`);
  }
  ok(`reveal_seed — cut derived at +${cutAt - lockAt}s inside the committed ${settledRound.cutWindowSeconds}s window`);

  // --- settlement, by a stranger -------------------------------------------
  const stranger = Keypair.generate();
  await fund(stranger, 2);
  const relayerLamportsBefore = await conn.getBalance(relayer.publicKey);
  const betKey = betPda(round, player.publicKey, 0, 0);

  await crownProgram(stranger, conn)
    .methods.settleBet()
    .accounts({
      config,
      round,
      entry: entries[0],
      bet: betKey,
      ownerTokens: playerAta,
      vault,
      rentReceiver: relayer.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  const closed = await conn.getAccountInfo(betKey);
  if (closed !== null) fail("the settled lot kept its rent", "account still exists");
  const relayerLamportsAfter = await conn.getBalance(relayer.publicKey);
  const reclaimed = relayerLamportsAfter - relayerLamportsBefore;
  ok(`settle_bet — by a stranger; lot closed and ${reclaimed} lamports of rent returned to the relayer`);

  const finalPlayer = await getAccount(conn, playerAta);
  if (finalPlayer.amount !== BigInt(ALLOWANCE) - STAKE) {
    fail("a losing bet paid out", `${finalPlayer.amount}`);
  }
  ok(`a losing lot paid nothing — player holds ${finalPlayer.amount}, stake stayed in the vault`);

  console.log("\n✅ the whole round works against a real validator\n");
}

main().catch((e) => {
  console.error("\n✗ smoke failed:", e?.message ?? e);
  if (e?.logs) console.error(e.logs.join("\n"));
  process.exit(1);
});
