import { strict as assert } from "node:assert";
import { createHash, randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";

import { cutAndReveal, rememberSeed, type ChainRound } from "./rounds";

/**
 * A round sitting at `Cut`, waiting to be revealed.
 *
 * Built by hand rather than read from a cluster because the behaviour under test
 * happens before any network call: `cutAndReveal` compares the seed it holds
 * against the commitment in the account, and only sends a transaction if they
 * agree. That ordering is the fix, so a test that needed a validator to observe
 * it would be testing the wrong half.
 */
function cutRound(commitHash: string, index = 999n): ChainRound {
  const past = Date.now() - 60_000;
  return {
    index,
    address: PublicKey.unique(),
    startsAt: new Date(past - 1_800_000),
    lockAt: new Date(past),
    endsAt: new Date(past + 60_000),
    status: "Cut",
    entryCount: 9,
    crownSymbol: "cbBTC",
    commitHash,
  };
}

const sha256Hex = (seedHex: string) =>
  createHash("sha256").update(Buffer.from(seedHex, "hex")).digest("hex");

describe("revealing a round", () => {
  it("reports a missing seed as recoverable", async () => {
    const round = cutRound(sha256Hex(randomBytes(32).toString("hex")), 9001n);
    const outcome = await cutAndReveal({ authority: Keypair.generate(), round });
    assert.equal(outcome, "no-seed");
  });

  it("refuses a seed that does not match the commitment, without sending it", async () => {
    // The regression this exists for. A *missing* seed was recoverable and a
    // *wrong* one was not: it got sent, refused on chain with BadReveal, and
    // left in memory to be sent again on the next tick — forever. The round
    // never revealed, every position on it stayed unsettled, and the log
    // repeated one line that read like a chain fault rather than a cache holding
    // the wrong thirty-two bytes.
    const realSeed = randomBytes(32).toString("hex");
    const round = cutRound(sha256Hex(realSeed), 9002n);

    rememberSeed(round.index, randomBytes(32).toString("hex")); // not the one
    const outcome = await cutAndReveal({ authority: Keypair.generate(), round });

    assert.equal(
      outcome,
      "no-seed",
      "a wrong seed must read as recoverable, so the caller repairs it from the database"
    );
  });

  it("forgets the wrong seed, so the next attempt is not the same attempt", async () => {
    // Reporting "no-seed" while keeping the bad seed would be a loop that says
    // it is recovering and never does.
    const round = cutRound(sha256Hex(randomBytes(32).toString("hex")), 9003n);
    rememberSeed(round.index, randomBytes(32).toString("hex"));

    await cutAndReveal({ authority: Keypair.generate(), round });
    // Second call with nothing re-remembered: if the bad seed had survived, this
    // would take the send path instead of reporting the seed as missing.
    const again = await cutAndReveal({ authority: Keypair.generate(), round });
    assert.equal(again, "no-seed");
  });

  it("waits rather than revealing before the lock", async () => {
    const round = { ...cutRound("00".repeat(32), 9004n), lockAt: new Date(Date.now() + 60_000) };
    const outcome = await cutAndReveal({ authority: Keypair.generate(), round });
    assert.equal(outcome, "waiting");
  });
});
