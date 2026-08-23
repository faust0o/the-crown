import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  closeCents,
  closeValue,
  fillCents,
  lnQ64,
  payoutFor,
  remark,
  type Book,
  type Direction,
} from "./pricing";

/**
 * The port has to be exact, not close.
 *
 * The board quotes off `pricing.ts` and `place_bet` charges off `pricing.rs`. A
 * single cent of disagreement means a bet fills at a price the player was never
 * shown — and because the desks send a `max_cents` bound with every order, it
 * would surface as random slippage rejections rather than as anything that
 * points at the cause. So the Rust writes down what it computes (see
 * `crown/programs/crown/tests/vectors.rs`) and this asserts we reproduce it
 * value for value.
 *
 * A failure here is not a tolerance to loosen. It means the two implementations
 * have drifted and one of them is now charging a price the other does not quote.
 */

interface Vectors {
  ln: { x: string; ln: string }[];
  books: {
    staked: [string, string, string];
    quoted: [boolean, boolean, boolean];
    target: number;
    marks: [number, number, number];
    quotes: {
      direction: number;
      stake: string;
      fill: number | null;
      close: number | null;
    }[];
  }[];
}

const vectors: Vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL("./pricing.vectors.json", import.meta.url)), "utf8")
);

test("ln agrees with the program bit for bit", () => {
  assert.ok(vectors.ln.length > 0, "no ln vectors — regenerate them");
  for (const { x, ln } of vectors.ln) {
    assert.equal(
      lnQ64(BigInt(x)).toString(),
      ln,
      `lnQ64(${x}) disagrees with the program`
    );
  }
});

test("every mark and every quote agrees with the program", () => {
  assert.ok(vectors.books.length > 0, "no book vectors — regenerate them");

  for (const v of vectors.books) {
    const book: Book = {
      staked: [BigInt(v.staked[0]), BigInt(v.staked[1]), BigInt(v.staked[2])],
      quoted: v.quoted,
      target: v.target,
    };

    assert.deepEqual(
      remark(book),
      v.marks,
      `marks disagree for staked=${v.staked} target=${v.target}`
    );

    for (const q of v.quotes) {
      const d = q.direction as Direction;
      assert.equal(
        fillCents(book, d, BigInt(q.stake)),
        q.fill,
        `fill disagrees for staked=${v.staked} d=${d} stake=${q.stake}`
      );
      assert.equal(
        closeCents(book, d, BigInt(q.stake)),
        q.close,
        `close disagrees for staked=${v.staked} d=${d} stake=${q.stake}`
      );
    }
  }
});

test("a round trip costs the spread and nothing else", () => {
  // The same property the Rust asserts, restated here so the TypeScript is not
  // merely echoing vectors it was handed.
  const book: Book = {
    staked: [100_000n, 100_000n, 100_000n],
    quoted: [true, true, true],
    target: 100,
  };
  const stake = 25_000n;
  const ask = fillCents(book, 0, stake)!;
  const after: Book = { ...book, staked: [book.staked[0] + stake, book.staked[1], book.staked[2]] };
  const bid = closeCents(after, 0, stake)!;
  assert.equal(ask - bid, 2 * 1, `ask ${ask} bid ${bid} should differ by the round-trip spread`);
});

test("closing is floored, so it is never a free option", () => {
  assert.ok(closeValue(47n, 94, 93) < 47n);
});

test("a payout is finite and refuses a zero price", () => {
  assert.equal(payoutFor(1_000n, 50), 2_000n);
  assert.throws(() => payoutFor(1_000n, 0));
});
