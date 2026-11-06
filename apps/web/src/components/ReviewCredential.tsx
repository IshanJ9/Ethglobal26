"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { createPublicClient, createWalletClient, getAddress, http, keccak256, parseAbi, stringToBytes, type Hex } from "viem";
import { sepolia } from "viem/chains";
import ens from "../../../../deployments/ens.json";
import { useEnsRecords } from "@/lib/ens";
import { useEmployees } from "@/lib/queries";
import { demoAccount } from "@/lib/wallet";
import { Button, HashPill } from "@/components/ui";

// The review's ENS credential: r-<hash8>.<parent>, registered by the backend issuer when HR anchors the review.
// Owned by the employee, expiring, non-transferable (roleBitmap 0); only HR (UNREGISTER role) can revoke it.
const M = ens as unknown as { parent: string; subregistry: string };
const RPC = process.env.NEXT_PUBLIC_ENS_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const REG = parseAbi(["function ownerOf(uint256 tokenId) view returns (address)", "function getTokenId(uint256 anyId) view returns (uint256)", "function getExpiry(uint256 anyId) view returns (uint64)", "function unregister(uint256 anyId)"]);
const KEYS = ["role", "review_hash", "anchor_tx", "anchor_chain", "employee", "issued_by"];

export function ReviewCredential({ reviewHash, employeeId, isHr, anchored }: { reviewHash: string; employeeId: string; isHr: boolean; anchored: boolean }) {
  const emps = useEmployees();
  const list = (Array.isArray(emps.data) ? emps.data : ((emps.data as unknown as { items?: unknown[] })?.items ?? [])) as Array<{ employee_id: string; wallet_address: string }>;
  const ownerWallet = list.find((e) => e.employee_id === employeeId)?.wallet_address;
  const label = `r-${reviewHash.slice(2, 10).toLowerCase()}`;
  const name = `${label}.${M.parent}`;
  const q = useEnsRecords(anchored ? name : undefined, KEYS);
  const owner = useQuery({
    queryKey: ["ens-cred-owner", label],
    enabled: anchored,
    staleTime: 60_000,
    queryFn: async () => {
      const c = createPublicClient({ chain: sepolia, transport: http(RPC) });
      const id = BigInt(keccak256(stringToBytes(label)));
      const address = M.subregistry as Hex;
      const tokenId = await c.readContract({ address, abi: REG, functionName: "getTokenId", args: [id] });
      const [who, expiry] = await Promise.all([
        c.readContract({ address, abi: REG, functionName: "ownerOf", args: [tokenId] }),
        c.readContract({ address, abi: REG, functionName: "getExpiry", args: [id] }),
      ]);
      return { who: who as string, expiry: Number(expiry) };
    },
  });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; tx?: string } | null>(null);
  if (!anchored) return null;
  const t = q.data?.text;
  const issued = !!t?.review_hash;
  const hashOk = t?.review_hash?.toLowerCase() === reviewHash.toLowerCase();
  const ownerOk = ownerWallet && owner.data ? getAddress(owner.data.who) === getAddress(ownerWallet) : null;

  async function revoke() {
    setBusy(true); setMsg(null);
    try {
      const pub = createPublicClient({ chain: sepolia, transport: http(RPC) });
      const hr = demoAccount("p_hr");
      const sim = await pub.simulateContract({ account: hr, address: M.subregistry as Hex, abi: REG, functionName: "unregister", args: [BigInt(keccak256(stringToBytes(label)))] });
      const tx = await createWalletClient({ chain: sepolia, account: hr, transport: http(RPC) }).writeContract(sim.request);
      await pub.waitForTransactionReceipt({ hash: tx });
      setMsg({ ok: true, text: "Revoked by HR. The name no longer exists on ENS.", tx });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message.split("\n")[0] : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <p className="font-semibold">Review credential on ENS</p>
      {q.isLoading ? (
        <p className="text-muted">Resolving {name}…</p>
      ) : issued ? (
        <>
          <p>
            <span className="font-mono">{name}</span>{" "}
            <span className={hashOk ? "text-chain" : "text-danger"}>{hashOk ? "✓ review_hash matches this review" : "✗ review_hash differs"}</span>
          </p>
          <p className="text-xs text-muted">
            Issued by {t?.issued_by} to {t?.employee}{ownerOk === null ? "" : ownerOk ? " (owns it ✓)" : " (owner differs ✗)"}. Expires {owner.data?.expiry ? new Date(owner.data.expiry * 1000).toLocaleDateString() : "in one year"} (on chain); it cannot be transferred
            or deleted by the holder; only HR can revoke it. Anchor tx <HashPill value={t?.anchor_tx} /> on {t?.anchor_chain}.
          </p>
          {isHr ? (
            <div className="print:hidden">
              <Button kind="danger" onClick={revoke} disabled={busy}>{busy ? "Revoking on Sepolia…" : "Revoke credential (HR)"}</Button>
            </div>
          ) : null}
        </>
      ) : (
        <p className="text-muted">{msg?.ok ? "" : `Not issued (yet): ${name} does not resolve. The issuer registers it right after anchoring.`}</p>
      )}
      {msg ? (
        <p className={`text-xs ${msg.ok ? "text-chain" : "text-danger"}`}>
          {msg.text} {msg.tx ? <HashPill value={msg.tx} href={`https://sepolia.etherscan.io/tx/${msg.tx}`} /> : null}
        </p>
      ) : null}
    </div>
  );
}
