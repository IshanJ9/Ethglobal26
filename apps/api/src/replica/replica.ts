// ReplicaStore (AGENT_A section 4): the org DB is primary; an ENCRYPTED copy of each evidence payload
// (already sealed under the record DEK) goes to 0G Storage, or to local disk in mock mode. A failed replica
// never blocks the flow. Shredding destroys the key, so any remaining replica is undecryptable.
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { keccakBytes } from "@proofwork/crypto";
import type { Config } from "../config.ts";
import type { EvidenceRepo } from "../db/evidence.ts";

export interface ReplicaStore {
  readonly mode: "mock" | "live";
  put(bytes: Uint8Array): Promise<{ root: string }>;
  /** Best effort: local copies can be deleted; 0G Storage is immutable (the key is what gets destroyed). */
  forget(root: string): Promise<void>;
}

export class LocalReplicaStore implements ReplicaStore {
  readonly mode = "mock" as const;
  constructor(private readonly dir: string) {}
  async put(bytes: Uint8Array) {
    const root = keccakBytes(bytes);
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, `${root}.bin`), bytes);
    return { root };
  }
  async forget(root: string) {
    const f = join(this.dir, `${root}.bin`);
    if (/^0x[0-9a-f]{64}$/.test(root) && existsSync(f)) rmSync(f);
  }
}

/** 0G Storage via @0gfoundation/0g-storage-ts-sdk (loaded lazily so mock mode never imports it). */
export class ZeroGReplicaStore implements ReplicaStore {
  readonly mode = "live" as const;
  constructor(
    private readonly rpc: string,
    private readonly indexerUrl: string,
    private readonly privateKey: string,
  ) {}
  async put(bytes: Uint8Array) {
    const sdk: any = await import("@0gfoundation/0g-storage-ts-sdk");
    const { ethers }: any = await import("ethers");
    const signer = new ethers.Wallet(this.privateKey, new ethers.JsonRpcProvider(this.rpc));
    const indexer = new sdk.Indexer(this.indexerUrl);
    const mem = new sdk.MemData(bytes);
    const [tree, treeErr] = await mem.merkleTree(); // must run before upload
    if (treeErr !== null) throw new Error(`0G merkle tree: ${treeErr}`);
    const [tx, err] = await indexer.upload(mem, this.rpc, signer);
    if (err !== null) throw new Error(`0G upload: ${err}`);
    const root = (tx && "rootHash" in tx ? tx.rootHash : tree?.rootHash()) as string;
    if (!root) throw new Error("0G upload returned no root hash");
    return { root };
  }
  async forget() {}
}

export function makeReplicaStore(c: Config, localDir: string, log: (m: string) => void): ReplicaStore {
  if (c.ZEROG_MODE === "live") {
    if (c.ZEROG_STORAGE_RPC && c.ZEROG_STORAGE_INDEXER && c.ZEROG_PRIVATE_KEY) return new ZeroGReplicaStore(c.ZEROG_STORAGE_RPC, c.ZEROG_STORAGE_INDEXER, c.ZEROG_PRIVATE_KEY);
    log("ZEROG_MODE=live but ZEROG_STORAGE_RPC/ZEROG_STORAGE_INDEXER/ZEROG_PRIVATE_KEY missing; replicas go to local disk");
  }
  return new LocalReplicaStore(localDir);
}

/** Background replication queue: pending -> stored | failed. */
export class ReplicaService {
  private chain: Promise<void> = Promise.resolve();
  constructor(
    private readonly store: ReplicaStore,
    private readonly repo: EvidenceRepo,
    private readonly log: (m: string, d?: Record<string, unknown>) => void = () => {},
  ) {}

  get mode() {
    return this.store.mode;
  }

  enqueue(evidenceId: string) {
    this.repo.setReplica(evidenceId, "pending", null);
    this.chain = this.chain.then(() => this.replicate(evidenceId)).catch(() => {});
  }

  private async replicate(evidenceId: string) {
    const s = this.repo.secrets(evidenceId);
    if (!s?.payload_enc) return; // shredded meanwhile
    try {
      const { root } = await this.store.put(Buffer.from(s.payload_enc, "utf8"));
      // Re-check: if shredded during upload, drop the pointer again.
      if (this.repo.secrets(evidenceId)?.payload_enc) this.repo.setReplica(evidenceId, "stored", root);
      else await this.store.forget(root);
    } catch (e) {
      this.repo.setReplica(evidenceId, "failed", null);
      this.log("replica upload failed", { evidence_id: evidenceId, error: (e as Error).message.slice(0, 200) });
    }
  }

  async forget(root: string | null) {
    if (root) await this.store.forget(root).catch(() => {});
  }

  /** Tests / scripts: wait until the queue is drained. */
  flush() {
    return this.chain;
  }
}

export const defaultReplicaDir = (apiDir: string) => join(apiDir, "data", "replica");
