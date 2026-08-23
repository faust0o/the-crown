import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { describeChainError } from "./send";

/**
 * Reading the cluster's refusal.
 *
 * The cluster spells a custom program error two ways and this has to handle
 * both, in the right base. It once inferred the base from the string's shape
 * instead of from which pattern matched — which is guessing at something already
 * known, and it was wrong in two directions: a hex code read as decimal named a
 * different error, and a hex code containing letters produced NaN.
 */
describe("describing a chain error", () => {
  it("reads the decimal form out of an InstructionError", () => {
    const err = describeChainError('{"InstructionError":[0,{"Custom":6005}]}', null, null);
    assert.equal(err.code, 6005);
    assert.match(err.message, /BadReveal/);
  });

  it("reads the hexadecimal form as hexadecimal", () => {
    // 0x1775 is 6005. Parsed as decimal it is 1775, which is either a different
    // error or none — and either way the log names the wrong thing.
    const err = describeChainError("Error: custom program error: 0x1775", null, null);
    assert.equal(err.code, 6005, "0x1775 must be 6005, not 1775");
    assert.match(err.message, /BadReveal/);
  });

  it("never reports NaN for a hex code containing letters", () => {
    // The exact shape that reached the log as "refused it with code NaN".
    const err = describeChainError("custom program error: 0xabc", null, null);
    assert.equal(Number.isNaN(err.code), false, `code was ${err.code}`);
    assert.equal(err.code, 0xabc);
    assert.doesNotMatch(err.message, /NaN/);
  });

  it("names an unknown code in both bases", () => {
    const err = describeChainError('{"Custom":9999}', null, null);
    assert.match(err.message, /9999/);
    assert.match(err.message, /0x270f/);
  });

  it("passes a non-program error through unchanged", () => {
    const err = describeChainError(new Error("429 Too Many Requests"), null, null);
    assert.equal(err.code, null);
    assert.match(err.message, /429/);
  });

  it("keeps the signature and logs for whoever has to reconcile it", () => {
    const err = describeChainError('{"Custom":6002}', "5abc", ["Program log: refused"]);
    assert.equal(err.signature, "5abc");
    assert.deepEqual(err.logs, ["Program log: refused"]);
    assert.match(err.message, /Unavailable/);
  });
});
