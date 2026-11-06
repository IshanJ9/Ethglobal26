import { describe, expect, it } from "vitest";
import type { EnsLookup } from "../src/ens/resolver.ts";
import { personaLabel } from "../src/ens/resolver.ts";
import { expectNoViolations, login, personaAccount, testApp } from "./helpers.ts";

const AGENT = "0x93a7931e4F6A1F124d438FA3fAB7E5d814A52A58";
const ENS = { ENS_NETWORK: "sepolia", ENS_PARENT_NAME: "proofwork-demo.eth", AGENT_ENS_NAME: "kra-agent", AGENT_ADDRESS: AGENT };

/** Fake ENS: asha and the agent resolve correctly; ben resolves to someone else's wallet; the rest are unset. */
function fakeEns(agentTarget = AGENT): EnsLookup {
  const records: Record<string, string> = {
    "kra-agent.proofwork-demo.eth": agentTarget,
    "asha.proofwork-demo.eth": personaAccount("p_dev_a").address,
    "ben.proofwork-demo.eth": personaAccount("p_dev_c").address,
  };
  return {
    address: async (n) => (records[n] as `0x${string}`) ?? null,
    text: async (n, k) => (n.startsWith("kra-agent.") ? ({ role: "evidence-agent", policy: "0xpolicy" } as Record<string, string>)[k] ?? null : null),
  };
}

describe("ENS (forward-checked names only)", () => {
  it("labels come from first names", () => {
    expect(personaLabel("Asha Rao")).toBe("asha");
    expect(personaLabel("Karan Shah (CFO, Acme Bank)")).toBe("karan");
  });

  it("shows the agent subname and verified people only, in config, /me, employees and run traces", async () => {
    const app = await testApp(ENS, { ens: fakeEns() });
    await app.svc.ens.ready;
    expect(app.svc.ens.agent?.text).toEqual({ role: "evidence-agent", policy: "0xpolicy" });

    const cfg = (await app.inject({ method: "GET", url: "/v1/config/public" })).json();
    expect(cfg.agent).toEqual({ ens_name: "kra-agent.proofwork-demo.eth", address: AGENT });
    expect(cfg.ens).toEqual({ network: "sepolia", parent_name: "proofwork-demo.eth" });

    const asha = await login(app, "p_dev_a");
    expect((await app.inject({ method: "GET", url: "/v1/me", headers: asha })).json().ens_name).toBe("asha.proofwork-demo.eth");
    // ben.proofwork-demo.eth points at another wallet: never shown.
    expect((await app.inject({ method: "GET", url: "/v1/me", headers: await login(app, "p_dev_b") })).json().ens_name).toBeNull();

    const mgr = await login(app, "p_eng_mgr");
    const emps = (await app.inject({ method: "GET", url: "/v1/org/employees", headers: mgr })).json().items;
    expect(emps.find((e: any) => e.employee_id === "emp_dev_a").ens_name).toBe("asha.proofwork-demo.eth");
    expect(emps.find((e: any) => e.employee_id === "emp_dev_b").ens_name).toBeNull();

    const start = await app.inject({ method: "POST", url: "/v1/runs", headers: mgr, payload: { employee_id: "emp_dev_c", cycle_id: "cyc_2026h2" } });
    let run: any;
    for (let i = 0; i < 50 && run?.status !== "succeeded"; i++) {
      run = (await app.inject({ method: "GET", url: `/v1/runs/${start.json().run_id}`, headers: mgr })).json();
      if (run.status !== "succeeded") await new Promise((r) => setTimeout(r, 20));
    }
    expect(run.agent_identity).toEqual({ ens_name: "kra-agent.proofwork-demo.eth", address: AGENT, agent_pass: "mock" });
    expectNoViolations(app);
  });

  it("an agent name that resolves to another address is not used", async () => {
    const app = await testApp(ENS, { ens: fakeEns("0x0000000000000000000000000000000000000001") });
    await app.svc.ens.ready;
    expect((await app.inject({ method: "GET", url: "/v1/config/public" })).json().agent.ens_name).toBe("kra-agent");
  });

  it("ENS_NETWORK=none never looks anything up", async () => {
    const app = await testApp({}, { ens: { address: async () => { throw new Error("must not be called"); }, text: async () => null } });
    await app.svc.ens.ready;
    expect((await app.inject({ method: "GET", url: "/v1/me", headers: await login(app, "p_dev_a") })).json().ens_name).toBeNull();
  });
});
