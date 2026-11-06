// Display-only formatting. Never feed these values back into logic (INTEGRATION 5.1-5.2).

const USDC_DECIMALS = 6n;
const USDC_UNIT = 10n ** USDC_DECIMALS;

/** "1234500000" (base units) -> "1,234.50 USDC". */
export function formatUsdc(baseUnits: string, opts: { symbol?: boolean } = {}): string {
  const v = BigInt(baseUnits);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = (abs / USDC_UNIT).toLocaleString("en-US");
  const frac = (abs % USDC_UNIT).toString().padStart(Number(USDC_DECIMALS), "0").slice(0, 2);
  return `${neg ? "-" : ""}${whole}.${frac}${opts.symbol === false ? "" : " USDC"}`;
}

/** 9071 bps -> "90.71%". */
export const formatBps = (bps: number): string => `${(bps / 100).toFixed(2)}%`;

/** 0x1234…abcd for hashes and addresses. */
export function shortHex(hex: string, head = 6, tail = 4): string {
  return hex.length <= head + tail + 1 ? hex : `${hex.slice(0, head)}…${hex.slice(-tail)}`;
}
