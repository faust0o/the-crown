import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";

import {
  BET_ACCOUNT_SIZE,
  BET_ROUND_OFFSET,
  BET_STATUS_OFFSET,
  OPEN,
} from "./arrears";
import { decodeEntry } from "./book";
import { ROUND_COUNT_OFFSET, ROUND_STATUS, decodeRound } from "./rounds";

/**
 * The hand-rolled account decoders, held against the IDL.
 *
 * Four places in this directory read program accounts as raw bytes at literal
 * offsets — `decodeEntry`, `decodeRound`, `recentRounds`' read of `round_count`,
 * and the `memcmp` filter `roundsInArrears` scans open positions with. Every one
 * of them is a transcription of a `#[account]` struct in `state.rs`, and none of
 * them can be checked by the compiler: a field added to the middle of `Bet`
 * moves eight offsets at once and every line still typechecks.
 *
 * The failure that follows is silent and expensive rather than loud. A shifted
 * `memcmp` matches nothing, so `roundsInArrears` reports a cluster that owes
 * nobody — the exact call whose reason for existing is that 173 positions were
 * already stranded behind rounds the settlement window had moved past. A shifted
 * `decodeEntry` reads a cut rank out of a stake and hands it to `record_cut`,
 * which cannot be re-recorded.
 *
 * So the layout is derived here from `idl/crown.json`, which Anchor generates
 * from the program, and the decoders are run against buffers built from it. When
 * the Rust moves, the IDL moves with it and this fails — which is the only
 * moment any of it can be caught before it reaches a cluster.
 */

type IdlType =
  | string
  | { array: [IdlType, number] }
  | { defined: { name: string } }
  | { option: IdlType }
  | { vec: IdlType };

interface IdlTypeDef {
  name: string;
  type:
    | { kind: "struct"; fields: { name: string; type: IdlType }[] }
    | { kind: "enum"; variants: { name: string; fields?: unknown[] }[] };
}

const idl: { types: IdlTypeDef[] } = JSON.parse(
  readFileSync(fileURLToPath(new URL("./idl/crown.json", import.meta.url)), "utf8")
);

const defOf = (name: string): IdlTypeDef => {
  const found = idl.types.find((t) => t.name === name);
  assert.ok(found, `the IDL has no type named ${name} — has the program been renamed?`);
  return found;
};

const PRIMITIVES: Record<string, number> = {
  bool: 1, u8: 1, i8: 1,
  u16: 2, i16: 2,
  u32: 4, i32: 4,
  u64: 8, i64: 8,
  u128: 16, i128: 16,
  pubkey: 32,
};

/** Anchor's discriminator, on the front of every `#[account]`. */
const DISCRIMINATOR = 8;

function sizeOf(t: IdlType): number {
  if (typeof t === "string") {
    const n = PRIMITIVES[t];
    assert.ok(n, `no size known for IDL primitive ${t}`);
    return n;
  }
  if ("array" in t) return sizeOf(t.array[0]) * t.array[1];
  if ("defined" in t) {
    const def = defOf(t.defined.name);
    assert.equal(def.type.kind, "enum", `${t.defined.name} is not a fieldless enum`);
    if (def.type.kind !== "enum") throw new Error("unreachable");
    // Only C-like enums appear in these accounts, and Anchor writes them as the
    // variant index in one byte. A variant that gained a payload would change
    // that, so it is asserted rather than assumed.
    for (const v of def.type.variants) {
      assert.ok(!v.fields?.length, `${t.defined.name}::${v.name} carries data — the size is no longer 1`);
    }
    return 1;
  }
  throw new Error(`unsupported IDL type: ${JSON.stringify(t)}`);
}

/** Byte offset of every field of an account, discriminator included. */
function layoutOf(name: string): { offsets: Record<string, number>; size: number } {
  const def = defOf(name);
  assert.equal(def.type.kind, "struct", `${name} is not a struct`);
  if (def.type.kind !== "struct") throw new Error("unreachable");

  const offsets: Record<string, number> = {};
  let at = DISCRIMINATOR;
  for (const f of def.type.fields) {
    offsets[f.name] = at;
    at += sizeOf(f.type);
  }
  return { offsets, size: at };
}

