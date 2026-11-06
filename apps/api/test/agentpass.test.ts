// World ID Agent Pass: a fake World IdP (real RS256 keys, JWKS, device grant) exercising approval and every denial.
import { describe, expect, it } from "vitest";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { expectNoViolations, login, testApp, TestClock } from "./helpers.ts";

const ISS = "https://auth.world.org";
const CID = "app_test_client";
const ORB = "https://world.org/oidc/acr/orb";
const C1 = "cyc_2026h2";

type Answer = Record<string, unknown>;

async function fakeIdp(clock: TestClock) {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
  const jwks = createLocalJWKSet({ keys: [jwk] });
  const script = new Map<string, Answer[]>();
  let n = 0;
  const idToken = (claims: Answer) => {
    const now = Math.floor(clock.now().getTime() / 1000);
    return new SignJWT({ auth_time: now, acr: ORB, amr: ["pop"], ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(ISS)
      .setAudience(CID)
      .setSubject(String(claims.sub ?? "world-human-1"))
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(privateKey);
  };
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  const http = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/.well-known/openid-configuration")) {
      return json({ issuer: ISS, device_authorization_endpoint: `${ISS}/api/v1/device_authorization`, token_endpoint: `${ISS}/api/v1/token`, jwks_uri: `${ISS}/jwks` });
    }
    expect(String((init?.headers as Record<string, string>).authorization)).toMatch(/^Basic /);
    if (u.endsWith("/device_authorization")) {
      const body = new URLSearchParams(String(init?.body));
      expect(JSON.parse(body.get("claims")!).id_token.acr.essential).toBe(true);
      const dc = `dc_${++n}`;
      script.set(dc, []);
      return json({ device_code: dc, user_code: `ABCD-${n}`, verification_uri: "https://world.org/activate", verification_uri_complete: `https://world.org/activate?code=ABCD-${n}`, expires_in: 600, interval: 5 });
    }
    if (u.endsWith("/token")) {
      const dc = new URLSearchParams(String(init?.body)).get("device_code")!;
      const next = script.get(dc)!.shift() ?? { error: "authorization_pending" };
      if ("token" in next) return json({ id_token: await idToken(next.token as Answer), token_type: "Bearer" });
      return json(next, 400);
    }
    throw new Error("unexpected " + u);
  }) as typeof fetch;
  return { http, jwks, push: (a: Answer) => script.get(`dc_${n}`)!.push(a) };
}

async function setup() {
  const clock = new TestClock();
  const idp = await fakeIdp(clock);
  const app = await testApp(
    { AGENT_PASS_MODE: "live", WORLD_IDP_CLIENT_ID: CID, WORLD_IDP_CLIENT_SECRET: "worldidp_client_secret_test" },
    { clock, agentPassHttp: idp.http, agentPassJwks: idp.jwks },
  );
  const hr = await login(app, "p_hr");
  for (const step of ["s1_collect_baseline", "s5_cluster_context"]) await app.inject({ method: "POST", url: "/v1/dev/inject", headers: hr, payload: { step_id: step } });
  await app.svc.replica.flush();
  const op = { kind: "review.generate", employee_id: "emp_dev_b", cycle_id: C1, peer_employee_id: null };
  const start = async (h = hr, operation: Answer = op) => app.inject({ method: "POST", url: "/v1/agent-pass/checkpoints", headers: h, payload: { operation } });
  const poll = async (id: string, h = hr) => {
    clock.advance(6000);
    return (await app.inject({ method: "GET", url: `/v1/agent-pass/checkpoints/${id}`, headers: h })).json();
  };
  const review = async (cp: string | null, h = hr, peer: string | null = null) =>
    app.inject({ method: "POST", url: "/v1/reviews", headers: h, payload: { employee_id: "emp_dev_b", cycle_id: C1, peer_employee_id: peer, agent_pass_checkpoint_id: cp } });
  return { app, clock, idp, hr, start, poll, review };
}

