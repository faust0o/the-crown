// Display-only number formatting for the Casino. Internal math always uses raw
// values. Rules (from the number-formatting spec): never scientific notation,
// never "-0.00", null/NaN/Infinity render as "--". Apply `font-mono tabular-nums`
// at the component layer so live-updating values don't jitter.

const INVALID = "--";

function isBad(n: number | null | undefined): n is null | undefined {
  return n == null || !Number.isFinite(n);
}

function stripZeros(s: string): string {
  if (!s.includes(".")) return s;
  return s.replace(/\.?0+$/, "");
}

const UNITS: readonly [number, string][] = [
  [1e12, "T"],
  [1e9, "B"],
  [1e6, "M"],
  [1e3, "K"],
];

/** Compact magnitude: 27_460_609 -> "27.5M", 1_234 -> "1.23K", 42 -> "42". */
export function formatCompact(
  n: number | null | undefined,
  decimals = 2
): string {
  if (isBad(n)) return INVALID;
  const v = n as number;
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  for (const [threshold, suffix] of UNITS) {
    if (abs >= threshold) {
      const scaled = abs / threshold;
      const str = scaled.toFixed(scaled >= 100 ? 0 : decimals);
      return sign + stripZeros(str) + suffix;
    }
  }
  return sign + stripZeros(abs.toFixed(abs < 1 && abs > 0 ? 2 : 0));
}

/**
 * A balance, in dollars: 1000 -> "$1,000".
 *
 * A credit **is** a dollar — one unit, one dollar, everywhere in the game — so
 * this writes down what the number already meant rather than converting it.
 * There is no rate here and there must never be one.
 *
 * The rename stops at the display layer on purpose. The server, the SPL mint and
 * the program all still say "credits", and the unit is integral by construction:
 * `place_bet` refuses a fractional stake, and the arithmetic in `pricing.rs` is
 * exact only because it never has to represent half of one. Calling it dollars
 * on the wire would invite somebody to add a decimal to it.
 */
export function formatCredits(n: number | null | undefined): string {
  if (isBad(n)) return INVALID;
  const v = Math.round(n as number);
  return `${v < 0 ? "-" : ""}$${Math.abs(v).toLocaleString("en-US")}`;
}

/**
 * A SOL balance: 1.5 -> "1.5", 0.00212 -> "0.0021", 0 -> "0".
 *
 * Four places because that is roughly where a Solana fee stops being visible —
 * below it the number a player reads would never change after paying one.
 */
export function formatSol(n: number | null | undefined): string {
  if (isBad(n)) return INVALID;
  return stripZeros((n as number).toFixed(4));
}
