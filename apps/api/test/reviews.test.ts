// CR-004: clusters (layer 1 in cluster), context (layer 2), 0G-vault-backed reasoning (layer 3).
import { describe, expect, it } from "vitest";
import { keccakUtf8 } from "@proofwork/crypto";
import type { Reasoner } from "../src/review/reasoning.ts";
import { distStats, percentileBps, slope, zMilli } from "../src/review/stats.ts";
import { expectNoViolations, login, testApp } from "./helpers.ts";

const C1 = "cyc_2026h2";

async function populated(reasoner?: Reasoner | null) {
  const app = await testApp({}, reasoner === undefined ? {} : { reasoner });
  const hr = await login(app, "p_hr");
  for (const step of ["s1_collect_baseline", "s5_cluster_context"]) {
    const r = await app.inject({ method: "POST", url: "/v1/dev/inject", headers: hr, payload: { step_id: step } });
    expect(r.statusCode).toBe(200);
  }
  await app.svc.replica.flush();
  return { app, hr };
}

/** A fake 0G reasoner returning a fixed answer (to exercise the number check and the retry). */
const fakeReasoner = (answers: string[]): Reasoner & { calls: number } => {
  const r = {
    mode: "live" as const,
    calls: 0,
    async complete(system: string, user: string) {
      const output = answers[Math.min(r.calls, answers.length - 1)];
      r.calls++;
      return {
        output,
        provider: "0xf4FB8d2bD856e672b5f9848b0eD235A20079B250",
        record: { provider: "0g_private_computer" as const, model: "fake", mode: "live" as const, request_id: `req-${r.calls}`, zg_res_key: null, tee_verified: null, prompt_hash: keccakUtf8(system + user), output_hash: keccakUtf8(output), created_at: "2026-11-06T10:00:00.000Z" },
      };
    },
  };
  return r;
};

const answer = (summary: string) =>
  JSON.stringify({
    headline: "Ben Carter is above the Software Engineer · IC median",
    summary,
    strengths: ["Planned deliverables shipped above target."],
    concerns: [],
    peer_comparison: null,
    recommendation: { bonus_position: "above_cluster", promotion_readiness: "on_track", rationale: "Above the cluster median." },
    talking_points: ["Keep the delivery pace."],
    citations: [{ statement: "Deliverables above target.", refs: ["layer1.kras"] }],
  });

describe("stats", () => {
  it("integer statistics", () => {
    expect(distStats([1, 2, 3, 4])).toEqual({ n: 4, mean: 3, median: 3, p25: 2, p75: 3, min: 1, max: 4, stdev: 1 });
    expect(percentileBps([10, 20, 30, 40], 30)).toBe(6250);
    expect(zMilli([10, 10, 10], 10)).toBe(0);
    expect(slope([9400, 8600, 7800])).toBe(-800);
  });
});

describe("clusters (layer 1 inside a cluster)", () => {
  it("lists five clusters with five or more members, each on its own plan", async () => {
    const { app, hr } = await populated();
    const r = await app.inject({ method: "GET", url: "/v1/clusters", headers: hr });
    expect(r.statusCode).toBe(200);
    const items = r.json().items;
    expect(items.map((c: any) => c.cluster_id).sort()).toEqual(["marketing.ic", "product.ic", "sales.ic", "software.ic", "software.senior_ic"]);
    for (const c of items) expect(c.member_count).toBeGreaterThanOrEqual(5);
    expect(items.find((c: any) => c.cluster_id === "software.ic").plan_id).toBe("pln_eng_ic_v1");
    expectNoViolations(app);
  });

  it("ranks the Software IC cluster with the IC plan; HR sees names, an employee sees only themself", async () => {
    const { app, hr } = await populated();
    const b = (await app.inject({ method: "GET", url: `/v1/clusters/software.ic/board?cycle_id=${C1}`, headers: hr })).json();
    expect(b.plan_id).toBe("pln_eng_ic_v1");
    expect(b.rows).toHaveLength(6);
    expect(b.rows[0].rank).toBe(1);
    expect(b.rows.map((x: any) => x.score_bps)).toEqual([...b.rows.map((x: any) => x.score_bps)].sort((a: number, c: number) => c - a));
    expect(b.rows.every((x: any) => x.employee_id)).toBe(true);
    expect(b.score_stats.n).toBe(6);

    const ben = await login(app, "p_dev_b");
    const eb = (await app.inject({ method: "GET", url: `/v1/clusters/software.ic/board?cycle_id=${C1}`, headers: ben })).json();
    expect(eb.rows.filter((x: any) => x.employee_id !== null).map((x: any) => x.employee_id)).toEqual(["emp_dev_b"]);
    expect(eb.rows.find((x: any) => x.is_self).display_name).toBe("Ben Carter");
    // an IC cannot open the Senior cluster
    expect((await app.inject({ method: "GET", url: `/v1/clusters/software.senior_ic/board?cycle_id=${C1}`, headers: ben })).statusCode).toBe(404);
    expectNoViolations(app);
  });

  it("board hash is deterministic", async () => {
    const { app, hr } = await populated();
    const a = (await app.inject({ method: "GET", url: `/v1/clusters/sales.ic/board?cycle_id=${C1}`, headers: hr })).json();
    const b = (await app.inject({ method: "GET", url: `/v1/clusters/sales.ic/board?cycle_id=${C1}`, headers: hr })).json();
    expect(a.board_hash).toBe(b.board_hash);
  });
});

