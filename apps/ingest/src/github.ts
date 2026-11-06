// GitHub -> Proofwork evidence (system of record: verified at ingest by the API, no LLM involved).
// Maps webhook events onto the evidence shapes the frozen engine already scores (spec/fixtures/seed-scenario.json):
//   pull_request closed+merged       -> github/pr_merged   deliverables:1        (author)
//   ...whose title starts "Revert"   -> github/pr_reverted reverts_ref=<PR it reverts, from "Reverts owner/repo#N" in the body>
//   pull_request_review approved     -> github/review_done code_reviews:1        (reviewer)
//   issues closed with label "bug"   -> tickets/bug_fixed  severity from a P0..P3 label (assignee, else closer)
// Releases and everything else map to nothing: no KRA scores them.
import { createHmac, timingSafeEqual } from "node:crypto";

export interface EvidenceDraft {
  employee_id: string;
  cycle_id: string;
  source: "github" | "tickets";
  kind: string;
  ref: string;
  observed_at: string;
  observations: Array<{ metric_key: string; value: number }>;
  severity?: "P0" | "P1" | "P2" | "P3" | null;
  self_introduced?: boolean;
  share_bps?: number;
  reverts_ref?: string | null;
  raw?: Record<string, unknown>;
}

export interface MapContext {
  cycleId: string;
  /** github login (lowercase) -> employee_id */
  logins: Record<string, string>;
}

export type MapResult = { drafts: EvidenceDraft[]; skipped?: string };

/** Constant-time check of X-Hub-Signature-256 over the exact raw body. */
export function verifySignature(secret: string, rawBody: Buffer | string, header: string | undefined): boolean {
  if (!secret || !header?.startsWith("sha256=")) return false;
  const expected = Buffer.from("sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex"));
  const got = Buffer.from(header);
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/** "acme=emp_dev_a, Octocat=emp_dev_b" -> { acme: "emp_dev_a", octocat: "emp_dev_b" } */
export function parseLoginMap(s: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (s ?? "").split(",")) {
    const [login, emp] = pair.split("=").map((x) => x?.trim());
    if (login && emp) out[login.toLowerCase()] = emp;
  }
  return out;
}

const SEVERITY = /^(?:severity[:/ ]\s*)?(P[0-3])$/i;

export function mapGithubEvent(event: string, p: any, ctx: MapContext): MapResult {
  const repo: string | undefined = p?.repository?.full_name;
  if (!repo) return { drafts: [], skipped: "no repository" };
  const emp = (login: string | undefined) => (login ? ctx.logins[login.toLowerCase()] : undefined);

  if (event === "pull_request") {
    const pr = p.pull_request;
    if (p.action !== "closed" || !pr?.merged) return { drafts: [], skipped: `pull_request ${p.action} (not a merge)` };
    const author = pr.user?.login;
    const employee = emp(author);
    if (!employee) return { drafts: [], skipped: `unlinked GitHub login ${author}` };
    const ref = `gh:${repo}#${pr.number}`;
    const raw = { url: pr.html_url, title: pr.title, additions: pr.additions, deletions: pr.deletions, merged_by: pr.merged_by?.login };
    const reverted = /^revert\b/i.test(pr.title ?? "") ? /reverts\s+([\w.-]+\/[\w.-]+)?#(\d+)/i.exec(pr.body ?? "") : null;
    if (reverted) {
      return {
        drafts: [{ employee_id: employee, cycle_id: ctx.cycleId, source: "github", kind: "pr_reverted", ref, observed_at: pr.merged_at, observations: [], reverts_ref: `gh:${reverted[1] ?? repo}#${reverted[2]}`, raw }],
      };
    }
    return {
      drafts: [{ employee_id: employee, cycle_id: ctx.cycleId, source: "github", kind: "pr_merged", ref, observed_at: pr.merged_at, observations: [{ metric_key: "deliverables", value: 1 }], raw }],
    };
  }

  if (event === "pull_request_review") {
    const r = p.review;
    if (p.action !== "submitted" || r?.state?.toLowerCase() !== "approved") return { drafts: [], skipped: `review ${p.action}/${r?.state}` };
    const reviewer = r.user?.login;
    if (reviewer && reviewer === p.pull_request?.user?.login) return { drafts: [], skipped: "self-review" };
    const employee = emp(reviewer);
    if (!employee) return { drafts: [], skipped: `unlinked GitHub login ${reviewer}` };
    return {
      drafts: [{
        employee_id: employee, cycle_id: ctx.cycleId, source: "github", kind: "review_done",
        ref: `gh:${repo}#${p.pull_request.number}/review/${r.id}`, observed_at: r.submitted_at,
        observations: [{ metric_key: "code_reviews", value: 1 }], raw: { url: r.html_url, pr: p.pull_request.html_url },
      }],
    };
  }

  if (event === "issues") {
    const is = p.issue;
    const labels: string[] = (is?.labels ?? []).map((l: any) => String(l.name ?? l));
    if (p.action !== "closed" || !labels.some((l) => l.toLowerCase() === "bug")) return { drafts: [], skipped: `issue ${p.action} (not a closed bug)` };
    if (is.state_reason && is.state_reason !== "completed") return { drafts: [], skipped: `bug closed as ${is.state_reason}` };
    const fixer = is.assignee?.login ?? p.sender?.login;
    const employee = emp(fixer);
    if (!employee) return { drafts: [], skipped: `unlinked GitHub login ${fixer}` };
    const sev = labels.map((l) => SEVERITY.exec(l)?.[1]?.toUpperCase()).find(Boolean) as EvidenceDraft["severity"];
    return {
      drafts: [{
        employee_id: employee, cycle_id: ctx.cycleId, source: "tickets", kind: "bug_fixed", ref: `gh:${repo}/issues/${is.number}`,
        observed_at: is.closed_at, observations: [], severity: sev ?? "P3", share_bps: 10000,
        self_introduced: labels.some((l) => l.toLowerCase() === "self-introduced"), raw: { url: is.html_url, title: is.title },
      }],
    };
  }

  return { drafts: [], skipped: `event ${event} is not scored` };
}
