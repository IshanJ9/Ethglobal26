type Mode = "mock" | "live" | "off";

/** Honest UI: every adapter shows whether it is MOCK or LIVE (INTEGRATION 4). */
export function ModeBadge({ mode, className = "" }: { mode: Mode; className?: string }) {
  if (mode === "mock") {
    return (
      <span
        className={`hatch-mock inline-flex items-center rounded-sm px-1.5 py-px text-[11px] font-semibold text-ink ${className}`}
        title="Simulated adapter. Nothing here is verified by the real service."
      >
        Mock
      </span>
    );
  }
  if (mode === "off") {
    return (
      <span className={`inline-flex items-center rounded-sm border border-line px-1.5 py-px text-[11px] text-muted ${className}`}>
        Off
      </span>
    );
  }
  return (
    <span className={`inline-flex items-center gap-1 rounded-sm bg-ink px-1.5 py-px text-[11px] font-semibold text-surface ${className}`}>
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[#4ade80]" />
      Live
    </span>
  );
}
