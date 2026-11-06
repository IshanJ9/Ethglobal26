import type { PublicConfig } from "./api";

/**
 * On-chain amount scaling (CR-003). On Arc testnet the vault runs at 1/N of the real amounts because faucet funding
 * is tiny; the API always reports full-scale amounts. Anything shown next to an explorer link must say so, and any
 * number compared against the explorer must be divided by N.
 */

/** Used while chain_mode is live and the API does not yet serve `chain.amount_divisor` (CR-003 workaround). */
export const LIVE_DIVISOR_FALLBACK = 10000;

export function chainAmountDivisor(cfg: PublicConfig | undefined): number {
  if (!cfg || cfg.chain_mode !== "live") return 1;
  const served = cfg.chain.amount_divisor;
  if (typeof served === "number" && Number.isInteger(served) && served >= 1) return served;
  return LIVE_DIVISOR_FALLBACK;
}

/** API amount (base units, full scale) -> the amount that actually moves on-chain. */
export function toOnChainAmount(amount: string | bigint, divisor: number): bigint {
  return BigInt(amount) / BigInt(divisor);
}

export function scaleLabel(divisor: number): string {
  return `On-chain amounts scaled 1:${divisor.toLocaleString("en-US")}`;
}
