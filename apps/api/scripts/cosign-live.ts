// Live co-sign walkthrough against the running API: an employee drafts a claim (0G Private Computer), signs it,
// submits it, and shares a co-sign link (the claim is sealed to 0G Storage). Then the client opens the link and
// the API serves the claim read back from 0G. Prints the co-sign URL path for the browser.
//   pnpm --filter @proofwork/api exec tsx scripts/cosign-live.ts [scripted_claim_id]
import { keccak256, stringToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { toClaimMessage } from "@proofwork/crypto";
import { seedScenario } from "../src/fixtures.ts";

const API = process.env.API ?? "http://localhost:8787";
const acct = (pid: string) => privateKeyToAccount(keccak256(stringToBytes(`proofwork-demo-persona:${pid}`)));
const S = seedScenario() as any;
const sc = (S.scripted_claims as any[]).find((c) => c.id === process.argv[2]) ?? (S.scripted_claims as any[])[0];
const j = async (r: Response): Promise<any> => { const b: any = await r.json(); if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(b)}`); return b; };

const tok = (await j(await fetch(`${API}/v1/dev/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ persona_id: sc.employee }) }))).token;
const h = { "content-type": "application/json", authorization: `Bearer ${tok}` };
console.log(`1. ${sc.employee} drafts claim "${sc.id}" (0G Private Computer)…`);
const claim = await j(await fetch(`${API}/v1/claims`, { method: "POST", headers: h, body: JSON.stringify({ cycle_id: sc.cycle_id, kra_id: sc.kra_id, raw_text: sc.raw_text, cosigner_address: acct("p_client_cfo").address, cosigner_label: "Acme Bank CFO" }) }));
console.log(`   ${claim.claim_id} drafted by ${claim.inference?.provider} ${claim.inference?.request_id}`);
const pkg = await j(await fetch(`${API}/v1/claims/${claim.claim_id}/signing-package`, { headers: h }));
const td = pkg.typed_data;
const sig = await acct(sc.employee).signTypedData({ domain: td.domain, types: td.types, primaryType: "Claim", message: toClaimMessage(td.message) as any });
await j(await fetch(`${API}/v1/claims/${claim.claim_id}/submit`, { method: "POST", headers: h, body: JSON.stringify({ employee_signature: sig }) }));
console.log("2. signed and submitted");
const grant = await j(await fetch(`${API}/v1/claims/${claim.claim_id}/cosign-grants`, { method: "POST", headers: h, body: JSON.stringify({ auth_method: "magic_link_wallet" }) }));
console.log("3. co-sign link created; sealing the claim to storage…");
let view: any;
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  view = await j(await fetch(`${API}/v1/cosign/view`, { headers: { "x-cosign-token": grant.token } }));
  if (view.provenance?.storage?.root) break;
}
console.log("4. co-signer view provenance:", JSON.stringify(view.provenance, null, 2));
console.log(`\nOpen: http://localhost:3000${grant.url}`);
process.exit(0);
