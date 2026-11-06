// pnpm --filter @proofwork/api demo:script [--live]
// Prints the exact click order for the demo video: persona, page, action, the API call it triggers, the ids
// involved and the number the screen must show (all numbers come from spec/fixtures/seed-scenario.json).
// --live also asks the running API (E2E_BASE_URL or http://localhost:8787) for its modes and current ids.
import { seedScenario, specJson } from "../src/fixtures.ts";
import { payoutSplit } from "../src/engine/engine.ts";

const S = seedScenario();
const org = specJson("fixtures/seed-org.json");
const C1 = S.cycle_ids.c1;
const C2 = S.cycle_ids.c2;
const base = (process.env.E2E_BASE_URL ?? "http://localhost:8787").replace(/\/$/, "");
const usdc = (units: string) => {
  const b = BigInt(units);
  const frac = (b % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${(b / 1_000_000n).toLocaleString("en-US")}${frac ? "." + frac : ""} USDC`;
};
const person = (pid: string) => org.personas.find((p: any) => p.persona_id === pid);
const exp = (step: string, key: string) => S.steps.find((s: any) => s.step_id === step).expect[key];

const s1a = exp("s1_collect_baseline", `emp_dev_a@${C1}`);
const s1b = exp("s1_collect_baseline", `emp_dev_b@${C1}`);
const s1c = exp("s1_collect_baseline", `emp_dev_c@${C1}`);
const s2 = exp("s2_cosign_engagement", `emp_dev_a@${C1}`);
const s3 = exp("s3_revert_pr", `emp_dev_a@${C1}`);
const rev = exp("s3_revert_pr", "emp_dev_a@payout_revision");
const s4 = exp("s4_cycle2_collect", `emp_dev_a@${C2}`);
const eng = specJson("fixtures/plans/pln_eng_v1.json");
const split = payoutSplit(eng.target_bonus, s2.multiplier_bps, eng.holdback_bps);
const c1 = S.scripted_claims.find((c: any) => c.id === "c1_happy_cosign");
const c2 = S.scripted_claims.find((c: any) => c.id === "c2_prompt_injection");
const c3 = S.scripted_claims.find((c: any) => c.id === "c3_cosigner_declines");

type Step = { who: string; page: string; click: string; api: string; see: string };
const steps: Step[] = [
  { who: "p_eng_mgr", page: "/team -> Asha", click: "Run evidence agent", api: `POST /v1/runs {employee_id:"emp_dev_a", cycle_id:"${C1}"}`, see: "5 tool calls (git, tickets, crm, hris, worklog) with new items, agent kra-agent, MOCK 0G badge" },
  { who: "p_hr", page: "/demo", click: "Press step s1 'Collect baseline' (the other employees' connectors)", api: "POST /v1/dev/inject {step_id:\"s1_collect_baseline\"}", see: "cycle-1 evidence for every demo employee, verified (system-of-record connectors); Asha's items are not duplicated" },
  { who: "p_eng_mgr", page: "/team", click: "Compare Asha, Ben, Chen", api: "POST /v1/scores/compute (x3)", see: `bug credit: Asha one P0 = ${s1a.bug_credit_total_milli} milli, Ben twenty P3 = capped ${s1b.bug_credit_total_milli}, Chen self-introduced = ${s1c.bug_credit_total_milli}` },
  { who: "p_dev_a", page: "/claims/new", click: `KRA client_engagement, co-signer ${person("p_client_cfo").wallet_address}, paste c1 text`, api: "POST /v1/claims", see: `AI draft: client_call, 2026-10-14, 45 min, "Acme Bank"; no flags. c1 text: "${c1.raw_text}"` },
  { who: "p_dev_a", page: "/claims/[id]", click: "Verify yourself -> Sign (EIP-712) -> Create co-sign link (magic link + wallet)", api: "GET signing-package, POST submit, POST cosign-grants", see: "both commitments + digest recomputed locally = match; state pending_cosign" },
  { who: "p_client_cfo", page: "/cosign#token=...", click: "Review -> Sign with wallet", api: "GET /v1/cosign/view, POST /v1/cosign/sign", see: "claim verified; reopening the link shows 'This link is no longer active' (410 grant_closed)" },
  { who: "p_dev_a", page: "/", click: "Refresh my cycle", api: "POST /v1/scores/compute", see: `score ${s2.score_bps} bps, multiplier ${s2.multiplier_bps} (100%), bonus ${usdc(s2.bonus_amount)}` },
  { who: "p_dev_b", page: "/claims/new", click: "Paste c2 (prompt injection) text", api: "POST /v1/claims", see: `flag prompt_injection_suspected, state stays drafted. c2 text: "${c2.raw_text}"` },
  { who: "p_eng_mgr", page: "/scorecards/[v1]", click: "Create scorecard v1 -> Request approval", api: "POST /v1/scorecards, POST /v1/approvals", see: `v1 ${s2.score_bps} bps; challenge + world_action pw-approve-scorecard` },
  { who: "p_eng_mgr", page: "/approvals/[id]", click: "World step-up (MOCK) -> Approve", api: "POST /v1/approvals/{id}/complete {decision:approve, world_result}", see: "approved; approval_proof_hash shown" },
  { who: "p_eng_mgr", page: "/scorecards/[v1]", click: "Attest on chain -> Release payout", api: "POST /v1/chain/attest (auto-anchors), POST /v1/payouts/{v1}/release", see: `attestation #1 + tx; paid ${usdc(split.immediate)}, held ${usdc(split.held)} (${eng.holdback_bps / 100}% holdback, ${eng.maturity_days} days)` },
  { who: "p_eng_mgr", page: "/scorecards/[Ben]", click: "Create, request approval, Deny, then try Attest", api: "POST complete {decision:deny}, POST /v1/chain/attest", see: "409 approval_required: 'Manager approval is required before this step...' (payout impossible)" },
  { who: "p_hr", page: "/demo", click: "Press step s3 'PR #101 reverted'", api: "POST /v1/dev/inject {step_id:\"s3_revert_pr\"}", see: "evidence gh:acme/core#101 -> reverted; v1 shows 'needs revision'" },
  { who: "p_eng_mgr", page: "/scorecards/[v1]", click: "Revise (reason: PR #101 reverted) -> open diff", api: "POST /v1/scorecards/{v1}/revise, GET /v1/scorecards/{v2}/diff/{v1}", see: `v2 ${s3.score_bps} bps (delta ${s3.score_bps - s2.score_bps}), multiplier ${s3.multiplier_bps}, bonus ${usdc(s3.bonus_amount)}` },
  { who: "p_eng_mgr", page: "/approvals -> /scorecards/[v2]", click: "Approve v2 with World step-up -> Attest", api: "POST approvals + complete, POST /v1/chain/attest", see: `attestation #2 supersedes #1 (v1 revoked); vault forfeits ${usdc(rev.revision.forfeited)}, held now ${usdc(rev.revision.held_remaining)}, overpaid ${usdc(rev.revision.overpaid)}` },
  { who: "anyone", page: "/verify", click: "Verify scorecard v1, then v2", api: "POST /v1/verify {kind:scorecard}", see: "v1: attestation_not_revoked = false; v2: all checks pass" },
  { who: "p_hr", page: "/demo", click: "Press step s4 'Cycle 2 collect'", api: "POST /v1/dev/inject {step_id:\"s4_cycle2_collect\"}; compute cycle 2", see: `cycle 2: prior ${s4.carry_forward.prior_score_bps} blended at ${s4.carry_forward.history_weight_bps / 100}% -> ${s4.carry_forward.blended_score_bps} bps, multiplier ${s4.multiplier_bps}` },
  { who: "p_dev_c", page: "/claims/new", click: "Paste c3, sign, send link; CFO declines", api: "POST /v1/cosign/decline", see: `claim declined, its evidence rejected. c3 text: "${c3.raw_text}"` },
  { who: "p_hr", page: "/evidence -> any item", click: "Shred, then Verify", api: "POST /v1/evidence/{id}/shred, POST /v1/verify", see: "evidence_not_shredded = false, merkle_proof_valid = true ('designed for erasure via crypto-shredding')" },
  { who: "p_hr", page: "/audit", click: "Scroll the log", api: "GET /v1/audit", see: "hash-chained entries for every step above" },
];

console.log("PROOFWORK DEMO - click order (numbers from spec/fixtures/seed-scenario.json)\n");
console.log("Before recording:\n  pnpm --filter @proofwork/api seed:reset\n  pnpm dev                       (API :8787, web :3000)\n");
steps.forEach((s, i) => {
  const p = person(s.who);
  console.log(`${String(i + 1).padStart(2)}. [${p ? `${p.display_name} (${s.who})` : s.who}] ${s.page}`);
  console.log(`    click: ${s.click}`);
  console.log(`    api:   ${s.api}`);
  console.log(`    see:   ${s.see}`);
});
console.log("\nFixed ids:");
console.log(`  cycles: ${C1} (numeric 1), ${C2} (numeric 2)   plan: pln_eng_v1 (target ${usdc(eng.target_bonus)})`);
console.log(`  steps:  ${S.steps.map((s: any) => s.step_id).join(", ")}`);
console.log(`  co-signer wallet (p_client_cfo): ${person("p_client_cfo").wallet_address}`);

if (process.argv.includes("--live")) {
  try {
    const cfg: any = await (await fetch(`${base}/v1/config/public`)).json();
    console.log(`\nLive server ${base}: chain_mode=${cfg.chain_mode} world_mode=${cfg.world_mode} zerog_mode=${cfg.zerog_mode} chain=${cfg.chain.name} (${cfg.chain.chain_id})`);
    const login: any = await (await fetch(`${base}/v1/dev/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ persona_id: "p_hr" }) })).json();
    const h = { authorization: `Bearer ${login.token}` };
    const scs: any[] = ((await (await fetch(`${base}/v1/scorecards?employee_id=emp_dev_a`, { headers: h })).json()) as any).items ?? [];
    const claims: any[] = ((await (await fetch(`${base}/v1/claims`, { headers: h })).json()) as any).items ?? [];
    console.log(`  Asha's scorecards: ${scs.map((s: any) => `v${s.version} ${s.scorecard_id} [${s.status}${s.attestation ? ` #${s.attestation.attestation_id}` : ""}]`).join(", ") || "none yet"}`);
    console.log(`  claims: ${claims.map((c: any) => `${c.claim_id} ${c.employee_id} [${c.state}]`).join(", ") || "none yet"}`);
  } catch (e) {
    console.log(`\n(--live: could not reach ${base}: ${(e as Error).message})`);
  }
}
