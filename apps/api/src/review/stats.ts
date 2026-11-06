// CR-004: integer statistics for cluster comparisons. Integers only (so every result can be canonically
// hashed and recomputed byte-for-byte); rounding is half away from zero.

export interface DistStats {
  n: number;
  mean: number;
  median: number;
  p25: number;
  p75: number;
  min: number;
  max: number;
  stdev: number;
}

export const roundHalf = (x: number) => (x < 0 ? -Math.round(-x) : Math.round(x));

/** Linear-interpolated quantile (q in [0,1]) of a sorted array. */
function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return roundHalf(sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo));
}

export function distStats(values: number[]): DistStats {
  const n = values.length;
  if (!n) return { n: 0, mean: 0, median: 0, p25: 0, p75: 0, min: 0, max: 0, stdev: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const meanF = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, v) => a + (v - meanF) ** 2, 0) / n; // population: the cluster IS the population
  return {
    n,
    mean: roundHalf(meanF),
    median: quantile(sorted, 0.5),
    p25: quantile(sorted, 0.25),
    p75: quantile(sorted, 0.75),
    min: sorted[0],
    max: sorted[n - 1],
    stdev: roundHalf(Math.sqrt(variance)),
  };
}

/** Mid-rank percentile in bps: share of the cluster below x, plus half of the ties (incl. x itself). */
export function percentileBps(values: number[], x: number): number {
  if (!values.length) return 0;
  const below = values.filter((v) => v < x).length;
  const equal = values.filter((v) => v === x).length;
  return roundHalf(((below + equal / 2) / values.length) * 10000);
}

/** z-score x 1000 against the population mean/stdev (0 when everyone is equal). */
export function zMilli(values: number[], x: number): number {
  const n = values.length;
  if (!n) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / n);
  return sd === 0 ? 0 : roundHalf(((x - mean) / sd) * 1000);
}

/** Competition ranking (1 = best; ties share a rank). */
export function rankDesc(values: number[], x: number): number {
  return values.filter((v) => v > x).length + 1;
}

/** Least-squares slope of a series over equally spaced periods (units per period). */
export function slope(series: number[]): number {
  const n = series.length;
  if (n < 2) return 0;
  const xm = (n - 1) / 2;
  const ym = series.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  series.forEach((y, i) => {
    num += (i - xm) * (y - ym);
    den += (i - xm) ** 2;
  });
  return roundHalf(num / den);
}

/** Formatting used in packets and texts: 8571 bps -> "85.71%". */
export const pct = (bps: number, decimals = 2) => `${(bps / 100).toFixed(decimals)}%`;
export const pctPpm = (ppm: number, decimals = 1) => `${(ppm / 10000).toFixed(decimals)}%`;
export const signedPct = (bps: number) => `${bps >= 0 ? "+" : "-"}${(Math.abs(bps) / 100).toFixed(2)} pts`;
export const days10 = (x10: number) => (x10 / 10).toFixed(1);
export const usd = (baseUnits: string) => {
  const v = BigInt(baseUnits);
  const whole = v / 1000000n;
  const cents = (v % 1000000n) / 10000n;
  return `${whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${cents.toString().padStart(2, "0")} USDC`;
};