describe("World ID Agent Pass (human checkpoint for the review agent)", () => {
  it("blocks the agent until an Orb-verified human approves exactly this operation; one use only", async () => {
    const { app, idp, hr, start, poll, review } = await setup();
    expect((await app.inject({ method: "GET", url: "/v1/config/public" })).json().agent_pass_mode).toBe("live");

    const none = await review(null);
    expect(none.statusCode).toBe(401);
    expect(none.json().error.details.reason).toBe("agent_pass_required");

    const cp = (await start()).json();
    expect(cp.status).toBe("pending");
    expect(cp.user_code).toBe("ABCD-1");
    expect(cp.agent).toContain("review-agent");
    expect((await review(cp.checkpoint_id)).statusCode).toBe(401); // still pending

    idp.push({ error: "authorization_pending" });
    idp.push({ token: { sub: "world-human-hr" } });
    expect((await poll(cp.checkpoint_id)).status).toBe("pending");
    const ok = await poll(cp.checkpoint_id);
    expect(ok.status).toBe("approved");
    expect(ok.world).toMatchObject({ iss: ISS, acr: ORB, enrolled: true });
    expect(ok.user_code).toBeNull();

    // a different operation (another peer) cannot use this approval, and does not consume it
    const other = await review(cp.checkpoint_id, hr, "emp_dev_c");
    expect(other.statusCode).toBe(401);
    expect(other.json().error.message).toMatch(/different operation/);

    const r = await review(cp.checkpoint_id);
    expect(r.statusCode).toBe(201);
    expect(r.json().agent_pass).toMatchObject({ checkpoint_id: cp.checkpoint_id, acr: ORB });
    const again = await review(cp.checkpoint_id);
    expect(again.statusCode).toBe(401);
    expect(again.json().error.message).toMatch(/already used/);

    // the same human again: accepted (linked identity matches), not re-enrolled
    const cp2 = (await start()).json();
    idp.push({ token: { sub: "world-human-hr" } });
    expect((await poll(cp2.checkpoint_id)).world.enrolled).toBe(false);
    expectNoViolations(app);
  }, 60_000);

  it("denies: wrong World ID, non-Orb class, stale authentication, declined, expired, cancelled, wrong persona, stale approval", async () => {
    const { app, clock, idp, hr, start, poll, review } = await setup();
    const decide = async (answer: Answer) => {
      const cp = (await start()).json();
      idp.push(answer);
      return poll(cp.checkpoint_id);
    };
    expect((await decide({ token: { sub: "world-human-hr" } })).status).toBe("approved"); // links HR's World ID

    const wrong = await decide({ token: { sub: "someone-else" } });
    expect(wrong.status).toBe("denied");
    expect(wrong.reason).toMatch(/different World ID/);

    const device = await decide({ token: { sub: "world-human-hr", acr: "https://world.org/oidc/acr/device" } });
    expect(device.reason).toMatch(/Orb-verified human is required/);

    const stale = await decide({ token: { sub: "world-human-hr", auth_time: Math.floor(clock.now().getTime() / 1000) - 3600 } });
    expect(stale.reason).toMatch(/older than this checkpoint/);

    expect((await decide({ error: "access_denied" })).status).toBe("denied");

    const late = (await start()).json();
    clock.advance(601_000);
    expect((await poll(late.checkpoint_id)).status).toBe("expired");

    const cancelled = (await start()).json();
    expect((await app.inject({ method: "POST", url: `/v1/agent-pass/checkpoints/${cancelled.checkpoint_id}/cancel`, headers: hr })).json().status).toBe("cancelled");
    expect((await review(cancelled.checkpoint_id)).statusCode).toBe(401);

    // an employee cannot authorize the agent, nor see HR's checkpoint
    const ben = await login(app, "p_dev_b");
    expect((await start(ben)).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: `/v1/agent-pass/checkpoints/${cancelled.checkpoint_id}`, headers: ben })).statusCode).toBe(404);

    // HR's World ID cannot be linked to a second account
    const mgr = await login(app, "p_eng_mgr");
    const m = (await start(mgr)).json();
    idp.push({ token: { sub: "world-human-hr" } });
    expect((await poll(m.checkpoint_id, mgr)).reason).toMatch(/already linked to another account/);

    // an approval older than 10 minutes cannot be used
    const cp = (await start()).json();
    idp.push({ token: { sub: "world-human-hr" } });
    expect((await poll(cp.checkpoint_id)).status).toBe("approved");
    clock.advance(11 * 60_000);
    expect((await review(cp.checkpoint_id)).json().error.message).toMatch(/older than 10 minutes/);
    expectNoViolations(app);
  }, 60_000);
});
