import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
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

  /**
   * The same claim, made against the documents that actually ship.
   *
   * The list above is hand-copied, and hand-copied is how it drifted: the
   * results panel asked for twelve rounds of the full round shape — every
   * entry's book included — which priced out at 44,621 against a budget of
   * 5,000. The server rejected it during validation, so no resolver ever ran,
   * Apollo handed the panel no data, and it reported "no rounds have settled
   * yet" no matter what the database held. A budget that silently turns a
   * feature off is worse than no budget, and nothing here noticed for the same
   * reason the outage was invisible: the test was reading a copy.
   *
   * Skipped rather than failed when the client tree isn't there, since the
   * server is deployable on its own.
   */
  it("lets the documents the client actually ships through", (t) => {
    const file = new URL("../../../src/casino/crypto/graphql.ts", import.meta.url);
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      return t.skip("no client tree beside this server");
    }

    // The client assembles a few documents from shared field fragments; inline
    // them the way the template literal does, or this prices a hole.
    const chunk = (name: string) =>
      (source.match(new RegExp(`const ${name} = \`([\\s\\S]*?)\``)) ?? [])[1] ?? "";
    // Every one by name, so a fragment added later is priced without being
    // listed here first.
    const inline = (doc: string) => doc.replace(/\$\{(\w+)\}/g, (_, name: string) => chunk(name));

    const documents = [...source.matchAll(/gql`([\s\S]*?)`/g)].map((m) => inline(m[1]));
    assert.ok(documents.length >= 5, `expected to find the client's documents, got ${documents.length}`);

    for (const doc of documents) {
      const name = (doc.match(/(?:query|mutation)\s+(\w+)/) ?? [])[1] ?? "(anonymous)";
      assert.deepEqual(errorsFor(doc), [], `${name} must fit the budget`);
    }
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
