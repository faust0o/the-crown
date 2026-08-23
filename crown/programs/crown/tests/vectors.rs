//! Emit pricing vectors for the TypeScript port to check itself against.
//!
//! `server/src/chain/pricing.ts` has to agree with `pricing.rs` *exactly*, not
//! approximately: the board quotes off the TypeScript and `place_bet` charges off
//! the Rust, so a one-cent disagreement is a bet filling at a price the player
//! was never shown. Two independent implementations of the same fixed-point
//! arithmetic will not stay in step on inspection alone, so the Rust writes down
//! what it computes and the TypeScript test asserts it reproduces it.
//!
//! Regenerate with:
//!
//! ```sh
//! cargo test -p crown --test vectors -- --ignored
//! ```
//!
//! Ignored by default because it writes into the server package, which a plain
//! `cargo test` should not do.

use std::fs;
use std::path::PathBuf;

use crown::pricing::{close_cents, fill_cents, ln_q64, remark, Book};

fn book(staked: [u64; 3], quoted: [bool; 3], target: u16) -> Book {
    Book {
        staked,
        quoted,
        target,
    }
}

#[test]
#[ignore = "writes into server/src/chain; run explicitly to regenerate"]
fn emit_vectors() {
    let mut out = String::from("{\n");

    // ln, across the range `average_mark` asks for and well past it.
    out.push_str("  \"ln\": [\n");
    let ln_inputs: Vec<u128> = vec![
        1u128 << 64,
        (1u128 << 64) + 1,
        (1u128 << 64) + (1 << 40),
        3u128 << 63,  // 1.5
        1u128 << 65,  // 2
        3u128 << 64,  // 3
        10u128 << 64, // 10
        1000u128 << 64,
        1_000_000u128 << 64,
    ];
    for (i, x) in ln_inputs.iter().enumerate() {
        out.push_str(&format!(
            "    {{ \"x\": \"{}\", \"ln\": \"{}\" }}{}\n",
            x,
            ln_q64(*x),
            if i + 1 == ln_inputs.len() { "" } else { "," }
        ));
    }
    out.push_str("  ],\n");

    // The book cases: flat, lopsided, tiny, enormous, and the crown shape where
    // one leg is real but has no line.
    let books: Vec<([u64; 3], [bool; 3], u16)> = vec![
        ([100_000, 100_000, 100_000], [true, true, true], 100),
        ([1, 1, 1], [true, true, true], 100),
        ([1, 1, 100_000_000], [true, true, true], 100),
        ([123_456, 7, 999_999], [true, true, true], 100),
        ([50_000, 50_000, 0], [true, true, false], 70),
        ([300_000, 1, 1], [true, true, true], 100),
        ([1_000_000_000, 500_000_000, 250_000_000], [true, true, true], 100),
    ];
    let stakes: [u64; 7] = [1, 7, 1_000, 25_000, 100_000, 1_000_000, 100_000_000];

    out.push_str("  \"books\": [\n");
    for (bi, (staked, quoted, target)) in books.iter().enumerate() {
        let b = book(*staked, *quoted, *target);
        let marks = remark(&b);
        out.push_str("    {\n");
        out.push_str(&format!(
            "      \"staked\": [\"{}\", \"{}\", \"{}\"],\n",
            staked[0], staked[1], staked[2]
        ));
        out.push_str(&format!(
            "      \"quoted\": [{}, {}, {}],\n",
            quoted[0], quoted[1], quoted[2]
        ));
        out.push_str(&format!("      \"target\": {target},\n"));
        out.push_str(&format!(
            "      \"marks\": [{}, {}, {}],\n",
            marks[0], marks[1], marks[2]
        ));
        out.push_str("      \"quotes\": [\n");
        let mut rows: Vec<String> = Vec::new();
        for d in 0..3usize {
            for s in stakes {
                let fill = fill_cents(&b, d, s);
                let close = close_cents(&b, d, s);
                rows.push(format!(
                    "        {{ \"direction\": {d}, \"stake\": \"{s}\", \"fill\": {}, \"close\": {} }}",
                    fill.map(|v| v.to_string()).unwrap_or("null".into()),
                    close.map(|v| v.to_string()).unwrap_or("null".into())
                ));
            }
        }
        out.push_str(&rows.join(",\n"));
        out.push_str("\n      ]\n");
        out.push_str(if bi + 1 == books.len() {
            "    }\n"
        } else {
            "    },\n"
        });
    }
    out.push_str("  ]\n}\n");

    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../server/src/chain/pricing.vectors.json");
    fs::write(&path, out).expect("failed to write vectors");
    println!("wrote {}", path.display());
}
