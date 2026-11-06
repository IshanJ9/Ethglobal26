// Public verification (AGENT_A 3.8, INTEGRATION F4). Recomputes commitments from a reveal, checks Merkle
// proofs against the ON-CHAIN batch root, attestation revocation, both EIP-712 signers for claims, the
// ledger hash chain and the formula hash. Shredded evidence: evidence_not_shredded=false, proof still valid.
import { commit, makeDomain, recoverClaimSigner, scoreCommitment, toClaimMessage, verifyMerkleProof, type Hex } from "@proofwork/crypto";
import type { components } from "@proofwork/shared";
import { getAddress, isAddressEqual, type Address } from "viem";
import { errors } from "../errors.ts";
import type { ClaimRepo } from "../db/claims.ts";
import type { EvidenceRepo, EvidenceRow } from "../db/evidence.ts";
import type { OrgRepo } from "../db/org.ts";
import type { ChainRepo, ScorecardRepo } from "../db/scorecards.ts";
import type { Ledger } from "../ledger/ledger.ts";
import type { ChainClient } from "../chain/types.ts";

export type VerifyRequest = components["schemas"]["VerifyRequest"];
export type VerifyResult = components["schemas"]["VerifyResult"];
type Check = VerifyResult["checks"][number];

export class VerifyService {
  constructor(
    private readonly evidence: EvidenceRepo,
    private readonly ledger: Ledger,
    private readonly chainRepo: ChainRepo,
    private readonly chain: ChainClient,
    private readonly scorecards: ScorecardRepo,
    private readonly claims: ClaimRepo,
    private readonly org: OrgRepo,
  ) {}

  private async evidenceChecks(e: EvidenceRow, checks: Check[]) {
    const proof = e.proof_json ? (JSON.parse(e.proof_json) as Hex[]) : null;
    const batch = e.batch_id ? this.chainRepo.batch(e.batch_id) : undefined;
    if (!batch || !proof) {
      checks.push({ name: "merkle_proof_valid", ok: false, detail: "not anchored yet" });
      checks.push({ name: "root_anchored_on_chain", ok: false, detail: "not anchored yet" });
    } else {
      checks.push({ name: "merkle_proof_valid", ok: verifyMerkleProof(e.commitment as Hex, proof, batch.root as Hex), detail: `batch ${batch.numeric_id}` });
      let onChain: Hex | null = null;
      try {
        onChain = await this.chain.batchRoot(BigInt(batch.numeric_id));
      } catch {
        onChain = null;
      }
      checks.push({
        name: "root_anchored_on_chain",
        ok: onChain === batch.root,
        detail: onChain === batch.root ? `${this.chain.mode} chain root matches` : "root not found on chain",
      });
    }
    const broken = this.ledger.verifyChain();
    checks.push({ name: "hash_chain_intact", ok: broken === null, detail: broken === null ? "evidence ledger chain intact" : `broken at seq ${broken}` });
    checks.push({
      name: "evidence_not_shredded",
      ok: e.status !== "shredded",
      detail: e.status === "shredded" ? "data key destroyed; plaintext cannot be recovered (commitment and Merkle leaf remain)" : "data available",
    });
  }