describe("context (layer 2)", () => {
  it("reads three past periods, deadlines and trend; flags a slipping engineer", async () => {
    const { app, hr } = await populated();
    const leo = (await app.inject({ method: "GET", url: `/v1/employees/emp_ic_leo/context?cycle_id=${C1}`, headers: hr })).json();
    expect(leo.history.map((h: any) => h.score_bps)).toEqual([9400, 8600, 7800]);
    expect(leo.history[0].rating).toBe("meets");
    expect(leo.trend_bps_per_period).toBeLessThan(0);
    expect(leo.signals.map((s: any) => s.code)).toEqual(expect.arrayContaining(["declining", "deadline_risk"]));
    const dev = (await app.inject({ method: "GET", url: `/v1/employees/emp_ic_dev/context?cycle_id=${C1}`, headers: hr })).json();
    expect(dev.signals.map((s: any) => s.code)).toEqual(expect.arrayContaining(["improving", "deadline_reliable"]));
    expect(dev.cluster_position.rank).toBe(1);
    expectNoViolations(app);
  });

  it("history and deadline evidence never change a score", async () => {
    const app = await testApp();
    const hr = await login(app, "p_hr");
    await app.inject({ method: "POST", url: "/v1/dev/inject", headers: hr, payload: { step_id: "s1_collect_baseline" } });
    const before = (await app.inject({ method: "POST", url: "/v1/scores/compute", headers: hr, payload: { plan_id: "pln_eng_v1", employee_id: "emp_dev_a", cycle_id: C1 } })).json();
    await app.inject({ method: "POST", url: "/v1/dev/inject", headers: hr, payload: { step_id: "s5_cluster_context" } });
    const after = (await app.inject({ method: "POST", url: "/v1/scores/compute", headers: hr, payload: { plan_id: "pln_eng_v1", employee_id: "emp_dev_a", cycle_id: C1 } })).json();
    expect(after.score_bps).toBe(before.score_bps);
    expect(after.multiplier_bps).toBe(before.multiplier_bps);
  });
});