describe("the on-chain layout the decoders assume", () => {
  it("puts Bet's round and status where the arrears scan looks for them", () => {
    // `roundsInArrears` finds unpaid positions with a `memcmp` on `status` and a
    // `dataSlice` on `round`. Both are byte offsets into an account this code
    // never parses, so nothing else in the process would notice them drifting —
    // the scan would simply come back empty, which reads as "nobody is owed".
    const bet = layoutOf("Bet");
    assert.equal(BET_ROUND_OFFSET, bet.offsets.round);
    assert.equal(BET_STATUS_OFFSET, bet.offsets.status);
    assert.equal(BET_ACCOUNT_SIZE, bet.size);
  });

  it("spells BetStatus::Open as the byte the filter matches on", () => {
    const status = defOf("BetStatus");
    assert.equal(status.type.kind, "enum");
    if (status.type.kind !== "enum") throw new Error("unreachable");
    assert.equal(
      status.type.variants[0].name,
      "Open",
      "Open is no longer the first variant, so the filter now matches some other status"
    );
    assert.deepEqual([...bs58.decode(OPEN)], [0], "the filter's base58 is not a single zero byte");
  });

  it("reads round_count from where Config keeps it", () => {
    assert.equal(ROUND_COUNT_OFFSET, layoutOf("Config").offsets.round_count);
  });

  it("names every RoundStatus the program can write", () => {
    // The regression. `void_round` shipped and this list did not grow with it,
    // so `decodeRound` fell through to its `?? "Open"` default and a round that
    // had been given up on came back claiming to be live — see the note on
    // `ROUND_STATUS`. A missing name is invisible at the call site precisely
    // because the fallback is there, so the list is checked against the source.
    const def = defOf("RoundStatus");
    assert.equal(def.type.kind, "enum");
    if (def.type.kind !== "enum") throw new Error("unreachable");
    assert.deepEqual(def.type.variants.map((v) => v.name), [...ROUND_STATUS]);
  });
});

/**
 * Write one account's bytes the way the program would.
 *
 * Driven off the IDL rather than off a second copy of the offsets, so the test
 * cannot drift into agreeing with a decoder that is wrong.
 */
function encode(name: string, values: Record<string, unknown>): Buffer {
  const def = defOf(name);
  if (def.type.kind !== "struct") throw new Error(`${name} is not a struct`);

  const { size } = layoutOf(name);
  const buf = Buffer.alloc(size);
  // A plausible discriminator; nothing under test reads it, but a zeroed head
  // would hide a decoder that forgot to skip it.
  buf.fill(0xab, 0, DISCRIMINATOR);

  let at = DISCRIMINATOR;
  const put = (t: IdlType, v: unknown): void => {
    if (typeof t === "string") {
      switch (t) {
        case "bool": buf.writeUInt8(v ? 1 : 0, at); break;
        case "u8": buf.writeUInt8(Number(v), at); break;
        case "u16": buf.writeUInt16LE(Number(v), at); break;
        case "u32": buf.writeUInt32LE(Number(v), at); break;
        case "u64": buf.writeBigUInt64LE(BigInt(v as number | bigint), at); break;
        case "i64": buf.writeBigInt64LE(BigInt(v as number | bigint), at); break;
        case "pubkey": (v as PublicKey).toBuffer().copy(buf, at); break;
        default: throw new Error(`encoder has no case for ${t}`);
      }
      at += sizeOf(t);
      return;
    }
    if ("array" in t) {
      const [inner, n] = t.array;
      // A fixed-width string is a byte array the program zero-pads.
      if (inner === "u8" && typeof v === "string") {
        buf.write(v, at, "utf8");
        at += n;
        return;
      }
      const items = v as unknown[];
      assert.equal(items.length, n, `array field wants ${n} items`);
      for (const item of items) put(inner, item);
      return;
    }
    if ("defined" in t) {
      // C-like enums are their variant's index, which is what `sizeOf` asserted.
      buf.writeUInt8(Number(v), at);
      at += 1;
      return;
    }
    throw new Error(`encoder has no case for ${JSON.stringify(t)}`);
  };

  for (const f of def.type.fields) {
    assert.ok(f.name in values, `encode(${name}) is missing a value for ${f.name}`);
    put(f.type, values[f.name]);
  }
  return buf;
}

