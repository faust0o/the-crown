import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { hashToken, newHandle, newToken, sessionExpiry, SESSION_TTL_DAYS } from "./auth";

describe("session tokens", () => {
  it("mints tokens with enough entropy to be unguessable", () => {
    const token = newToken();
    assert.match(token, /^[0-9a-f]{48}$/, "24 random bytes, hex");

    // Not proof of randomness, but it does catch the classic disaster of a
    // "random" token that is actually a counter or a timestamp.
    const many = new Set(Array.from({ length: 1000 }, () => newToken()));
    assert.equal(many.size, 1000, "no repeats in a thousand draws");
  });

  it("stores a digest, and the digest is not the token", () => {
    const token = newToken();
    const digest = hashToken(token);
    assert.match(digest, /^[0-9a-f]{64}$/);
    assert.notEqual(digest, token, "the whole point is that the row is not the credential");
  });

  it("hashes deterministically, so a returning client still matches", () => {
    const token = newToken();
    assert.equal(hashToken(token), hashToken(token));
    assert.notEqual(hashToken(token), hashToken(newToken()));
  });

  it("expires sessions a fixed distance out", () => {
    const ms = sessionExpiry().getTime() - Date.now();
    const expected = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;
    assert.ok(Math.abs(ms - expected) < 1000, `expiry is ${SESSION_TTL_DAYS} days out`);
  });

  it("makes handles that reveal nothing about the account", () => {
    const handle = newHandle();
    assert.match(handle, /^[a-z]+-[a-z]+-\d{3}$/);
  });
});
