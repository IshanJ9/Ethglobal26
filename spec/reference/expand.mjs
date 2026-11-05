// Expands a seed-scenario event that uses `repeat` + `template` into concrete ingest payloads. Agent A's /v1/dev/inject MUST use this exact rule.
export function expandEvent(e) {
  if (!e.repeat) return [e];
  return Array.from({ length: e.repeat }, (_, i) => {
    const n = i + 1;
    const t = JSON.parse(JSON.stringify(e.template));
    t.ref = t.ref.replace("{n}", String(n));
    t.observed_at = t.observed_at.replace("{dd}", String(1 + (n % 28)).padStart(2, "0"));
    return t;
  });
}