describe("decoding a RoundEntry", () => {
  const round = PublicKey.unique();
  const base = {
    round,
    index: 4,
    symbol: "cbBTC",
    ticker: "BTC",
    start_rank: 3,
    cut_rank: 7,
    opening: [11n, 22n, 33n],
    flow: [100n, 200n, 300n],
    quoted: [true, false, true],
    target: 86,
    last_cents: [41, 0, 45],
    bump: 254,
  };

  it("reads every field back off the wire", () => {
    const entry = decodeEntry(encode("RoundEntry", base));

    assert.equal(entry.index, 4);
    assert.equal(entry.symbol, "cbBTC");
    assert.equal(entry.ticker, "BTC");
    assert.equal(entry.startRank, 3);
    assert.equal(entry.cutRank, 7);
    assert.deepEqual(entry.book.quoted, [true, false, true]);
    assert.equal(entry.book.target, 86);
    assert.deepEqual(entry.lastCents, [41, 0, 45]);
  });

  it("stakes each leg at its opening plus its flow", () => {
    // What the book prices off. Reading the two arrays in the wrong order, or
    // one field out, would still produce three plausible numbers.
    const entry = decodeEntry(encode("RoundEntry", base));
    assert.deepEqual(entry.book.staked, [111n, 222n, 333n]);
  });

  it("reports an unrecorded cut as null rather than as rank zero", () => {
    // 0 is how the program spells "no cut yet". Ranks are 1-based, so it is
    // unambiguous on the wire — but a 0 reaching a caller as a *rank* is a coin
    // that finished better than first, and `crypto-views` sorts on it.
    const entry = decodeEntry(encode("RoundEntry", { ...base, cut_rank: 0 }));
    assert.equal(entry.cutRank, null);
  });

  it("trims the padding off a symbol that does not fill its field", () => {
    // `symbol` is `[u8; 16]`, so a short one arrives with thirteen zero bytes
    // behind it. Untrimmed it matches nothing: the board is joined to the oracle
    // by symbol, and "SOL\0\0..." is not "SOL".
    const entry = decodeEntry(encode("RoundEntry", { ...base, symbol: "SOL", ticker: "SOL" }));
    assert.equal(entry.symbol, "SOL");
    assert.equal(entry.ticker, "SOL");
  });

  it("carries a full-width symbol without dropping its last byte", () => {
    const full = "X".repeat(16);
    const entry = decodeEntry(encode("RoundEntry", { ...base, symbol: full }));
    assert.equal(entry.symbol, full);
  });

  it("reads a flow far past what a double holds exactly", () => {
    // Credits are u64 on chain and the book's arithmetic is bigint for the
    // reason `pricing.ts` gives at length. A decoder that went through Number
    // here would round, and the fill it quotes would stop matching the one the
    // program charges.
    const huge = 2n ** 63n + 12345n;
    const entry = decodeEntry(encode("RoundEntry", { ...base, opening: [0n, 0n, 0n], flow: [huge, 0n, 0n] }));
    assert.equal(entry.book.staked[0], huge);
  });
});

describe("decoding a Round", () => {
  const address = PublicKey.unique();
  const startsAt = 1_760_000_000;
  const base = {
    index: 412n,
    starts_at: startsAt,
    lock_at: startsAt + 600,
    ends_at: startsAt + 900,
    commit_hash: Array.from({ length: 32 }, (_, i) => i),
    seed: Array.from({ length: 32 }, () => 0),
    cut_at: startsAt + 700,
    cut_window_seconds: 300,
    crown_symbol: "cbBTC",
    status: 0,
    entry_count: 9,
    bump: 255,
  };

  it("reads every field back off the wire", () => {
    const round = decodeRound(address, encode("Round", base));

    assert.equal(round.index, 412n);
    assert.equal(round.address, address);
    assert.equal(round.startsAt.getTime(), startsAt * 1000);
    assert.equal(round.lockAt.getTime(), (startsAt + 600) * 1000);
    assert.equal(round.endsAt.getTime(), (startsAt + 900) * 1000);
    assert.equal(round.entryCount, 9);
    assert.equal(round.crownSymbol, "cbBTC");
    assert.equal(
      round.commitHash,
      Buffer.from(base.commit_hash).toString("hex"),
      "the commitment is what a reveal is checked against — it has to survive the trip byte for byte"
    );
  });

  it("skips the seed and the cut window to reach the crown", () => {
    // Two fields nothing here reads sit between the commitment and the crown, so
    // they are skipped by width rather than by name. A seed that is no longer 32
    // bytes, or a cut window that is no longer a u32, would leave every field
    // after it misread — and the first symptom would be a crown symbol of
    // garbage, which reads like an oracle fault.
    const seeded = { ...base, seed: Array.from({ length: 32 }, (_, i) => 255 - i) };
    assert.equal(decodeRound(address, encode("Round", seeded)).crownSymbol, "cbBTC");
  });

  it("reports a round with no crown as null rather than as an empty name", () => {
    const round = decodeRound(address, encode("Round", { ...base, crown_symbol: "" }));
    assert.equal(round.crownSymbol, null);
  });

  it("names each status by its own discriminant", () => {
    ROUND_STATUS.forEach((name, discriminant) => {
      const round = decodeRound(address, encode("Round", { ...base, status: discriminant }));
      assert.equal(round.status, name, `status byte ${discriminant} should read as ${name}`);
    });
  });

  it("does not read a voided round as an open one", () => {
    // The regression, at the level it actually bit. `void_round` sets `Voided`,
    // this list stopped at `Settled`, and the `?? "Open"` fallback turned a round
    // that had been given up on into a live one: the runner re-cut it every tick
    // against a program that refuses to cut it, and — because the settlement
    // sweep only ever looked at rounds it considered finished — never swept the
    // refunds that voiding the round had just made payable.
    const voided = decodeRound(address, encode("Round", { ...base, status: 3 }));
    assert.equal(voided.status, "Voided");
    assert.notEqual(voided.status, "Open");
  });
});
