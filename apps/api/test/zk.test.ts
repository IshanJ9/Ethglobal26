import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bindingOf, poseidonCommit } from "../src/zk/zk.ts";
import { expectNoViolations, login, testApp } from "./helpers.ts";

const require = createRequire(import.meta.url);
const snarkjs = require("snarkjs");
const ZK = join(__dirname, "../../web/public/zk");
const world = (a: any) => ({ adapter: "mock", payload: { action: a.world_action, signal: a.challenge, nullifier: "0x" + randomBytes(32).toString("hex") } });

async function approved() {
  const app = await testApp();
  const hr = await login(app, "p_hr");
  const mgr = await login(app, "p_eng_mgr");
  const asha = await login(app, "p_dev_a");
  const ben = await login(app, "p_dev_b");
  await app.inject({ method: "POST", url: "/v1/dev/inject", headers: hr, payload: { step_id: "s1_collect_baseline" } });
  const sc = (await app.inject({ method: "POST", url: "/v1/scorecards", headers: mgr, payload: { employee_id: "emp_dev_a", cycle_id: "cyc_2026h2" } })).json();
  return { app, hr, mgr, asha, ben, sc };
}

describe("zero-knowledge score proofs", () => {
  it("Poseidon commitment matches circomlib and binds to the scorecard id", async () => {
    const c = await poseidonCommit(9071n, 42n, bindingOf("scd_x"));
    expect(c).toBe(await poseidonCommit(9071n, 42n, bindingOf("scd_x")));
    expect(c).not.toBe(await poseidonCommit(9071n, 42n, bindingOf("scd_y")));
    expect(bindingOf("scd_x") < 2n ** 248n).toBe(true);
  });

  it("only approved scorecards; only HR/manager commits; only the employee reads the witness; the proof verifies against the anchored root", async () => {
    const { app, hr, mgr, asha, ben, sc } = await approved();
    const url = `/v1/scorecards/${sc.scorecard_id}`;
    expect((await app.inject({ method: "POST", url: `${url}/zk-commit`, headers: mgr })).statusCode).toBe(409); // draft
    const a = (await app.inject({ method: "POST", url: "/v1/approvals", headers: mgr, payload: { scorecard_id: sc.scorecard_id } })).json();
    expect((await app.inject({ method: "POST", url: `/v1/approvals/${a.approval_id}/complete`, headers: mgr, payload: { decision: "approve", world_result: world(a) } })).statusCode).toBe(200);

    expect((await app.inject({ method: "POST", url: `${url}/zk-commit`, headers: asha })).statusCode).toBe(403); // employee cannot commit own score
    expect((await app.inject({ method: "POST", url: `${url}/zk-commit`, headers: ben })).statusCode).toBe(404); // peer cannot see it
    expect((await app.inject({ method: "GET", url: `${url}/zk-commit`, headers: hr })).statusCode).toBe(404); // not yet

    const z = (await app.inject({ method: "POST", url: `${url}/zk-commit`, headers: hr })).json();
    expect(z.numeric_batch_id).toBeGreaterThanOrEqual(2_000_000_000);
    const again = (await app.inject({ method: "POST", url: `${url}/zk-commit`, headers: mgr })).json();
    expect(again.tx_hash).toBe(z.tx_hash); // idempotent
    expect(await app.svc.chain.batchRoot(BigInt(z.numeric_batch_id))).toBe(z.commitment_hex);

    expect((await app.inject({ method: "GET", url: `${url}/zk-witness`, headers: hr })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: `${url}/zk-witness`, headers: mgr })).statusCode).toBe(403);
    const w = (await app.inject({ method: "GET", url: `${url}/zk-witness`, headers: asha })).json();
    expect(w.commitment).toBe(z.commitment);
    expect(BigInt(w.commitment)).toBe(await poseidonCommit(BigInt(w.score_bps), BigInt(w.salt), bindingOf(sc.scorecard_id)));

    const threshold = Math.max(0, w.score_bps - 500);
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      { score: w.score_bps, salt: w.salt, binding: w.binding, commitment: w.commitment, threshold }, join(ZK, "score_threshold.wasm"), join(ZK, "score_threshold.zkey"));
    const vkey = require(join(ZK, "vkey.json"));
    expect(await snarkjs.groth16.verify(vkey, publicSignals, proof)).toBe(true);
    expect(BigInt(publicSignals[0])).toBe(BigInt(z.commitment_hex));
    const forged = [...publicSignals]; forged[1] = String(w.score_bps + 1);
    expect(await snarkjs.groth16.verify(vkey, forged, proof)).toBe(false);
    await expect(snarkjs.groth16.fullProve(
      { score: w.score_bps, salt: w.salt, binding: w.binding, commitment: w.commitment, threshold: w.score_bps + 1 }, join(ZK, "score_threshold.wasm"), join(ZK, "score_threshold.zkey"))).rejects.toThrow();
    expectNoViolations(app);
  }, 60_000);
});
