import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parse, validate, specifiedRules, GraphQLSchema } from "graphql";
import { costLimit, depthLimit, MAX_COST, MAX_DEPTH } from "./limits";
import { schema } from "./index";

/**
 * The budget rules are the only thing standing between one HTTP request and
 * arbitrarily much work, so what matters is that they reject the shapes an
 * attacker would actually send while leaving the shapes the client sends alone.
 */
const errorsFor = (source: string, rules = [depthLimit(), costLimit()]) =>
  validate(schema as GraphQLSchema, parse(source), [...specifiedRules, ...rules]).map(
    (e) => e.message
  );

describe("query budgets", () => {
  it("lets the real client queries through", () => {
    const queries = [
      `{ me { id handle credits } }`,
      `{ cryptoRound { id status commitHash entries { symbol ticker lines { direction cents } } } }`,
      `{ cryptoStandings(limit: 10) { symbol rank quoteVolume } }`,
      `{ myCryptoBets { id symbol stake odds status liveRank liveValue } }`,
      `{ roundReplay(roundId: "abc") { t symbol rank quoteVolume } }`,
    ];
    for (const q of queries) assert.deepEqual(errorsFor(q), [], q);
  });

  it("refuses a document nested past the limit", () => {
    // Fragments on Round -> entries -> lines can't reach it, so build the depth
    // out of a field that nests into itself via aliases on a deep selection.
    const deep = (n: number): string =>
      n === 0 ? "id" : `entries { lines { direction } ${deep(n - 1)} }`;
    const errors = errorsFor(`{ cryptoRound { ${deep(MAX_DEPTH)} } }`);
    assert.ok(
      errors.some((m) => m.includes("too deeply nested")),
      `expected a depth error, got ${JSON.stringify(errors)}`
    );
  });

  it("counts aliases separately, so the same field repeated is not free", () => {
    // The shape that beats a naive rate limiter: one request, one call, five
    // hundred range scans over the samples table.
    const aliases = Array.from(
      { length: 500 },
      (_, i) => `a${i}: roundReplay(roundId: "r") { t symbol rank quoteVolume }`
    ).join("\n");
    const errors = errorsFor(`{ ${aliases} }`);
    assert.ok(
      errors.some((m) => m.includes("too expensive")),
      `expected a cost error, got ${JSON.stringify(errors)}`
    );
  });

  it("multiplies a nested selection by the list size asked for", () => {
    const cheap = errorsFor(`{ cryptoStandings(limit: 2) { symbol ticker name rank } }`);
    assert.deepEqual(cheap, []);

    // Same shape, a limit no client would send.
    const expensive = errorsFor(
      `{ cryptoStandings(limit: 200) { ${Array.from({ length: 40 }, (_, i) => `f${i}: symbol`).join(" ")} } }`
    );
    assert.ok(
      expensive.some((m) => m.includes("too expensive")),
      `expected a cost error, got ${JSON.stringify(expensive)}`
    );
  });

  it("does not let a fragment hide depth", () => {
    const viaFragment = `
      { cryptoRound { ...A } }
      fragment A on Round { entries { ...B } }
      fragment B on RoundEntry { lines { direction cents } }`;
    // Legal and shallow enough — but it must be *measured* as three deep, not one.
    assert.deepEqual(errorsFor(viaFragment, [depthLimit(2), costLimit()]).length > 0, true);
    assert.deepEqual(errorsFor(viaFragment, [depthLimit(4), costLimit()]), []);
  });

  it("reports the limits it was built with", () => {
    assert.ok(MAX_DEPTH > 3, "the schema's own depth must fit under the limit");
    assert.ok(MAX_COST >= 1000);
  });
});
