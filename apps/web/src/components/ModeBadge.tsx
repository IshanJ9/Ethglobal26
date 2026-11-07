type Mode = "mock" | "live" | "off";

const BASE = "inline-flex items-center gap-1 whitespace-nowrap rounded-md px-2 py-0.5 font-mono text-[11px] tracking-[0.04em]";

/** Honest UI: every adapter shows whether it is MOCK or LIVE (INTEGRATION 4). Live is solid, mock is dashed and hatched. */
export function ModeBadge({ mode, className = "" }: { mode: Mode; className?: string }) {
  if (mode === "mock") {
    return (
      <span className={`hatch-mock ${BASE} ${className}`} title="Simulated adapter. Nothing here is verified by the real service.">
        Mock
      </span>
    );
  }
  if (mode === "off") {
    return <span className={`${BASE} border border-line text-muted ${className}`}>Off</span>;
  }
  return <span className={`${BASE} bg-ok font-medium text-paper ${className}`}>Live</span>;
}
