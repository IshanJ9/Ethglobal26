// Evidence agent (AGENT_A section 4): an orchestrator over five DETERMINISTIC connectors. Numbers in
// evidence come only from connector return values written by code, never from model text. In the demo the
// connectors read spec/fixtures/seed-scenario.json "collect" steps (expanded with the reference rule).
import { keccakUtf8 } from "@proofwork/crypto";
import type { components } from "@proofwork/shared";
import type { AuditRepo } from "../db/audit.ts";
import type { DB } from "../db/index.ts";
import type { OrgRepo, Persona } from "../db/org.ts";
import { canView, viewableEmployee } from "../auth/auth.ts";
import { errors } from "../errors.ts";
import { seedScenario } from "../fixtures.ts";
import { expandEvent } from "../dev/expand.ts";
import type { EvidenceIngest, Ledger } from "../ledger/ledger.ts";
import { iso, newId, type Clock } from "../util.ts";
import type { InferenceClient, InferenceRecord } from "../ai/inference.ts";

export type Run = components["schemas"]["Run"];
type Tool = "git" | "tickets" | "crm" | "hris" | "worklog";
const TOOLS: Array<{ tool: Tool; sources: string[] }> = [
  { tool: "git", sources: ["github"] },
  { tool: "tickets", sources: ["tickets"] },
  { tool: "crm", sources: ["crm"] },
  { tool: "hris", sources: ["hris"] },
  { tool: "worklog", sources: ["worklog", "manual"] },
];

/** A connector: returns ingest payloads for one employee + cycle. Demo = seed-scenario collect steps. */
export type Connector = (tool: Tool, sources: string[], employeeId: string, cycleId: string) => Promise<EvidenceIngest[]>;

export const seedConnector: Connector = async (_tool, sources, employeeId, cycleId) => {
  const out: EvidenceIngest[] = [];
  for (const st of seedScenario().steps as any[]) {
    if (!String(st.step_id).includes("collect")) continue; // later events (reverts, co-signs) arrive via webhooks/claims
    for (const ev of st.events) {
      for (const e of expandEvent(ev)) {
        if (e.employee_id !== employeeId || e.cycle_id !== cycleId || !sources.includes(e.source)) continue;
        const { claim_ref: _c, ...ingest } = e;
        out.push(ingest as EvidenceIngest);
      }
    }
  }
  return out;
};

interface RunRow {
  run_id: string;
  employee_id: string;
  cycle_id: string;
  status: string;
  tool_calls_json: string;
  evidence_ids_json: string;
  inference_json: string | null;
  agent_json: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

const toRun = (r: RunRow): Run => {
  const run: Run = {
    run_id: r.run_id,
    employee_id: r.employee_id,
    cycle_id: r.cycle_id,
    status: r.status as Run["status"],
    tool_calls: JSON.parse(r.tool_calls_json),
    evidence_ids: JSON.parse(r.evidence_ids_json),
    error: r.error,
    started_at: r.started_at,
    finished_at: r.finished_at,
  };
  if (r.inference_json) run.inference = JSON.parse(r.inference_json);
  if (r.agent_json) run.agent_identity = JSON.parse(r.agent_json);
  return run;
};

export class RunService {
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(
    private readonly db: DB,
    private readonly org: OrgRepo,
    private readonly ledger: Ledger,
    private readonly audit: AuditRepo,
    private readonly clock: Clock,
    private readonly agent: { ens_name: string; address: string; agent_pass: "verified" | "mock" | "unverified" },
    private readonly connector: Connector = seedConnector,
    /** Live 0G client writes the run's summary note; it never produces evidence or numbers. */
    private readonly inference?: InferenceClient,
  ) {}

  private static readonly SUMMARY_PROMPT =
    "You write one neutral sentence summarising which evidence-collection tools ran and how many items each returned. " +
    'Reply as JSON {"summary": string}. Do not judge performance. Do not add numbers that are not in the input.';

