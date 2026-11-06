"use client";

// CR-004 building blocks: distribution strip, KRA box plot, signal chips, three-layer badges.
import type { Schemas } from "@/lib/api";
import { formatBps } from "@/lib/format";

export type DistStats = Schemas["DistStats"];

/** A horizontal strip: p25-p75 band, median tick, every member as a dot, the highlighted member larger. */
export function DistStrip({ stats, values, highlight, format = formatBps }: { stats: DistStats; values: number[]; highlight?: number[]; format?: (n: number) => string }) {
  const lo = Math.min(stats.min, ...values);
  const hi = Math.max(stats.max, ...values);
  const span = hi - lo || 1;
  const x = (v: number) => `${((v - lo) / span) * 100}%`;
  return (
    <div className="w-full">
      <div className="relative h-6">
        <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-line" />
        <div className="absolute top-1/2 h-2.5 -translate-y-1/2 rounded-sm bg-code/15" style={{ left: x(stats.p25), width: `calc(${x(stats.p75)} - ${x(stats.p25)})` }} />
        <div className="absolute top-0.5 h-5 w-px bg-code" style={{ left: x(stats.median) }} title={`median ${format(stats.median)}`} />
        {values.map((v, i) => {
          const hot = highlight?.includes(i);
          return (
            <span
              key={i}
              className={`absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full ${hot ? "h-3 w-3 bg-ink ring-2 ring-surface" : "h-2 w-2 bg-muted/60"}`}
              style={{ left: x(v) }}
              title={format(v)}
            />
          );
        })}
      </div>
      <div className="flex justify-between text-[10px] tabular-nums text-muted">
        <span>{format(lo)}</span>
        <span>median {format(stats.median)}</span>
        <span>{format(hi)}</span>
      </div>
    </div>
  );
}

const SIGNAL_TONE = {
  positive: "border-chain/40 bg-chain/10 text-chain",
  neutral: "border-line bg-paper text-muted",
  negative: "border-danger/40 bg-danger/10 text-danger",
} as const;

export function SignalChips({ signals }: { signals: Schemas["ContextSignal"][] }) {
  if (!signals.length) return <p className="text-sm text-muted">No notable signals.</p>;
  return (
    <ul className="flex flex-col gap-1.5">
      {signals.map((s) => (
        <li key={s.code} className={`rounded-md border px-2.5 py-1.5 text-sm ${SIGNAL_TONE[s.tone]}`}>
          <span className="mr-1.5 text-[10px] font-semibold uppercase tracking-wide">{s.code.replace(/_/g, " ")}</span>
          {s.text}
        </li>
      ))}
    </ul>
  );
}

/** Small numbered header for the three review layers. */
export function LayerHeader({ n, title, who }: { n: 1 | 2 | 3; title: string; who: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-ink text-xs font-semibold text-surface">{n}</span>
      <span className="font-display text-lg font-semibold">{title}</span>
      <span className="text-xs text-muted">{who}</span>
    </div>
  );
}

export function SourceBadge({ source }: { source: Schemas["Review"]["reasoning_source"] }) {
  const m = {
    "0g_private_computer": ["0G Private Computer", "border-ai/40 bg-ai/10 text-ai"],
    deterministic_fallback: ["Deterministic fallback", "border-human/40 bg-human/10 text-human"],
    mock: ["Mock writer", "border-mock/40 bg-mock/10 text-mock"],
  }[source];
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${m[1]}`}>{m[0]}</span>;
}

export const pctPpm = (ppm: number) => `${(ppm / 10000).toFixed(1)}%`;
export const zText = (milli: number) => `${milli >= 0 ? "+" : ""}${(milli / 1000).toFixed(2)}σ`;