  async verify(req: VerifyRequest): Promise<VerifyResult> {
    const checks: Check[] = [];
    const reveal = req.reveal;

    if (req.kind === "evidence") {
      const e = this.evidence.get(req.id);
      if (!e) throw errors.notFound("Evidence not found");
      if (reveal?.value && reveal.salt) {
        let ok = false;
        try {
          ok = commit(reveal.salt as Hex, reveal.value) === e.commitment;
        } catch {
          ok = false;
        }
        checks.push({ name: "commitment_matches", ok, detail: ok ? "reveal reproduces the commitment" : "reveal does not reproduce the commitment" });
      } else if (e.status === "shredded") {
        checks.push({ name: "commitment_matches", ok: false, detail: "cannot be recomputed: data shredded" });
      }
      await this.evidenceChecks(e, checks);
    } else if (req.kind === "scorecard") {
      const sc = this.scorecards.get(req.id);
      if (!sc) throw errors.notFound("Scorecard not found");
      if (reveal?.value && reveal.salt) {
        let ok = false;
        try {
          ok = scoreCommitment(reveal.salt as Hex, reveal.value) === sc.score_commitment;
        } catch {
          ok = false;
        }
        checks.push({ name: "commitment_matches", ok, detail: ok ? "reveal reproduces the score commitment" : "reveal does not reproduce the score commitment" });
      }
      const employee = this.org.employee(sc.employee_id)!;
      const plan = this.org.plan(employee.plan_id)!;
      const fh = (reveal?.value as any)?.formula_hash ?? (sc.score_object_json ? JSON.parse(sc.score_object_json).formula_hash : null);
      checks.push({ name: "formula_hash_matches", ok: fh === plan.formula_hash, detail: `plan ${plan.plan_id}` });
      const ref = sc.attestation_json ? JSON.parse(sc.attestation_json) : null;
      if (ref) {
        try {
          const a = await this.chain.getAttestation(BigInt(ref.attestation_id));
          const matches = a.scoreCommitment === sc.score_commitment && a.evidenceRoot === sc.evidence_root;
          checks.push({ name: "attestation_not_revoked", ok: !a.revoked && matches, detail: a.revoked ? "attestation revoked (superseded)" : matches ? `attestation ${ref.attestation_id} live` : "on-chain values differ" });
        } catch {
          checks.push({ name: "attestation_not_revoked", ok: false, detail: "attestation not found on chain" });
        }
      } else {
        checks.push({ name: "attestation_not_revoked", ok: false, detail: "not attested" });
      }
      // Every evidence item behind the score is in an anchored batch whose root is on chain.
      let allAnchored = true;
      for (const id of JSON.parse(sc.evidence_ids_json) as string[]) {
        const e = this.evidence.get(id);
        const b = e?.batch_id ? this.chainRepo.batch(e.batch_id) : undefined;
        if (!e || !b || !e.proof_json || !verifyMerkleProof(e.commitment as Hex, JSON.parse(e.proof_json), b.root as Hex)) {
          allAnchored = false;
          break;
        }
      }
      checks.push({ name: "merkle_proof_valid", ok: allAnchored, detail: allAnchored ? "all evidence proofs valid" : "some evidence not anchored" });
      const broken = this.ledger.verifyChain();
      checks.push({ name: "hash_chain_intact", ok: broken === null });
    } else {
      const c = this.claims.get(req.id);
      if (!c) throw errors.notFound("Claim not found");
      if (!c.typed_data_json) throw errors.invalidState("Claim has no signing package yet");
      const td = JSON.parse(c.typed_data_json);
      if (reveal?.value && reveal.salt) {
        let ok = false;
        try {
          ok = commit(reveal.salt as Hex, reveal.value) === c.claim_commitment;
        } catch {
          ok = false;
        }
        checks.push({ name: "commitment_matches", ok, detail: ok ? "claim reveal reproduces claimCommitment" : "claim reveal mismatch" });
      }
      if (reveal?.evidence_value && reveal.evidence_salt) {
        let ok = false;
        try {
          ok = commit(reveal.evidence_salt as Hex, reveal.evidence_value) === c.evidence_commitment;
        } catch {
          ok = false;
        }
        checks.push({ name: "commitment_matches", ok, detail: ok ? "evidence reveal reproduces evidenceCommitment" : "evidence reveal mismatch" });
      }
      const domain = makeDomain(td.domain.chainId, getAddress(td.domain.verifyingContract));
      const msg = toClaimMessage(td.message);
      const sigCheck = async (sig: string | null, who: Address) => {
        if (!sig) return { ok: false, detail: "not signed" };
        try {
          const s = await recoverClaimSigner(domain, msg, sig as Hex);
          return { ok: isAddressEqual(s, who), detail: `recovered ${s}` };
        } catch {
          return { ok: false, detail: "invalid signature" };
        }
      };
      const employee = this.org.employee(c.employee_id)!;
      checks.push({ name: "employee_signature_valid", ...(await sigCheck(c.employee_sig, getAddress(employee.wallet_address))) });
      checks.push({ name: "cosigner_signature_valid", ...(await sigCheck(c.cosigner_sig, getAddress(c.cosigner_address))) });
      const e = c.evidence_id ? this.evidence.get(c.evidence_id) : undefined;
      if (e) await this.evidenceChecks(e, checks);
    }
    return { ok: checks.length > 0 && checks.every((x) => x.ok), kind: req.kind, id: req.id, checks };
  }
}
