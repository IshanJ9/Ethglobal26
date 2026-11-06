// Browser-side Groth16 for the score_threshold circuit (packages/zk). The proof is generated in the
// employee's browser: the score and salt never leave it. Anyone can verify a shared bundle locally
// (vkey) and on Arc (ScoreThresholdVerifier.verifyProof), and check the commitment the company anchored.
import { createPublicClient, http, parseAbi, type Address } from "viem";
import type { Schemas } from "@/lib/api";

export type ZkWitness = Schemas["ZkWitness"];
export type ZkCommitment = Schemas["ZkCommitment"];

export const ARC_RPC = process.env.NEXT_PUBLIC_ARC_RPC ?? "https://rpc.testnet.arc.network";
export const ARC_EXPLORER = "https://explorer.testnet.arc.io";

export interface ProofBundle {
  v: 1;
  scorecard_id: string;
  threshold_bps: number;
  proof: unknown;
  publicSignals: string[]; // [commitment, threshold, binding]
  numeric_batch_id: number;
  verifier_address: string;
  registry_address: string;
  chain_id: number;
  created_at: string;
}

const snark = async (): Promise<any> => (await import("snarkjs" as string)) as any;

export async function prove(w: ZkWitness, thresholdBps: number): Promise<ProofBundle> {
  if (thresholdBps > w.score_bps) throw new Error("The score is below that threshold: no valid proof exists.");
  const s = await snark();
  const { proof, publicSignals } = await s.groth16.fullProve(
    { score: w.score_bps, salt: w.salt, binding: w.binding, commitment: w.commitment, threshold: thresholdBps },
    "/zk/score_threshold.wasm",
    "/zk/score_threshold.zkey",
  );
  return {
    v: 1, scorecard_id: w.scorecard_id, threshold_bps: thresholdBps, proof, publicSignals,
    numeric_batch_id: w.numeric_batch_id, verifier_address: w.verifier_address ?? "", registry_address: w.registry_address,
    chain_id: w.chain_id, created_at: new Date().toISOString(),
  };
}

export const encodeBundle = (b: ProofBundle) =>
  btoa(unescape(encodeURIComponent(JSON.stringify(b)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const decodeBundle = (s: string): ProofBundle =>
  JSON.parse(decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/")))));

/** keccak256(utf8(scorecard_id)) >> 8, the circuit's binding input. */
export async function bindingOf(scorecardId: string): Promise<bigint> {
  const { keccak256, toHex } = await import("viem");
  return BigInt(keccak256(toHex(scorecardId))) >> 8n;
}

export interface VerifyResult {
  local: boolean;
  onchain: boolean | null;
  anchored: boolean | null;
  binding: boolean;
  threshold: number;
  commitmentHex: string;
  error?: string;
}

export async function verifyBundle(b: ProofBundle): Promise<VerifyResult> {
  const s = await snark();
  const vkey = await (await fetch("/zk/vkey.json")).json();
  const [commitment, threshold, binding] = b.publicSignals;
  const commitmentHex = "0x" + BigInt(commitment).toString(16).padStart(64, "0");
  const out: VerifyResult = {
    local: await s.groth16.verify(vkey, b.publicSignals, b.proof),
    onchain: null, anchored: null,
    binding: BigInt(binding) === (await bindingOf(b.scorecard_id)),
    threshold: Number(threshold), commitmentHex,
  };
  try {
    const c = createPublicClient({ transport: http(ARC_RPC) });
    const args = JSON.parse("[" + (await s.groth16.exportSolidityCallData(b.proof, b.publicSignals)) + "]");
    if (b.verifier_address) {
      out.onchain = (await c.readContract({
        address: b.verifier_address as Address,
        abi: parseAbi(["function verifyProof(uint256[2],uint256[2][2],uint256[2],uint256[3]) view returns (bool)"]),
        functionName: "verifyProof", args,
      })) as boolean;
    }
    const root = (await c.readContract({
      address: b.registry_address as Address,
      abi: parseAbi(["function batchRoot(uint64) view returns (bytes32)"]),
      functionName: "batchRoot", args: [BigInt(b.numeric_batch_id)],
    })) as string;
    out.anchored = BigInt(root) === BigInt(commitment);
  } catch (e) {
    out.error = e instanceof Error ? e.message.split("\n")[0] : String(e);
  }
  return out;
}
