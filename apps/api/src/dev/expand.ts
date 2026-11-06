// Port of spec/reference/expand.mjs - the exact rule /v1/dev/inject must use to expand `repeat` templates.
// test/dev.test.ts asserts equality with the reference on every seed-scenario event.
export function expandEvent<T extends Record<string, any>>(e: T): T[] {
  if (!e.repeat) return [e];
  return Array.from({ length: e.repeat as number }, (_, i) => {
    const n = i + 1;
    const t = JSON.parse(JSON.stringify(e.template));
    t.ref = t.ref.replace("{n}", String(n));
    t.observed_at = t.observed_at.replace("{dd}", String(1 + (n % 28)).padStart(2, "0"));
    return t;
  });
}
