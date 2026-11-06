"use client";

import { usePublicConfig } from "@/lib/config";
import { chainAmountDivisor, scaleLabel } from "@/lib/chainScale";

/**
 * Honest-UI note for live chain mode: explorer amounts are 1/N of what the app shows (CR-003).
 * Place next to payouts and explorer links. Renders nothing when amounts are unscaled.
 */
export function ChainScaleNote({ className = "" }: { className?: string }) {
  const { data: cfg } = usePublicConfig();
  const n = chainAmountDivisor(cfg);
  if (n <= 1) return null;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border border-chain/40 px-1.5 py-0.5 text-[11px] text-chain ${className}`}
      title={`The Arc testnet vault holds 1/${n.toLocaleString("en-US")} of the real amounts. The app shows full-scale amounts; divide by ${n.toLocaleString("en-US")} to compare with the explorer.`}
    >
      {scaleLabel(n)}
    </span>
  );
}
