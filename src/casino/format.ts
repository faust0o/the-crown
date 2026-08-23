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

/** Full grouped value: 27460609 -> "27,460,609". */
export function formatFull(
  n: number | null | undefined,
  decimals = 0
): string {
  if (isBad(n)) return INVALID;
  return (n as number).toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** Percent. `sign: true` prefixes "+" for positives. Never emits "-0.00%". */
export function formatPercent(
  n: number | null | undefined,
  opts?: { sign?: boolean; decimals?: number }
): string {
  if (isBad(n)) return INVALID;
  const decimals = opts?.decimals ?? 2;
  let v = n as number;
  // Collapse signed zero (e.g. -0.001 rounding to 0.00).
  if (Number(v.toFixed(decimals)) === 0) v = 0;
  const prefix = v < 0 ? "-" : opts?.sign && v > 0 ? "+" : "";
  return prefix + Math.abs(v).toFixed(decimals) + "%";
}

/** Signed compact value for P&L etc: 1234 -> "+1.23K", -50 -> "-50". */
export function formatSignedCompact(
  n: number | null | undefined,
  decimals = 2
): string {
  if (isBad(n)) return INVALID;
  let v = n as number;
  if (Object.is(v, -0)) v = 0;
  const prefix = v > 0 ? "+" : "";
  return prefix + formatCompact(v, decimals);
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

/** Payout multiplier: 1.94 -> "1.94×". */
export function formatMultiplier(n: number | null | undefined): string {
  if (isBad(n)) return INVALID;
  return `${(n as number).toFixed(2)}×`;
}

/** Implied probability as cents: 0.52 -> "52¢". */
export function formatCents(prob: number | null | undefined): string {
  if (isBad(prob)) return INVALID;
  return `${Math.round((prob as number) * 100)}¢`;
}

/** Countdown from ms remaining: "1:14", or "5:12:44" once past an hour. */
export function formatCountdown(ms: number | null | undefined): string {
  if (isBad(ms)) return INVALID;
  const total = Math.max(0, Math.floor((ms as number) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** liveline value-axis formatter (1 decimal compact). */
export function livelineFormatValue(v: number): string {
  return formatCompact(v, 1);
}

/** A market round's date as D.M.YYYY (UTC), e.g. "15.6.2026". */
export function formatMarketDate(iso: string | null | undefined): string {
  if (!iso) return INVALID;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return INVALID;
  return `${d.getUTCDate()}.${d.getUTCMonth() + 1}.${d.getUTCFullYear()}`;
}
