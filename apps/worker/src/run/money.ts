/** One US dollar in nano-USD. Integer units only — money is never a float. */
export const NANO_USD_PER_USD = 1_000_000_000;

/**
 * Nano-USD as an exact decimal string.
 *
 * Formatted once, at the edge, from an integer total. Summing rounded
 * per-model strings and formatting each of them instead is how a cost table
 * stops adding up.
 */
export function decimalNanoUsd(nanoUsd: number): string {
  const sign = nanoUsd < 0 ? "-" : "";
  const magnitude = Math.abs(Math.trunc(nanoUsd));
  const dollars = Math.trunc(magnitude / NANO_USD_PER_USD);
  const fraction = magnitude % NANO_USD_PER_USD;
  return `${sign}${dollars}.${String(fraction).padStart(9, "0")}`;
}
