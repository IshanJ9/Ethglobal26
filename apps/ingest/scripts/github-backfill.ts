// pnpm --filter @proofwork/ingest github:backfill [days=30]
// Pulls merged PRs, approved reviews and closed bug issues from GITHUB_REPO for the last N days and ingests them
// through the same mapper as the webhook. Safe to re-run: the API dedupes by (source, kind, ref).
import { ProofworkApi } from "../src/api.ts";
import { loadEnvFile, parseConfig } from "../src/config.ts";
import { mapGithubEvent, parseLoginMap } from "../src/github.ts";

loadEnvFile();
const c = parseConfig();
if (!c.GITHUB_REPO) throw new Error("set GITHUB_REPO=owner/name in apps/ingest/.env");
const days = Number(process.argv[2] ?? 30);
const since = new Date(Date.now() - days * 86_400_000).toISOString();
const ctx = { cycleId: c.INGEST_CYCLE_ID ?? "cyc_2026h2", logins: parseLoginMap(c.GITHUB_LOGIN_MAP) };
const api = new ProofworkApi(c.API_BASE_URL);
const repository = { full_name: c.GITHUB_REPO };

async function gh(path: string): Promise<any[]> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "proofwork-ingest", ...(c.GITHUB_TOKEN ? { authorization: `Bearer ${c.GITHUB_TOKEN}` } : {}) },
  });
  if (!res.ok) throw new Error(`GitHub ${path}: HTTP ${res.status}`);
  return res.json() as Promise<any[]>;
}

const events: Array<[string, unknown]> = [];
const prs = (await gh(`/repos/${c.GITHUB_REPO}/pulls?state=closed&sort=updated&direction=desc&per_page=100`)).filter((p) => p.merged_at && p.merged_at >= since);
for (const pr of prs) {
  events.push(["pull_request", { action: "closed", pull_request: { ...pr, merged: true }, repository }]);
  for (const r of await gh(`/repos/${c.GITHUB_REPO}/pulls/${pr.number}/reviews?per_page=100`)) {
    events.push(["pull_request_review", { action: "submitted", review: r, pull_request: pr, repository }]);
  }
}
for (const is of await gh(`/repos/${c.GITHUB_REPO}/issues?state=closed&labels=bug&since=${since}&per_page=100`)) {
  if (!is.pull_request) events.push(["issues", { action: "closed", issue: is, repository, sender: is.closed_by }]);
}

let ingested = 0;
const skipped: Record<string, number> = {};
for (const [event, payload] of events) {
  const r = mapGithubEvent(event, payload, ctx);
  if (r.skipped) skipped[r.skipped] = (skipped[r.skipped] ?? 0) + 1;
  for (const d of r.drafts) {
    const item = await api.ingestEvidence(c.CONNECTOR_KEY, d);
    ingested++;
    console.log(`  ${item.kind.padEnd(12)} ${item.ref}  -> ${item.employee_id} (${item.status})`);
  }
}
console.log(`\nbackfill ${c.GITHUB_REPO}, last ${days} days: ${prs.length} merged PRs, ${ingested} evidence items ingested`);
for (const [why, n] of Object.entries(skipped)) console.log(`  skipped ${n}x: ${why}`);
