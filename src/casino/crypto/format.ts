/**
 * Coin prices span five orders of magnitude on one board — PEPE at 0.00000912
 * next to BTC at 65,053.90 — so significant digits and thousands separators
 * can't both be a fixed rule.
 */
export function formatPrice(p: number): string {
  if (!(p > 0)) return "—";
  if (p >= 1000) return p.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (p >= 1) return p.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return p.toPrecision(3);
}