  private async trace(runId: string, note: string, calls: Run["tool_calls"], now: string): Promise<InferenceRecord> {
    if (this.inference?.mode === "live") {
      try {
        const input = JSON.stringify(calls.map((c) => ({ tool: c.tool, ok: c.ok, items_found: c.items_found ?? 0 })));
        const r = await this.inference.complete(RunService.SUMMARY_PROMPT, input, undefined as never);
        return r.record;
      } catch {
        // fall through to the mock trace; the run itself never depends on the model
      }
    }
    return {
      provider: "mock",
      model: "mock-agent-orchestrator-v1",
      mode: "mock",
      request_id: "mock_" + keccakUtf8(runId).slice(2, 18),
      zg_res_key: null,
      tee_verified: null,
      prompt_hash: keccakUtf8(RunService.SUMMARY_PROMPT),
      output_hash: keccakUtf8(note),
      created_at: now,
    };
  }

  private get(id: string): RunRow | undefined {
    return this.db.prepare("SELECT * FROM runs WHERE run_id = ?").get(id) as RunRow | undefined;
  }
  private update(id: string, patch: Partial<RunRow>) {
    const cols = Object.keys(patch);
    this.db.prepare(`UPDATE runs SET ${cols.map((c) => `${c} = @${c}`).join(", ")} WHERE run_id = @__id`).run({ ...patch, __id: id });
  }

  start(p: Persona, employeeId: string, cycleId: string): Run {
    viewableEmployee(p, this.org, employeeId);
    if (!this.org.cycle(cycleId)) throw errors.notFound("Cycle not found");
    const row: RunRow = {
      run_id: newId("run"),
      employee_id: employeeId,
      cycle_id: cycleId,
      status: "queued",
      tool_calls_json: "[]",
      evidence_ids_json: "[]",
      inference_json: null,
      agent_json: JSON.stringify(this.agent),
      error: null,
      started_at: iso(this.clock.now()),
      finished_at: null,
    };
    this.db
      .prepare(
        `INSERT INTO runs (run_id, employee_id, cycle_id, status, tool_calls_json, evidence_ids_json, inference_json, agent_json, error, started_at, finished_at)
         VALUES (@run_id, @employee_id, @cycle_id, @status, @tool_calls_json, @evidence_ids_json, @inference_json, @agent_json, @error, @started_at, @finished_at)`,
      )
      .run(row);
    this.audit.append(row.started_at, p.persona_id, "run.started", row.run_id, { employee_id: employeeId, cycle_id: cycleId });
    const job = new Promise<void>((resolve) => setImmediate(() => this.execute(row.run_id).finally(resolve)));
    this.inflight.set(row.run_id, job);
    return toRun(row);
  }

  private async execute(runId: string) {
    const r = this.get(runId)!;
    this.update(runId, { status: "running" });
    const calls: Run["tool_calls"] = [];
    const ids: string[] = [];
    try {
      for (const t of TOOLS) {
        try {
          const items = await this.connector(t.tool, t.sources, r.employee_id, r.cycle_id);
          let created = 0;
          for (const it of items) {
            const res = this.ledger.ingest(it, { actor: "agent" });
            ids.push(res.item.evidence_id);
            if (res.created) created++;
          }
          calls.push({ tool: t.tool, ok: true, items_found: items.length, note: `${created} new, ${items.length - created} already in ledger` });
        } catch (e) {
          calls.push({ tool: t.tool, ok: false, items_found: 0, note: (e as Error).message.slice(0, 200) });
        }
        this.update(runId, { tool_calls_json: JSON.stringify(calls), evidence_ids_json: JSON.stringify(ids) });
      }
      // The summary note is text only; it never feeds a number into evidence or scores.
      const note = `Collected ${ids.length} evidence item(s) via ${calls.filter((c) => c.ok).length}/${TOOLS.length} tools.`;
      const now = iso(this.clock.now());
      const inference = await this.trace(runId, note, calls, now);
      this.update(runId, { status: "succeeded", inference_json: JSON.stringify(inference), finished_at: now });
      this.audit.append(now, "agent", "run.succeeded", runId, { evidence_count: ids.length });
    } catch (e) {
      const now = iso(this.clock.now());
      this.update(runId, { status: "failed", error: (e as Error).message.slice(0, 500), finished_at: now });
      this.audit.append(now, "agent", "run.failed", runId, {});
    }
  }

  getRun(p: Persona, id: string): Run {
    const r = this.get(id);
    if (!r || !canView(p, this.org.employee(r.employee_id))) throw errors.notFound("Run not found");
    return toRun(r);
  }

  /** Tests / scripts: wait for a background run to finish. */
  async wait(id: string) {
    await this.inflight.get(id);
  }
}
