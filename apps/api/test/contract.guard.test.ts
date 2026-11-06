import { describe, expect, it } from "vitest";
import { loadContract } from "../src/contract/openapi.ts";
import { expectNoViolations, login, testApp } from "./helpers.ts";

describe("meta routes", () => {
  it("GET /healthz returns spec_version and the X-Spec-Version header", async () => {
    const app = await testApp();
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, spec_version: "1.0.0" });
    expect(res.headers["x-spec-version"]).toBe("1.0.0");
    expect(app.contractGuard.violations).toEqual([]);
  });

  it("GET /v1/config/public validates and uses the registry as verifyingContract", async () => {
    const app = await testApp();
    const res = await app.inject({ method: "GET", url: "/v1/config/public" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(loadContract().schema("PublicConfig")(body)).toBe(true);
    expect(body.chain_mode).toBe("mock");
    expect(body.world_mode).toBe("mock");
    expect(body.zerog_mode).toBe("mock");
    expect(body.eip712_domain).toEqual({
      name: "Proofwork",
      version: "1",
      chainId: 31337,
      verifyingContract: body.contracts.registry,
    });
    expect(app.contractGuard.violations).toEqual([]);
  });

  it("unknown route -> 404 Error shape", async () => {
    const app = await testApp();
    const res = await app.inject({ method: "GET", url: "/v1/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
    expect(res.headers["x-spec-version"]).toBe("1.0.0");
  });
});

describe("contract guard", () => {
  // Stand-in handler on a real spec route, so the guard's validators are exercised before the
  // real implementation lands. `mode` lets a test force a non-conforming response.
  async function appWithLogin(mode: "good" | "bad") {
    // AUTH_MODE=sso leaves /v1/dev/login unregistered, so a stand-in handler can occupy the spec route.
    const app = await testApp({ AUTH_MODE: "sso" });
    app.post("/v1/dev/login", async () =>
      mode === "good"
        ? {
            token: "t",
            persona: {
              persona_id: "p_dev_a",
              employee_id: "emp_dev_a",
              display_name: "Asha Rao",
              role: "employee",
              department: "software",
              wallet_address: "0xe0A6B36D1381B1844A569acecde5501cA3Aca9c1",
            },
          }
        : { token: 5, extra: true },
    );
    return app;
  }

  it("rejects unknown request fields with 400 unknown_field", async () => {
    const app = await appWithLogin("good");
    const res = await app.inject({ method: "POST", url: "/v1/dev/login", payload: { persona_id: "p_dev_a", sneaky: 1 } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: "unknown_field", details: { fields: ["sneaky"] } });
  });

  it("rejects schema-invalid bodies with 400 validation_failed", async () => {
    const app = await appWithLogin("good");
    const res = await app.inject({ method: "POST", url: "/v1/dev/login", payload: { persona_id: "p_nobody" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_failed");
  });

  it("rejects a missing required body with 400 bad_request", async () => {
    const app = await appWithLogin("good");
    const res = await app.inject({ method: "POST", url: "/v1/dev/login", headers: { "content-type": "application/json" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("bad_request");
  });

  it("rejects malformed JSON with 400 bad_request", async () => {
    const app = await appWithLogin("good");
    const res = await app.inject({
      method: "POST",
      url: "/v1/dev/login",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("bad_request");
  });

  it("passes a conforming response through untouched", async () => {
    const app = await appWithLogin("good");
    const res = await app.inject({ method: "POST", url: "/v1/dev/login", payload: { persona_id: "p_dev_a" } });
    expect(res.statusCode).toBe(200);
    expect(app.contractGuard.violations).toEqual([]);
  });

  it("catches a non-conforming response (drift) and records a violation", async () => {
    const app = await appWithLogin("bad");
    const res = await app.inject({ method: "POST", url: "/v1/dev/login", payload: { persona_id: "p_dev_a" } });
    expect(res.statusCode).toBe(500);
    expect(res.json().error.message).toBe("response contract violation");
    expect(app.contractGuard.violations).toHaveLength(1);
  });

  it("rejects unknown query parameters and coerces known ones", async () => {
    const app = await testApp();
    const h = await login(app, "p_hr");
    const res = await app.inject({ method: "GET", url: "/v1/audit?limit=5&evil=1", headers: h });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("unknown_field");
    const bad = await app.inject({ method: "GET", url: "/v1/audit?limit=500", headers: h });
    expect(bad.json().error.code).toBe("validation_failed");
    const ok = await app.inject({ method: "GET", url: "/v1/audit?limit=5", headers: h });
    expect(ok.statusCode).toBe(200);
    expectNoViolations(app);
  });

  it("authentication runs before validation (401, not 400)", async () => {
    const app = await testApp();
    const res = await app.inject({ method: "POST", url: "/v1/claims", payload: { junk: 1 } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthorized");
  });

  it("refuses to register a route that is not in the spec", async () => {
    const app = await testApp();
    expect(() => app.get("/v1/not-in-spec", async () => ({}))).toThrow(/not in spec/);
    expect(() => app.get("/internal/debug", async () => ({}))).not.toThrow();
  });

  it("every spec operation has a compiled validator", () => {
    const c = loadContract();
    expect(c.operations.size).toBe(45);
    for (const op of c.operations.values()) expect(op.responses.size).toBeGreaterThan(0);
  });
});
