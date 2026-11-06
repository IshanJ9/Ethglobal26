import { getAddress, type Hex } from "viem";
import { canonicalJson, claimDigest, commit, kraIdBytes32, makeDomain, toClaimMessage } from "@proofwork/crypto";
import type { Schemas } from "./api";

/**
 * Anti-blind-signing (AGENT_B 4.2 SigningPanel): before the user signs, rebuild everything they are about to sign from
 * the plain values with @proofwork/crypto and compare it to what the server sent. Any mismatch blocks signing.
 */
export interface Check {
  id: string;
  label: string;
  ok: boolean;
  detail?: string;
}

const eqAddr = (a: string, b: string) => {
  try {
    return getAddress(a) === getAddress(b);
  } catch {
    return false;
  }
};

export function verifySigningPackage(input: {
  pkg: Schemas["SigningPackage"];
  claim: Schemas["Claim"];
  config: Schemas["PublicConfig"];
  signerAddress: string;
  cycleNumericId: number | undefined;
}): Check[] {
  const { pkg, claim, config, signerAddress, cycleNumericId } = input;
  const m = pkg.typed_data.message;
  const checks: Check[] = [];
  const add = (id: string, label: string, ok: boolean, detail?: string) => checks.push({ id, label, ok, detail });

  const claimCommitment = commit(pkg.claim_salt as Hex, pkg.claim_value);
  add("claim", "Claim commitment recomputed from the text you see", claimCommitment === m.claimCommitment,
    claimCommitment === m.claimCommitment ? undefined : `computed ${claimCommitment}, server sent ${m.claimCommitment}`);

  const evidenceCommitment = commit(pkg.evidence_salt as Hex, pkg.evidence_value);
  add("evidence", "Evidence commitment recomputed from the excerpt", evidenceCommitment === m.evidenceCommitment,
    evidenceCommitment === m.evidenceCommitment ? undefined : `computed ${evidenceCommitment}, server sent ${m.evidenceCommitment}`);

  add("body", "Signed text equals the claim shown on this page", canonicalJson(pkg.claim_value) === canonicalJson(claim.body));
  add("excerpt", "Signed excerpt equals the excerpt shown", pkg.evidence_value.excerpt === claim.evidence_excerpt);
  add("employee", "Signer is your wallet", eqAddr(m.employee, signerAddress), `${m.employee} vs ${signerAddress}`);
  add("cosigner", "Co-signer address matches the claim", eqAddr(m.cosigner, claim.cosigner_address));
  add("kra", "KRA id matches the claim", m.kraId === kraIdBytes32(claim.kra_id));
  add("cycle", "Cycle matches", cycleNumericId !== undefined && Number(m.cycleId) === cycleNumericId);

  const d = config.eip712_domain;
  const domainOk =
    pkg.typed_data.domain.name === d.name &&
    pkg.typed_data.domain.version === d.version &&
    pkg.typed_data.domain.chainId === d.chainId &&
    eqAddr(pkg.typed_data.domain.verifyingContract, d.verifyingContract);
  add("domain", `Domain matches ${config.chain.name} (chain ${d.chainId})`, domainOk);

  const deadlineOk = Number(m.deadline) * 1000 > Date.now();
  add("deadline", "Signature deadline is in the future", deadlineOk);

  let digest: Hex | null = null;
  try {
    digest = claimDigest(makeDomain(d.chainId, getAddress(d.verifyingContract)), toClaimMessage(m));
  } catch {
    digest = null;
  }
  add("digest", "EIP-712 digest rebuilt locally", digest === pkg.digest, digest === pkg.digest ? undefined : `computed ${digest}, server sent ${pkg.digest}`);

  return checks;
}
