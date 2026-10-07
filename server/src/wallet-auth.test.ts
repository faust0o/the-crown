import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import {
  challengeMessage,
  issueChallenge,
  normaliseAddress,
  resetChallenges,
  verifyChallenge,
} from "./wallet-auth";

const sign = (secretKey: Uint8Array, message: string) =>
  Buffer.from(nacl.sign.detached(new Uint8Array(Buffer.from(message, "utf8")), secretKey)).toString(
    "base64"
  );

describe("wallet sign-in", () => {
  beforeEach(() => resetChallenges());

  it("accepts a signature by the wallet the challenge was issued to", () => {
    const kp = Keypair.generate();
    const address = kp.publicKey.toBase58();
    const { nonce, message } = issueChallenge(address);

    assert.equal(message, challengeMessage(address, nonce));
    verifyChallenge(address, nonce, sign(kp.secretKey, message));
  });

  it("refuses a signature by a different wallet", () => {
    const mine = Keypair.generate();
    const theirs = Keypair.generate();
    const address = mine.publicKey.toBase58();
    const { nonce, message } = issueChallenge(address);

    // The whole point: a caller can name any address they like, and only the
    // key behind it can produce the signature that goes with it.
    assert.throws(
      () => verifyChallenge(address, nonce, sign(theirs.secretKey, message)),
      /does not match/
    );
  });

  it("spends a nonce even when the signature fails", () => {
    const kp = Keypair.generate();
    const address = kp.publicKey.toBase58();
    const { nonce, message } = issueChallenge(address);

    // One bad attempt burns the challenge. Otherwise a single nonce is an
    // unlimited number of guesses against it.
    assert.throws(() => verifyChallenge(address, nonce, sign(Keypair.generate().secretKey, message)));
    assert.throws(() => verifyChallenge(address, nonce, sign(kp.secretKey, message)), /expired/);
  });

  it("does not let a nonce be replayed after a successful sign-in", () => {
    const kp = Keypair.generate();
    const address = kp.publicKey.toBase58();
    const { nonce, message } = issueChallenge(address);
    const signature = sign(kp.secretKey, message);

    verifyChallenge(address, nonce, signature);
    assert.throws(() => verifyChallenge(address, nonce, signature), /expired/);
  });

  it("refuses a nonce that has aged out", () => {
    const kp = Keypair.generate();
    const address = kp.publicKey.toBase58();
    const { nonce, message } = issueChallenge(address, 0);
    assert.throws(
      () => verifyChallenge(address, nonce, sign(kp.secretKey, message), 10 * 60_000),
      /expired/
    );
  });

  it("refuses a nonce issued to another wallet", () => {
    const kp = Keypair.generate();
    const other = Keypair.generate().publicKey.toBase58();
    const { nonce } = issueChallenge(kp.publicKey.toBase58());
    // Signed correctly, for the message *this* wallet would have been given —
    // but the nonce belongs to somebody else's challenge.
    const signature = sign(kp.secretKey, challengeMessage(other, nonce));
    assert.throws(() => verifyChallenge(other, nonce, signature), /different wallet/);
  });

  it("refuses signatures that are not 64 bytes", () => {
    const kp = Keypair.generate();
    const address = kp.publicKey.toBase58();
    const { nonce } = issueChallenge(address);
    assert.throws(() => verifyChallenge(address, nonce, "not-base64-at-all"), /could not be read/);
  });

  it("refuses anything that is not an address", () => {
    assert.throws(() => normaliseAddress("nope"), /not a wallet address/);
    assert.throws(() => normaliseAddress("0".repeat(4096)), /not a wallet address/);
  });
});
