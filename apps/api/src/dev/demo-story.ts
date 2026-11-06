// The demo story, API-level, used by `pnpm e2e:demo` (mock chain), `pnpm e2e:chain` (live Arc) and
// test/e2e.demo.test.ts. Every number is checked against spec/fixtures/seed-scenario.json.
import { randomBytes } from "node:crypto";
import { commit, claimDigest, makeDomain, toClaimMessage } from "@proofwork/crypto";
import { keccak256, stringToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { seedScenario } from "../fixtures.ts";

export interface Client {
  call(method: string, url: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; json: any }>;
}
export interface StoryOptions {
  /** Full story incl. claims, deny path, revert/revision, cycle 2, shred. false = G2 chain proof only. */
  full?: boolean;
  log?: (line: string) => void;
  /** In-process only: lets the story prove scorecard reveal -> verify. */
  revealScorecard?: (id: string) => { value: unknown; salt: string } | null;
}

/** DEMO persona keys (spec/vectors persona_key_rule). Never fund them with real value. */
const persona = (id: string) => privateKeyToAccount(keccak256(stringToBytes(`proofwork-demo-persona:${id}`)));
const mockWorld = (action: string, signal: string) => ({ adapter: "mock", payload: { action, signal, nullifier: "0x" + randomBytes(32).toString("hex") } });

export async function runDemoStory(c: Client, opts: StoryOptions = {}) {
  const log = opts.log ?? (() => {});
  const S = seedScenario();
  const C1 = S.cycle_ids.c1;
  const C2 = S.cycle_ids.c2;
  const ids: Record<string, string> = {};

  const expectOk = (r: { status: number; json: any }, status: number, what: string) => {
    if (r.status !== status) throw new Error(`${what}: expected HTTP ${status}, got ${r.status} ${JSON.stringify(r.json)}`);
    return r.json;
  };
  const eq = (got: unknown, want: unknown, what: string) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  };
  const step = (s: string) => log(`  ✓ ${s}`);
  const login = async (p: string) => ({ authorization: `Bearer ${expectOk(await c.call("POST", "/v1/dev/login", { persona_id: p }), 200, `login ${p}`).token}` });

  const cfg = expectOk(await c.call("GET", "/v1/config/public"), 200, "config");
  log(`chain_mode=${cfg.chain_mode} world_mode=${cfg.world_mode} zerog_mode=${cfg.zerog_mode}`);
  const hr = await login("p_hr");
  const mgr = await login("p_eng_mgr");
  const asha = await login("p_dev_a");

  // ---- s1: evidence agent run for Asha, then connectors deliver the rest of cycle 1 ----
  const run = expectOk(await c.call("POST", "/v1/runs", { employee_id: "emp_dev_a", cycle_id: C1 }, mgr), 202, "start run");
  let r = run;
  for (let i = 0; i < 100 && (r.status === "queued" || r.status === "running"); i++) {
    await new Promise((res) => setTimeout(res, 50));
    r = expectOk(await c.call("GET", `/v1/runs/${run.run_id}`, undefined, mgr), 200, "poll run");
  }
  eq(r.status, "succeeded", "run status");
  step(`agent run ${run.run_id}: ${r.evidence_ids.length} evidence items via ${r.tool_calls.length} tools (agent ${r.agent_identity?.ens_name})`);
  expectOk(await c.call("POST", "/v1/dev/inject", { step_id: "s1_collect_baseline" }, hr), 200, "inject s1");
  const compute = async (emp: string, plan: string, cyc: string) =>
    expectOk(await c.call("POST", "/v1/scores/compute", { plan_id: plan, employee_id: emp, cycle_id: cyc }, hr), 200, `compute ${emp}`);
  const s1 = S.steps.find((s: any) => s.step_id === "s1_collect_baseline").expect;
  for (const [emp, plan] of [["emp_dev_a", "pln_eng_v1"], ["emp_dev_b", "pln_eng_ic_v1"], ["emp_dev_c", "pln_eng_ic_v1"], ["emp_ae", "pln_sales_v1"]] as const) {
    const x = await compute(emp, plan, C1);
    eq([x.score_bps, x.multiplier_bps, x.bonus_amount], [s1[`${emp}@${C1}`].score_bps, s1[`${emp}@${C1}`].multiplier_bps, s1[`${emp}@${C1}`].bonus_amount], `s1 ${emp}`);
  }
  step("s1 scores match seed-scenario (P0 fixer 40000 milli vs 20xP3 capped 10000; self-introduced = 0)");

  if (opts.full !== false) {
    // ---- c1: client call -> AI draft -> verify-yourself -> sign -> co-sign (replaces the s2 shortcut) ----
    const sc1 = S.scripted_claims.find((x: any) => x.id === "c1_happy_cosign");
    const cfo = persona("p_client_cfo");
    const claim = expectOk(
      await c.call("POST", "/v1/claims", { cycle_id: C1, kra_id: sc1.kra_id, raw_text: sc1.raw_text, cosigner_address: cfo.address, cosigner_label: "Acme Bank CFO" }, asha),
      201,
      "create claim",
    );
    const pkg = expectOk(await c.call("GET", `/v1/claims/${claim.claim_id}/signing-package`, undefined, asha), 200, "signing package");
    const dom = makeDomain(pkg.typed_data.domain.chainId, pkg.typed_data.domain.verifyingContract);
    eq(commit(pkg.claim_salt, pkg.claim_value), pkg.typed_data.message.claimCommitment, "claim commitment (verify yourself)");
    eq(commit(pkg.evidence_salt, pkg.evidence_value), pkg.typed_data.message.evidenceCommitment, "evidence commitment (verify yourself)");
    eq(claimDigest(dom, toClaimMessage(pkg.typed_data.message)), pkg.digest, "digest (verify yourself)");
    const sign = (acct: ReturnType<typeof persona>) =>
      acct.signTypedData({ domain: pkg.typed_data.domain, types: pkg.typed_data.types, primaryType: "Claim", message: toClaimMessage(pkg.typed_data.message) as any });
    expectOk(await c.call("POST", `/v1/claims/${claim.claim_id}/submit`, { employee_signature: await sign(persona("p_dev_a")) }, asha), 200, "submit claim");
    const grant = expectOk(await c.call("POST", `/v1/claims/${claim.claim_id}/cosign-grants`, { auth_method: "magic_link_wallet" }, asha), 201, "grant");
    const tok = { "x-cosign-token": grant.token };
    expectOk(await c.call("GET", "/v1/cosign/view", undefined, tok), 200, "cosign view");
    const signed = expectOk(await c.call("POST", "/v1/cosign/sign", { signature: await sign(cfo) }, tok), 200, "cosign sign");
    eq(signed.state, "verified", "claim state");
    eq((await c.call("GET", "/v1/cosign/view", undefined, tok)).status, 410, "grant closed after signing (n05)");
    ids.claim = claim.claim_id;
    step(`c1 claim ${claim.claim_id} co-signed; co-signer access closed (410)`);

    const s2 = S.steps.find((s: any) => s.step_id === "s2_cosign_engagement").expect[`emp_dev_a@${C1}`];
    const after = await compute("emp_dev_a", "pln_eng_v1", C1);
    eq([after.score_bps, after.multiplier_bps, after.bonus_amount], [s2.score_bps, s2.multiplier_bps, s2.bonus_amount], "score after co-signed claim (s2)");
    step(`Asha after co-sign: ${after.score_bps} bps, multiplier ${after.multiplier_bps}`);

    // ---- c2: prompt injection is flagged and changes nothing ----
    const sc2 = S.scripted_claims.find((x: any) => x.id === "c2_prompt_injection");
    const ben = await login("p_dev_b");
    const inj = expectOk(
      await c.call("POST", "/v1/claims", { cycle_id: C1, kra_id: sc2.kra_id, raw_text: sc2.raw_text, cosigner_address: cfo.address, cosigner_label: "Acme Bank" }, ben),
      201,
      "c2 claim",
    );
    eq(inj.ai_flags.includes("prompt_injection_suspected") && inj.state === "drafted", true, "c2 flagged, state unchanged");
    step("c2 prompt-injection note flagged; state stays drafted");
  }

  // ---- F2: scorecard v1 -> World-approved -> anchor -> attest -> release ----
  const v1 = expectOk(await c.call("POST", "/v1/scorecards", { employee_id: "emp_dev_a", cycle_id: C1 }, mgr), 201, "scorecard v1");
  const apr = expectOk(await c.call("POST", "/v1/approvals", { scorecard_id: v1.scorecard_id }, mgr), 201, "approval v1");
  expectOk(await c.call("POST", `/v1/approvals/${apr.approval_id}/complete`, { decision: "approve", world_result: mockWorld(apr.world_action, apr.challenge) }, mgr), 200, "approve v1");
  const att1 = expectOk(await c.call("POST", "/v1/chain/attest", { scorecard_id: v1.scorecard_id }, mgr), 201, "attest v1");
  const pay1 = expectOk(await c.call("POST", `/v1/payouts/${v1.scorecard_id}/release`, undefined, mgr), 200, "release v1");
  ids.v1 = v1.scorecard_id;
  ids.attestation_v1 = String(att1.attestation_id);
  step(`v1 ${v1.scorecard_id} (${v1.result.score_bps} bps) approved with World step-up, attested #${att1.attestation_id} tx ${att1.tx_hash.slice(0, 12)}...`);
  step(`released: paid ${pay1.paid}, held ${pay1.held} (status ${pay1.status})`);

  if (opts.full === false) return { ids, payout: pay1 };

  const s3 = S.steps.find((s: any) => s.step_id === "s3_revert_pr").expect;
  eq([pay1.entitlement, pay1.paid, pay1.held], [s3["emp_dev_a@payout_revision"].v1_split.entitlement, s3["emp_dev_a@payout_revision"].v1_split.immediate, s3["emp_dev_a@payout_revision"].v1_split.held], "v1 payout split");

  // ---- n02: a denied approval blocks attestation ----
  const vb = expectOk(await c.call("POST", "/v1/scorecards", { employee_id: "emp_dev_b", cycle_id: C1 }, mgr), 201, "scorecard ben");
  const ab = expectOk(await c.call("POST", "/v1/approvals", { scorecard_id: vb.scorecard_id }, mgr), 201, "approval ben");
  expectOk(await c.call("POST", `/v1/approvals/${ab.approval_id}/complete`, { decision: "deny", comment: "needs review" }, mgr), 200, "deny ben");
  const blocked = await c.call("POST", "/v1/chain/attest", { scorecard_id: vb.scorecard_id }, mgr);
  eq([blocked.status, blocked.json.error?.code], [409, "approval_required"], "deny blocks attest (n02)");
  step("denied approval blocks attestation (409 approval_required)");

  // ---- s3: PR #101 reverted -> v2 -> approve -> attest (supersedes v1) -> applyRevision ----
  expectOk(await c.call("POST", "/v1/dev/inject", { step_id: "s3_revert_pr" }, hr), 200, "inject s3");
  const v1now = expectOk(await c.call("GET", `/v1/scorecards/${v1.scorecard_id}`, undefined, mgr), 200, "v1 after revert");
  eq(v1now.needs_revision, true, "v1 needs_revision");
  const v2 = expectOk(await c.call("POST", `/v1/scorecards/${v1.scorecard_id}/revise`, { reason: "PR #101 reverted (regression)" }, mgr), 201, "revise");
  eq([v2.version, v2.result.score_bps, v2.result.multiplier_bps], [2, s3[`emp_dev_a@${C1}`].score_bps, s3[`emp_dev_a@${C1}`].multiplier_bps], "v2 score");
  const diff = expectOk(await c.call("GET", `/v1/scorecards/${v2.scorecard_id}/diff/${v1.scorecard_id}`, undefined, mgr), 200, "diff");
  step(`v2 ${v2.scorecard_id}: ${v2.result.score_bps} bps (delta ${diff.score_bps_delta}), multiplier ${v2.result.multiplier_bps}, bonus delta ${diff.bonus_amount_delta}`);
  const apr2 = expectOk(await c.call("POST", "/v1/approvals", { scorecard_id: v2.scorecard_id }, mgr), 201, "approval v2");
  expectOk(await c.call("POST", `/v1/approvals/${apr2.approval_id}/complete`, { decision: "approve", world_result: mockWorld(apr2.world_action, apr2.challenge) }, mgr), 200, "approve v2");
  const att2 = expectOk(await c.call("POST", "/v1/chain/attest", { scorecard_id: v2.scorecard_id }, mgr), 201, "attest v2");
  eq(att2.supersedes_attestation_id, att1.attestation_id, "v2 supersedes v1 (n14)");
  const pay2 = expectOk(await c.call("GET", `/v1/payouts/${v2.scorecard_id}`, undefined, mgr), 200, "payout after revision");
  const rev = s3["emp_dev_a@payout_revision"].revision;
  eq([pay2.entitlement, pay2.held, pay2.forfeited, pay2.overpaid], [rev.new_entitlement, rev.held_remaining, rev.forfeited, rev.overpaid], "revision math");
  ids.v2 = v2.scorecard_id;
  step(`attested v2 #${att2.attestation_id} superseding #${att1.attestation_id}; vault forfeited ${pay2.forfeited}, held now ${pay2.held}`);

  const ver1 = expectOk(await c.call("POST", "/v1/verify", { kind: "scorecard", id: v1.scorecard_id }), 200, "verify v1");
  eq(ver1.checks.find((x: any) => x.name === "attestation_not_revoked")?.ok, false, "v1 attestation revoked");
  const reveal = opts.revealScorecard?.(v2.scorecard_id) ?? undefined;
  const ver2 = expectOk(await c.call("POST", "/v1/verify", { kind: "scorecard", id: v2.scorecard_id, ...(reveal ? { reveal } : {}) }), 200, "verify v2");
  eq(ver2.ok, true, `verify v2 ${JSON.stringify(ver2.checks)}`);
  step(`verify: v1 revoked, v2 ok (${ver2.checks.map((x: any) => x.name).join(", ")})`);

  // ---- s4: cycle 2 blends the final cycle-1 score ----
  expectOk(await c.call("POST", "/v1/dev/inject", { step_id: "s4_cycle2_collect" }, hr), 200, "inject s4");
  const s4 = S.steps.find((s: any) => s.step_id === "s4_cycle2_collect").expect[`emp_dev_a@${C2}`];
  const cyc2 = await compute("emp_dev_a", "pln_eng_v1", C2);
  eq([cyc2.score_bps, cyc2.multiplier_bps, cyc2.carry_forward?.prior_score_bps, cyc2.carry_forward?.blended_score_bps], [s4.score_bps, s4.multiplier_bps, 8621, s4.carry_forward.blended_score_bps], "s4 carry-forward");
  step(`cycle 2 carry-forward: prior ${cyc2.carry_forward.prior_score_bps} -> blended ${cyc2.carry_forward.blended_score_bps} bps`);

  // ---- F5: HR shreds a record; proof stays valid, data is gone ----
  const evd = v2.evidence_ids[0];
  expectOk(await c.call("POST", `/v1/evidence/${evd}/shred`, undefined, hr), 200, "shred");
  const vs = expectOk(await c.call("POST", "/v1/verify", { kind: "evidence", id: evd }), 200, "verify shredded");
  const chk = Object.fromEntries(vs.checks.map((x: any) => [x.name, x.ok]));
  eq([chk.evidence_not_shredded, chk.merkle_proof_valid, chk.root_anchored_on_chain], [false, true, true], "shred keeps verifiability (n15)");
  step(`shredded ${evd}: evidence_not_shredded=false, merkle_proof_valid=true`);
  return { ids, payout: pay2 };
}