describe("reviews (layer 3)", () => {
  it("mock reasoning: vault read back, every commitment recomputed, numbers all supported, hashes set", async () => {
    const { app, hr } = await populated(null);
    const r = await app.inject({ method: "POST", url: "/v1/reviews", headers: hr, payload: { employee_id: "emp_dev_b", cycle_id: C1, peer_employee_id: "emp_ic_dev" } });
    expect(r.statusCode).toBe(201);
    const v = r.json();
    expect(v.reasoning_source).toBe("mock");
    expect(v.number_check.passed).toBe(true);
    expect(v.vault.items_total).toBeGreaterThan(20);
    expect(v.vault.commitments_failed).toBe(0);
    expect(v.vault.commitments_matched).toBe(v.vault.items_total);
    expect(v.vault.from_0g).toBe(v.vault.items_total); // read back from the (local) replica, not the DB
    expect(v.peer.peer_display_name).toBe("Dev Patel");
    expect(v.hashes.review_hash).toMatch(/^0x[0-9a-f]{64}$/);
    // anchor (mock chain), idempotent
    const a1 = (await app.inject({ method: "POST", url: `/v1/reviews/${v.review_id}/anchor`, headers: hr })).json();
    const a2 = (await app.inject({ method: "POST", url: `/v1/reviews/${v.review_id}/anchor`, headers: hr })).json();
    expect(a1.anchor.numeric_batch_id).toBeGreaterThanOrEqual(1_000_000_000);
    expect(a2.anchor.tx_hash).toBe(a1.anchor.tx_hash);
    expect(await app.svc.chain.batchRoot(BigInt(a1.anchor.numeric_batch_id))).toBe(v.hashes.review_hash);
    // the employee can read their own review; another IC cannot
    const ben = await login(app, "p_dev_b");
    expect((await app.inject({ method: "GET", url: `/v1/reviews/${v.review_id}`, headers: ben })).statusCode).toBe(200);
    const chen = await login(app, "p_dev_c");
    expect((await app.inject({ method: "GET", url: `/v1/reviews/${v.review_id}`, headers: chen })).statusCode).toBe(404);
    expectNoViolations(app);
  });

  it("concurrent anchor calls for one review send one transaction (shared chain-write lock)", async () => {
    const { app, hr } = await populated(null);
    const v = (await app.inject({ method: "POST", url: "/v1/reviews", headers: hr, payload: { employee_id: "emp_dev_b", cycle_id: C1, peer_employee_id: "emp_ic_dev" } })).json();
    // A real chain is slow: make each read/write take a moment so the two requests genuinely overlap.
    const chain = app.svc.chain as any;
    for (const m of ["batchRoot", "anchorBatch"]) {
      const orig = chain[m].bind(chain);
      chain[m] = async (...args: unknown[]) => (await new Promise((r) => setTimeout(r, 25)), orig(...args));
    }
    const [a, b] = await Promise.all([
      app.inject({ method: "POST", url: `/v1/reviews/${v.review_id}/anchor`, headers: hr }),
      app.inject({ method: "POST", url: `/v1/reviews/${v.review_id}/anchor`, headers: hr }),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(b.json().anchor.tx_hash).toBe(a.json().anchor.tx_hash);
    expect(b.json().anchor.numeric_batch_id).toBe(a.json().anchor.numeric_batch_id);
    expect(await app.svc.chain.batchRoot(BigInt(a.json().anchor.numeric_batch_id + 1))).toBe("0x" + "00".repeat(32));
  });

  it("never compares across clusters (IC vs Senior -> 409 cluster_mismatch)", async () => {
    const { app, hr } = await populated(null);
    const r = await app.inject({ method: "POST", url: "/v1/reviews", headers: hr, payload: { employee_id: "emp_dev_b", cycle_id: C1, peer_employee_id: "emp_dev_a" } });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("cluster_mismatch");
  });

  it("0G answer with an invented number is rejected; the retry is accepted", async () => {
    const fake = fakeReasoner([answer("Ben shipped 9999 deliverables."), answer("Ben is above the cluster median.")]);
    const { app, hr } = await populated(fake);
    const v = (await app.inject({ method: "POST", url: "/v1/reviews", headers: hr, payload: { employee_id: "emp_dev_b", cycle_id: C1 } })).json();
    expect(fake.calls).toBe(2);
    expect(v.reasoning_source).toBe("0g_private_computer");
    expect(v.number_check).toMatchObject({ passed: true, attempts: 2 });
    expect(v.inference_provider).toBe("0xf4FB8d2bD856e672b5f9848b0eD235A20079B250");
    expectNoViolations(app);
  });

  it("two bad 0G answers -> labelled deterministic fallback, never an unchecked number", async () => {
    const fake = fakeReasoner([answer("Ben shipped 9999 deliverables."), "not json"]);
    const { app, hr } = await populated(fake);
    const v = (await app.inject({ method: "POST", url: "/v1/reviews", headers: hr, payload: { employee_id: "emp_dev_b", cycle_id: C1 } })).json();
    expect(v.reasoning_source).toBe("deterministic_fallback");
    expect(v.fallback_reason).toMatch(/JSON|packet/);
    expect(v.number_check.passed).toBe(true);
  });

  it("only HR or the manager prepares a review; only HR anchors", async () => {
    const { app } = await populated(null);
    const ben = await login(app, "p_dev_b");
    expect((await app.inject({ method: "POST", url: "/v1/reviews", headers: ben, payload: { employee_id: "emp_dev_b", cycle_id: C1 } })).statusCode).toBe(403);
    const mgr = await login(app, "p_eng_mgr");
    const v = (await app.inject({ method: "POST", url: "/v1/reviews", headers: mgr, payload: { employee_id: "emp_dev_c", cycle_id: C1 } })).json();
    expect((await app.inject({ method: "POST", url: `/v1/reviews/${v.review_id}/anchor`, headers: mgr })).statusCode).toBe(403);
  });
});
