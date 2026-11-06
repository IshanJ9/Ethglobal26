// pnpm spec:check  - the single gate both agents run before every push. Fails loudly on any drift.
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import YAML from "yaml";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { CLAIM_TYPES, formulaHash } from "../packages/crypto/src/index.ts";
import { checkAbi } from "./check-abi.mjs";
import { expandEvent } from "../spec/reference/expand.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => readFileSync(join(root, p), "utf8");
const js = (p) => JSON.parse(rd(p));
let passed = 0;
const ok = (name) => { passed++; console.log("  ok  " + name); };

// 1. version consistency
const api = YAML.parse(rd("spec/openapi.yaml"));
const version = rd("spec/VERSION").trim();
assert.equal(api.info.version, version, "openapi info.version != spec/VERSION");
assert.equal(js("spec/vectors/vectors.json").spec_version, version, "vectors spec_version != spec/VERSION");
ok(`version ${version} consistent (VERSION, openapi, vectors)`);

// 2. openapi: structure + every operation has operationId + all $refs resolve
const ids = new Set(); const refs = [];
const walk = (n) => { if (Array.isArray(n)) n.forEach(walk); else if (n && typeof n === "object") { for (const [k, v] of Object.entries(n)) { if (k === "$ref") refs.push(v); else walk(v); } } };
walk(api);
for (const [p, ops] of Object.entries(api.paths)) for (const [m, op] of Object.entries(ops)) { if (!["get", "post", "patch", "put", "delete"].includes(m)) continue; assert.ok(op.operationId, `${m} ${p} missing operationId`); assert.ok(!ids.has(op.operationId), "duplicate operationId " + op.operationId); ids.add(op.operationId); }
const resolve = (r) => r.replace(/^#\//, "").split("/").reduce((a, k) => a?.[k], api);
for (const r of refs) assert.ok(resolve(r) !== undefined, "unresolved $ref " + r);
ok(`openapi: ${ids.size} operations, ${refs.length} refs resolve`);
try { execFileSync("python3", ["-I", "-c", "import yaml,sys\nfrom openapi_spec_validator import validate\nvalidate(yaml.safe_load(open(sys.argv[1])))", join(root, "spec/openapi.yaml")], { stdio: "pipe" }); ok("openapi-spec-validator (python) passed"); }
catch (e) { if (e.code === "ENOENT" || /No module named/.test(String(e.stderr))) console.log("  --  openapi-spec-validator not installed; skipped (pip install openapi-spec-validator pyyaml)"); else throw new Error("openapi-spec-validator FAILED:\n" + e.stderr); }

// 3. JSON-schema validation of fixtures against openapi components
const ajv = new Ajv2020({ strict: false, allErrors: true }); addFormats(ajv);
ajv.addSchema({ $id: "pw", components: api.components });
const S = (name) => { const v = ajv.getSchema(`pw#/components/schemas/${name}`); assert.ok(v, "schema " + name); return v; };
const check = (name, data, label) => { const v = S(name); if (!v(data)) throw new Error(`${label} fails ${name}: ` + ajv.errorsText(v.errors)); };
const plans = js("spec/fixtures/seed-org.json").plan_ids.map((id) => js(`spec/fixtures/plans/${id}.json`));
for (const p of plans) {
  check("Plan", p, p.plan_id);
  const { formula_hash, ...rest } = p; assert.equal(formulaHash(rest), formula_hash, `${p.plan_id} formula_hash stale - run pnpm gen:fixtures`);
  if (p.kind === "target_attainment") assert.equal(p.kras.reduce((a, k) => a + k.weight_bps, 0), 10000, `${p.plan_id} weights must sum to 10000`);
  for (let i = 1; i < p.payout_curve.length; i++) assert.ok(p.payout_curve[i][0] > p.payout_curve[i - 1][0] && p.payout_curve[i][1] >= p.payout_curve[i - 1][1], `${p.plan_id} curve must be monotone`);
}
ok(`plans: ${plans.length} valid, formula_hash current, weights sum 10000, curves monotone`);
const org = js("spec/fixtures/seed-org.json");
org.personas.forEach((x) => check("Persona", x, x.persona_id)); org.employees.forEach((x) => check("Employee", x, x.employee_id)); org.cycles.forEach((x) => check("Cycle", x, x.cycle_id));
ok(`seed-org: ${org.personas.length} personas, ${org.employees.length} employees, ${org.cycles.length} cycles valid`);
const scen = js("spec/fixtures/seed-scenario.json");
let n = 0;
for (const st of scen.steps) for (const e of st.events) {
  const list = expandEvent(e);
  for (const ev of list) { const { claim_ref, ...rest } = ev; check("EvidenceIngest", rest, st.step_id + ":" + ev.ref); n++; }
}
ok(`seed-scenario: ${n} event templates valid EvidenceIngest; ${scen.negative_tests.length} negative tests, ${scen.scripted_claims.length} scripted claims`);
// CR-004: clusters (one plan per department.level, >= 5 members each) and the s5 population step
const clu = js("spec/fixtures/clusters.json").clusters;
for (const c of clu) {
  assert.ok(org.plan_ids.includes(c.plan_id), `cluster ${c.cluster_id} plan ${c.plan_id} missing`);
  assert.equal(c.cluster_id, `${c.department}.${c.level}`, `cluster id must be department.level`);
  const mem = org.employees.filter((e) => e.department === c.department && e.level === c.level);
  assert.ok(mem.length >= 5, `cluster ${c.cluster_id} has ${mem.length} members (< 5)`);
  for (const m of mem) assert.equal(m.plan_id, c.plan_id, `${m.employee_id} not on cluster plan ${c.plan_id}`);
}
let m5 = 0;
for (const st of js("spec/fixtures/seed-clusters.json").steps) for (const e of st.events) {
  for (const ev of expandEvent(e)) { const { claim_ref, ...rest } = ev; check("EvidenceIngest", rest, st.step_id + ":" + ev.ref); m5++; }
}
ok(`clusters: ${clu.length} valid (one plan each, >= 5 members); seed-clusters: ${m5} events valid EvidenceIngest`);

// 4. reference engine + crypto vs vectors (two languages)
execFileSync("node", [join(root, "spec/reference/verify-engine.mjs")], { stdio: "inherit" }); ok("JS reference engine == Python vectors");
execFileSync("pnpm", ["--filter", "@proofwork/crypto", "test"], { stdio: "pipe", shell: process.platform === "win32" }); ok("TS crypto package == Python vectors (incl. EIP-712 signatures)");

// 4b. generated TS types are current
const gen = execFileSync("npx", ["openapi-typescript", "spec/openapi.yaml"], { cwd: root, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 26, shell: process.platform === "win32" }).toString();
assert.equal(gen.trim(), rd("packages/shared/src/api.d.ts").trim(), "packages/shared/src/api.d.ts is stale - run pnpm gen:types and commit");
ok("packages/shared/src/api.d.ts current");

// 5. eip712.json == crypto package types
assert.deepEqual(js("spec/eip712.json").types, JSON.parse(JSON.stringify(CLAIM_TYPES)), "spec/eip712.json drifted from packages/crypto");
ok("eip712.json matches packages/crypto");

// 6. ABI files match freshly compiled interfaces
execFileSync("node", [join(root, "scripts/compile-abi.mjs")], { stdio: "pipe" });
for (const nme of ["IAttestationRegistry", "IBonusVault"]) { const abi = js(`spec/abi/${nme}.json`); assert.deepEqual(checkAbi(abi, abi), []); }
ok("ABI files regenerate cleanly from spec/solidity");
for (const f of ["deployments/arc.json"]) if (existsSync(join(root, f))) {
  const d = js(f);
  for (const [k, nme] of [["registryAbiFile", "IAttestationRegistry"], ["vaultAbiFile", "IBonusVault"]]) if (d[k]) { const miss = checkAbi(js(d[k]), js(`spec/abi/${nme}.json`)); assert.deepEqual(miss, [], `${nme} deployed ABI missing: ` + miss.join("; ")); ok(`deployed ${nme} ABI conforms`); }
}
console.log(`\nSPEC CHECK PASSED (${passed} groups)`);
