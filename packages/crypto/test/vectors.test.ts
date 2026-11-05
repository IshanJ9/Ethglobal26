import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import {
  buildMerkle, canonicalJson, claimDigest, commit, eventHash, keccakUtf8, kraIdBytes32, makeDomain,
  merkleLeaf, recoverClaimSigner, scoreCommitment, subjectId, toClaimMessage, verifyMerkleProof, claimTypedData,
} from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const V = JSON.parse(readFileSync(join(here, "../../../spec/vectors/vectors.json"), "utf8"));

test("canonical JSON matches Python reference", () => {
  for (const c of V.canonical_json) {
    assert.equal(canonicalJson(c.input), c.canonical);
    assert.equal(keccakUtf8(c.canonical), c.keccak);
  }
});

test("canonical JSON rejects floats, unsafe ints, undefined, non-ASCII keys", () => {
  assert.throws(() => canonicalJson({ a: 1.5 }));
  assert.throws(() => canonicalJson({ a: 2 ** 60 }));
  assert.throws(() => canonicalJson({ a: undefined }));
  assert.throws(() => canonicalJson({ "kéy": 1 }));
});

test("commitments", () => {
  for (const c of V.commitments) assert.equal(commit(c.salt, c.value), c.commitment);
});

test("merkle root, proofs, odd promotion, single leaf, tamper", () => {
  const m = V.merkle;
  const t = buildMerkle(m.commitments);
  assert.deepEqual(t.leaves, m.sorted_leaves);
  assert.equal(t.root, m.root);
  for (const c of m.commitments) {
    const proof = t.proofFor(c);
    assert.deepEqual(proof, m.proofs[c]);
    assert.ok(verifyMerkleProof(c, proof, t.root));
  }
  // order independence
  assert.equal(buildMerkle([...m.commitments].reverse()).root, m.root);
  // single leaf: root is the leaf, empty proof
  const s = buildMerkle([m.single.commitment]);
  assert.equal(s.root, m.single.root);
  assert.equal(s.root, merkleLeaf(m.single.commitment));
  assert.ok(verifyMerkleProof(m.single.commitment, [], s.root));
  // tamper
  assert.equal(verifyMerkleProof(m.tamper_negative.commitment, m.proofs[m.commitments[0]], m.root), false);
});

test("subjectId, scoreCommitment, hash chain", () => {
  const s = V.subject_id;
  assert.equal(subjectId(s.org_secret, s.employee_id, s.cycle_id), s.subject_id);
  const sc = V.score_commitment;
  assert.equal(scoreCommitment(sc.salt, sc.value), sc.commitment);
  for (const link of V.hash_chain) {
    const prev = /^0x0{64}$/.test(link.prev_hash) ? null : link.prev_hash;
    assert.equal(eventHash(prev, link.core), link.event_hash);
  }
});

test("EIP-712: digest, both signatures, recovery, persona addresses", async () => {
  const e = V.eip712;
  assert.equal(kraIdBytes32(e.kra_id_string), e.message.kraId);
  assert.equal(commit(e.claim_salt, e.claim_value), e.message.claimCommitment);
  assert.equal(commit(e.evidence_salt, e.evidence_value), e.message.evidenceCommitment);
  const domain = makeDomain(e.domain.chainId, e.domain.verifyingContract);
  const msg = toClaimMessage(e.message);
  assert.equal(claimDigest(domain, msg), e.digest);

  const emp = privateKeyToAccount(e.employee_private_key as Hex);
  const cos = privateKeyToAccount(e.cosigner_private_key as Hex);
  assert.equal(emp.address, V.persona_addresses[e.employee_persona]);
  assert.equal(cos.address, V.persona_addresses[e.cosigner_persona]);

  const sigE = await emp.signTypedData(claimTypedData(domain, msg));
  const sigC = await cos.signTypedData(claimTypedData(domain, msg));
  assert.equal(sigE, e.employee_signature);
  assert.equal(sigC, e.cosigner_signature);
  assert.equal(await recoverClaimSigner(domain, msg, e.employee_signature), emp.address);
  assert.equal(await recoverClaimSigner(domain, msg, e.cosigner_signature), cos.address);

  // tampering with any field must change the recovered signer
  const bad = { ...msg, nonce: msg.nonce + 1n };
  assert.notEqual(await recoverClaimSigner(domain, bad, e.employee_signature), emp.address);
  // domain separation: other chain => different signer
  const other = makeDomain(e.domain.chainId + 1, e.domain.verifyingContract);
  assert.notEqual(await recoverClaimSigner(other, msg, e.employee_signature), emp.address);
});
