/**
 * @proofwork/crypto - the ONLY implementation of Proofwork hashing, commitments, Merkle trees and EIP-712 typed data.
 * Both apps/api (Agent A) and apps/web (Agent B) import this package. Do not re-implement any of it.
 * Rules and constructions: spec/HASHING.md. Golden vectors: spec/vectors/vectors.json.
 */
import canonicalize from "canonicalize";
import {
  concat,
  getAddress,
  hashTypedData,
  hexToBytes,
  keccak256,
  numberToHex,
  recoverTypedDataAddress,
  stringToBytes,
  type Address,
  type Hex,
} from "viem";

export type { Address, Hex };

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const ZERO32: Hex = ("0x" + "00".repeat(32)) as Hex;

/** Guard: canonical JSON allows objects, arrays, strings, booleans, null and SAFE INTEGERS only. */
function assertCanonicalSafe(v: unknown, path = "$"): void {
  if (v === null || typeof v === "string" || typeof v === "boolean") return;
  if (typeof v === "number") {
    if (!Number.isInteger(v)) throw new Error(`canonical JSON forbids non-integer number at ${path}`);
    if (Math.abs(v) > MAX_SAFE) throw new Error(`integer outside safe range at ${path}; send it as a decimal string`);
    return;
  }
  if (Array.isArray(v)) return v.forEach((x, i) => assertCanonicalSafe(x, `${path}[${i}]`));
  if (typeof v === "object") {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (!/^[\x00-\x7f]*$/.test(k)) throw new Error(`non-ASCII object key at ${path}.${k}`);
      if (x === undefined) throw new Error(`undefined value at ${path}.${k}; omit the key or use null`);
      assertCanonicalSafe(x, `${path}.${k}`);
    }
    return;
  }
  throw new Error(`unsupported type ${typeof v} at ${path}`);
}

/** RFC 8785 canonical JSON string, restricted to the safe value space above. */
export function canonicalJson(value: unknown): string {
  assertCanonicalSafe(value);
  const s = canonicalize(value);
  if (s === undefined) throw new Error("canonicalize returned undefined");
  return s;
}

export const keccakUtf8 = (s: string): Hex => keccak256(stringToBytes(s));
export const keccakBytes = (b: Uint8Array | Hex): Hex => keccak256(b);

function assertHex32(h: string, name: string): asserts h is Hex {
  if (!/^0x[0-9a-f]{64}$/.test(h)) throw new Error(`${name} must be 0x + 64 lowercase hex chars`);
}

/** 32 random bytes as 0x-hex. Uses WebCrypto (browser + Node 22). */
export function randomSalt(): Hex {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return ("0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")) as Hex;
}

/** commitment = keccak256( "PW_COMMIT_V1" || salt32 || utf8(canonicalJson(value)) ) */
export function commit(salt: Hex, value: unknown): Hex {
  assertHex32(salt, "salt");
  return keccak256(concat([stringToBytes("PW_COMMIT_V1"), hexToBytes(salt), stringToBytes(canonicalJson(value))]));
}

/** Merkle leaf = keccak256( 0x00 || commitment ) */
export function merkleLeaf(commitment: Hex): Hex {
  assertHex32(commitment, "commitment");
  return keccak256(concat([new Uint8Array([0]), hexToBytes(commitment)]));
}

/** Internal node = keccak256( min(a,b) || max(a,b) )  (OpenZeppelin MerkleProof-compatible sorted pairs) */
export function merkleNode(a: Hex, b: Hex): Hex {
  const [x, y] = BigInt(a) <= BigInt(b) ? [a, b] : [b, a];
  return keccak256(concat([hexToBytes(x), hexToBytes(y)]));
}

export interface MerkleTree {
  root: Hex;
  leaves: Hex[]; // sorted ascending
  proofFor(commitment: Hex): Hex[];
}

/** Leaves sorted ascending (order-independent tree); an unpaired node is promoted unchanged. */
export function buildMerkle(commitments: Hex[]): MerkleTree {
  if (commitments.length === 0) throw new Error("cannot build an empty Merkle tree");
  const leaves = commitments.map(merkleLeaf).sort((p, q) => (BigInt(p) < BigInt(q) ? -1 : BigInt(p) > BigInt(q) ? 1 : 0));
  const levels: Hex[][] = [leaves];
  while (levels[levels.length - 1].length > 1) {
    const cur = levels[levels.length - 1];
    const nxt: Hex[] = [];
    for (let i = 0; i < cur.length; i += 2) nxt.push(i + 1 < cur.length ? merkleNode(cur[i], cur[i + 1]) : cur[i]);
    levels.push(nxt);
  }
  return {
    root: levels[levels.length - 1][0],
    leaves,
    proofFor(commitment: Hex): Hex[] {
      let idx = leaves.indexOf(merkleLeaf(commitment));
      if (idx < 0) throw new Error("commitment not in tree");
      const proof: Hex[] = [];
      for (const lvl of levels.slice(0, -1)) {
        const sib = idx ^ 1;
        if (sib < lvl.length) proof.push(lvl[sib]);
        idx = Math.floor(idx / 2);
      }
      return proof;
    },
  };
}

