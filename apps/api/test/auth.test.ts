import { describe, expect, it } from "vitest";
import { CONNECTOR, expectNoViolations, login, testApp } from "./helpers.ts";

describe("auth + ABAC", () => {
  it("dev login returns a token and /v1/me the persona", async () => {
    const app = await testApp();
    const h = await login(app, "p_dev_a");
    const me = await app.inject({ method: "GET", url: "/v1/me", headers: h });
    expect(me.statusCode).toBe(200);
    expect(me.json().persona_id).toBe("p_dev_a");
    expect((await app.inject({ method: "GET", url: "/v1/me" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/v1/me", headers: { authorization: "Bearer nope" } })).statusCode).toBe(401);
    expectNoViolations(app);
  });

  it("n18: dev endpoints are off when AUTH_MODE=sso", async () => {
    const app = await testApp({ AUTH_MODE: "sso" });
    expect((await app.inject({ method: "POST", url: "/v1/dev/login", payload: { persona_id: "p_dev_a" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/v1/dev/inject", payload: { step_id: "s1_collect_baseline" } })).statusCode).toBe(404);
  });

  it("employees list follows the permission matrix", async () => {
    const app = await testApp();
    const ids = async (p: string) =>
      (await app.inject({ method: "GET", url: "/v1/org/employees", headers: await login(app, p) })).json().items.map((e: any) => e.employee_id).sort();
    expect(await ids("p_dev_a")).toEqual(["emp_dev_a"]);
    expect(await ids("p_eng_mgr")).toEqual(["emp_dev_a", "emp_dev_b", "emp_dev_c", "emp_eng_mgr"]);
    expect(await ids("p_hr")).toHaveLength(8);
    expect(await ids("p_client_cfo")).toEqual([]);
    expectNoViolations(app);
  });

  it("n16: cross-user evidence access is 404, not 403", async () => {
    const app = await testApp();
    await app.inject({ method: "POST", url: "/v1/dev/inject", payload: { step_id: "s1_collect_baseline" }, headers: await login(app, "p_hr") });
    const a = await login(app, "p_dev_a");
    const b = await login(app, "p_dev_b");
    const mine = (await app.inject({ method: "GET", url: "/v1/evidence", headers: a })).json().items;
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((e: any) => e.employee_id === "emp_dev_a")).toBe(true);
    const other = await app.inject({ method: "GET", url: `/v1/evidence/${mine[0].evidence_id}`, headers: b });
    expect(other.statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/v1/evidence?employee_id=emp_dev_a", headers: b })).statusCode).toBe(404);
    const mgr = await app.inject({ method: "GET", url: `/v1/evidence/${mine[0].evidence_id}`, headers: await login(app, "p_eng_mgr") });
    expect(mgr.statusCode).toBe(200);
    const salesMgr = await app.inject({ method: "GET", url: `/v1/evidence/${mine[0].evidence_id}`, headers: await login(app, "p_sales_mgr") });
    expect(salesMgr.statusCode).toBe(404);
    expectNoViolations(app);
  });

  it("plans, cycles, public config", async () => {
    const app = await testApp();
    const h = await login(app, "p_dev_a");
    expect((await app.inject({ method: "GET", url: "/v1/org/plans", headers: h })).json().items).toHaveLength(3);
    expect((await app.inject({ method: "GET", url: "/v1/org/plans/pln_eng_v1", headers: h })).json().formula_hash).toMatch(/^0x/);
    expect((await app.inject({ method: "GET", url: "/v1/org/plans/nope", headers: h })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/v1/cycles", headers: h })).json().items.map((c: any) => c.numeric_id)).toEqual([1, 2]);
    expectNoViolations(app);
  });

  it("audit: HR sees all entries, others only their own; cursor pagination", async () => {
    const app = await testApp();
    await login(app, "p_dev_a");
    await app.inject({
      method: "POST",
      url: "/v1/evidence/ingest",
      payload: { employee_id: "emp_dev_a", cycle_id: "cyc_2026h2", source: "github", kind: "pr_merged", ref: "x", observed_at: "2026-12-01T00:00:00Z", observations: [] },
      headers: CONNECTOR,
    });
    const hr = await login(app, "p_hr");
    const all = (await app.inject({ method: "GET", url: "/v1/audit", headers: hr })).json();
    expect(all.items.length).toBe(3);
    const page = (await app.inject({ method: "GET", url: "/v1/audit?limit=2", headers: hr })).json();
    expect(page.items).toHaveLength(2);
    const next = (await app.inject({ method: "GET", url: `/v1/audit?limit=2&cursor=${page.next_cursor}`, headers: hr })).json();
    expect(next.items[0].seq).toBe(3);
    expect(next.next_cursor).toBeNull();
    const dev = (await app.inject({ method: "GET", url: "/v1/audit", headers: await login(app, "p_dev_a") })).json();
    expect(dev.items.every((e: any) => e.actor === "p_dev_a")).toBe(true);
    expectNoViolations(app);
  });
});
