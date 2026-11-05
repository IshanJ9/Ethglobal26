# HASHING.md - frozen cryptographic constructions (spec v1.0.0)

**Implementation:** `packages/crypto` (TypeScript, imported by both apps). **Independent check:** `spec/vectors/generate.py` (Python) emits `spec/vectors/vectors.json`; `pnpm test:crypto` must pass. Nobody re-implements these functions. If you think a construction is wrong, file a CHANGE REQUEST.

## 1. Primitives
- Hash: **keccak256** everywhere (matches Solidity `keccak256`).
- All hashes/commitments are 32 bytes, rendered as `0x` + 64 lowercase hex.
- Strings are UTF-8. Integers in hashed JSON are JSON integers inside the safe range (|n| <= 2^53-1); anything larger is a decimal string.

## 2. Canonical JSON (RFC 8785 / JCS) - with extra restrictions
`canonicalJson(value)`:
- Object keys sorted by UTF-16 code units (library `canonicalize`), no whitespace.
- **Forbidden (throws):** floats / non-integer numbers, integers outside the safe range, `undefined`, NaN/Infinity, non-ASCII object keys.
- `null`, booleans, strings (any Unicode), arrays and integers are allowed.
- Money and anything possibly > 2^53 travel as **decimal strings**.

## 3. Constructions
| Name | Formula |
|---|---|
| `commit(salt, value)` | `keccak256( "PW_COMMIT_V1" ‖ salt32 ‖ utf8(canonicalJson(value)) )` |
| `merkleLeaf(commitment)` | `keccak256( 0x00 ‖ commitment32 )` |
| `merkleNode(a, b)` | `keccak256( min(a,b) ‖ max(a,b) )` (numeric compare, sorted pair = OpenZeppelin `MerkleProof` compatible) |
| `buildMerkle(commitments)` | leaves = `merkleLeaf` of each, **sorted ascending**; pair adjacent nodes level by level; an unpaired last node is promoted unchanged; single leaf => root = the leaf |
| `subjectId(orgSecret, employeeId, cycleId)` | `keccak256( "PW_SUBJECT_V1" ‖ orgSecret32 ‖ utf8(employeeId) ‖ 0x00 ‖ uint64_be(cycleId) )` - pseudonymous per employee per cycle; the org secret never leaves the backend |
| `scoreCommitment(salt, scoreObj)` | `keccak256( "PW_SCORE_V1" ‖ salt32 ‖ utf8(canonicalJson(scoreObj)) )` |
| `formulaHash(planWithoutFormulaHash)` | `keccak256( utf8(canonicalJson(plan minus formula_hash)) )` |
| `eventHash(prev, core)` | `keccak256( prev32 ‖ utf8(canonicalJson(core)) )`, first `prev` = 32 zero bytes. Used by the evidence ledger and audit log |
| `kraIdBytes32(kraId)` | `keccak256( utf8(kra_id string) )` |

Domain-separation prefixes (`PW_COMMIT_V1`, `PW_SUBJECT_V1`, `PW_SCORE_V1`) and the `0x00` leaf prefix are what stop cross-type and second-preimage confusion. Never drop them.

## 4. Objects that get committed
- **Claim value** = the `ClaimBody` object (openapi `ClaimBody`, schema `pw.claim.v1`).
- **Evidence value (claims)** = `{ "excerpt": "<text>" }`.
- **Evidence value (connector items)** = the canonical `EvidenceItem` core: `{ source, kind, ref, observed_at, observations, severity, self_introduced, share_bps }` (missing optional fields => `null`/`false`/`10000`, never omitted).
- **Score object** = `{ schema: "pw.score.v1", plan_id, formula_hash, employee_ref, cycle_id, version, score_bps, multiplier_bps, bonus_amount, lines:[{kra_id, actual, target, contribution_ppm}] , evidence_root }` where `employee_ref` is the `subjectId`, never a name.
- **Approval proof hash** = `keccak256(utf8(canonicalJson({ approval_id, scorecard_id, decision, approver_ref, world_result_hash, decided_at })))`, where `world_result_hash = keccak256(utf8(canonicalJson(world_result)))` and `approver_ref` is the approver's `subjectId`-style pseudonym.
- **inputs_hash** (ComputeResult) = `keccak256(utf8(canonicalJson({ formula_hash, prior_score_bps, override_actuals, evidence: [{evidence_id, status, commitment}] sorted by evidence_id })))`.

## 5. EIP-712 (claims)
Domain: `{ name: "Proofwork", version: "1", chainId, verifyingContract }`. `chainId` and `verifyingContract` come from `GET /v1/config/public` **only** (never hard-coded in the UI).

```
Claim(address employee,bytes32 claimCommitment,bytes32 evidenceCommitment,uint64 cycleId,bytes32 kraId,address cosigner,uint256 nonce,uint64 deadline)
```
- Both employee and co-signer sign the **same** struct. `nonce` = per-claim random uint (JSON integer < 2^53), `deadline` = unix seconds.
- JSON carries `cycleId`, `nonce`, `deadline` as integers; clients convert with `BigInt()` (`toClaimMessage`). Never pass JS numbers > 2^53.
- Signatures: 65-byte secp256k1 (`r‖s‖v`, v in {27,28}), 0x + 130 hex. Verification via `recoverClaimSigner` (viem). The backend verifies; contracts do not (enterprise mode keeps raw claims off-chain).

## 6. Worked vectors
`spec/vectors/vectors.json` contains canonical-JSON cases, commitments, a 5-leaf Merkle tree with every proof and a tamper negative, subject id, score commitment, a 3-link hash chain, and a full EIP-712 case (digest + both signatures from demo persona keys; **TEST ONLY** chainId 31337).