export function verifyMerkleProof(commitment: Hex, proof: Hex[], root: Hex): boolean {
  let cur = merkleLeaf(commitment);
  for (const p of proof) cur = merkleNode(cur, p);
  return cur === root;
}

/** subjectId = keccak256( "PW_SUBJECT_V1" || orgSecret32 || utf8(employeeId) || 0x00 || uint64_be(cycleId) ) */
export function subjectId(orgSecret: Hex, employeeId: string, cycleId: number): Hex {
  assertHex32(orgSecret, "orgSecret");
  const cyc = hexToBytes(numberToHex(BigInt(cycleId), { size: 8 }));
  return keccak256(concat([stringToBytes("PW_SUBJECT_V1"), hexToBytes(orgSecret), stringToBytes(employeeId), new Uint8Array([0]), cyc]));
}

/** scoreCommitment = keccak256( "PW_SCORE_V1" || salt32 || utf8(canonicalJson(obj)) ) */
export function scoreCommitment(salt: Hex, obj: unknown): Hex {
  assertHex32(salt, "salt");
  return keccak256(concat([stringToBytes("PW_SCORE_V1"), hexToBytes(salt), stringToBytes(canonicalJson(obj))]));
}

/** formulaHash = keccak256( utf8(canonicalJson(formulaSpec)) )  - formulaSpec is the plan WITHOUT formula_hash itself. */
export const formulaHash = (formulaSpec: unknown): Hex => keccakUtf8(canonicalJson(formulaSpec));

/** Hash-chain link for the append-only ledgers: keccak256( prev32 || utf8(canonicalJson(core)) ). First prev = 32 zero bytes. */
export function eventHash(prev: Hex | null, core: unknown): Hex {
  const p = prev ?? ZERO32;
  assertHex32(p, "prev");
  return keccak256(concat([hexToBytes(p), stringToBytes(canonicalJson(core))]));
}

/** kraId (bytes32) used in the EIP-712 struct = keccak256(utf8(kra_id string)). */
export const kraIdBytes32 = (kraId: string): Hex => keccakUtf8(kraId);

// ---------------------------------------------------------------------------------------------
// EIP-712
// ---------------------------------------------------------------------------------------------
export const CLAIM_TYPES = {
  Claim: [
    { name: "employee", type: "address" },
    { name: "claimCommitment", type: "bytes32" },
    { name: "evidenceCommitment", type: "bytes32" },
    { name: "cycleId", type: "uint64" },
    { name: "kraId", type: "bytes32" },
    { name: "cosigner", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

export interface ProofworkDomain {
  name: "Proofwork";
  version: "1";
  chainId: number;
  verifyingContract: Address;
}

export interface ClaimMessage {
  employee: Address;
  claimCommitment: Hex;
  evidenceCommitment: Hex;
  cycleId: bigint;
  kraId: Hex;
  cosigner: Address;
  nonce: bigint;
  deadline: bigint;
}

export function makeDomain(chainId: number, verifyingContract: Address): ProofworkDomain {
  return { name: "Proofwork", version: "1", chainId, verifyingContract };
}

/** JSON (API) form -> typed-data message with bigint numerics. API sends cycleId/nonce/deadline as JSON integers. */
export function toClaimMessage(m: {
  employee: string; claimCommitment: string; evidenceCommitment: string; cycleId: number | string;
  kraId: string; cosigner: string; nonce: number | string; deadline: number | string;
}): ClaimMessage {
  return {
    employee: getAddress(m.employee),
    claimCommitment: m.claimCommitment as Hex,
    evidenceCommitment: m.evidenceCommitment as Hex,
    cycleId: BigInt(m.cycleId),
    kraId: m.kraId as Hex,
    cosigner: getAddress(m.cosigner),
    nonce: BigInt(m.nonce),
    deadline: BigInt(m.deadline),
  };
}

export const claimTypedData = (domain: ProofworkDomain, message: ClaimMessage) =>
  ({ domain, types: CLAIM_TYPES, primaryType: "Claim" as const, message });

export const claimDigest = (domain: ProofworkDomain, message: ClaimMessage): Hex =>
  hashTypedData(claimTypedData(domain, message));

/** Returns the checksummed signer address recovered from a signature over the Claim struct. */
export const recoverClaimSigner = (domain: ProofworkDomain, message: ClaimMessage, signature: Hex): Promise<Address> =>
  recoverTypedDataAddress({ ...claimTypedData(domain, message), signature });
