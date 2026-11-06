"use client";

import { getAddress } from "viem";
import manifest from "../../../../../../deployments/ens.json";
import { useRequireSession } from "@/lib/auth";
import { useEnsRecords } from "@/lib/ens";
import { Card, HashPill, PageTitle } from "@/components/ui";

type Entry = { name: string; kind: string; addr?: string; coin?: Record<string, string>; text: Record<string, string> };
const NAMES = manifest.names as unknown as Entry[];
const SECTIONS: Array<[string, string, string]> = [
  ["org", "Organisation", "The root name. Lists departments, clusters and agents."],
  ["department", "Departments", "Subname tokens under the org; each names its head and its clusters."],
  ["cluster", "Peer clusters", "Each cluster publishes its KRA plan hash (`policy`). Scores are only valid if computed with that exact plan."],
  ["agent", "AI agents", "Machine actors with their own names: what they do, which model, and the hash of the instructions they run with."],
  ["signer", "Chain signers", "The backend's role keys, named. Every Arc transaction in the app is sent by one of these."],
  ["contract", "Contracts on Arc", "ENSIP-11 multichain address records point at the Arc testnet contracts (coin type 0x80000000 | 5042002)."],
  ["person", "People", "Every employee: wallet address, department, peer cluster, manager."],
  ["client", "External co-signers", "Client signers are named too, so a co-signature shows who confirmed the work."],
];
const SHOW: Record<string, string[]> = {
  org: ["org.name", "description", "url"],
  department: ["head", "clusters"],
  cluster: ["plan", "policy", "kras"],
  agent: ["role", "model", "prompt", "policy"],
  signer: ["roles", "contract"],
  contract: ["contract", "chain"],
  person: ["title", "department", "cluster", "manager"],
  client: ["title", "org"],
};
const isHex = (v: string) => /^0x[0-9a-fA-F]{40,}$/.test(v);

function Row({ e }: { e: Entry }) {
  const keys = SHOW[e.kind] ?? [];
  const coin = e.coin ? Number(Object.keys(e.coin)[0]) : undefined;
  const q = useEnsRecords(e.name, keys, coin);
  const live = q.data;
  const addrOk = e.addr ? (live?.addr ? getAddress(live.addr) === getAddress(e.addr) : false) : null;
  const coinOk = e.coin && coin ? (live?.coinAddr ? getAddress(live.coinAddr) === getAddress(e.coin[String(coin)]) : false) : null;
  const textOk = keys.every((k) => e.text[k] === undefined || live?.text[k] === e.text[k]);
  const ok = !!live && addrOk !== false && coinOk !== false && textOk;
  return (
    <tr className="border-b border-line/60 align-top">
      <td className="py-2 pr-3">
        <span className="font-mono text-xs font-semibold">{e.name}</span>
        <div className="mt-0.5 text-[11px]">
          {q.isLoading ? <span className="text-muted">resolving…</span> : ok ? <span className="text-chain">✓ resolves on Sepolia</span> : <span className="text-danger">✗ not matching ENS yet</span>}
        </div>
      </td>
      <td className="py-2 pr-3 text-xs">
        {e.addr ? <div>ETH <HashPill value={live?.addr ?? e.addr} /></div> : null}
        {e.coin && coin ? <div>Arc <HashPill value={live?.coinAddr ?? e.coin[String(coin)]} /></div> : null}
        {!e.addr && !e.coin ? <span className="text-muted">-</span> : null}
      </td>
      <td className="py-2 text-xs">
        <dl className="grid grid-cols-[max-content_1fr] gap-x-2 gap-y-0.5">
          {keys.filter((k) => e.text[k] !== undefined).map((k) => {
            const v = live?.text[k] ?? null;
            return (
              <div key={k} className="contents">
                <dt className="text-muted">{k}</dt>
                <dd className="break-all">
                  {v === null ? <span className="text-muted">…</span> : isHex(v) ? <HashPill value={v} /> : v.split(",").length > 3 ? `${v.split(",").length} entries` : v}
                </dd>
              </div>
            );
          })}
        </dl>
      </td>
    </tr>
  );
}

export default function DirectoryPage() {
  const me = useRequireSession();
  if (!me) return null;
  return (
    <div className="flex flex-col gap-6">
      <PageTitle
        title="Organisation on ENS"
        sub={`${manifest.parent} is the company directory: departments, peer clusters, AI agents, chain signers, contracts and every person. Every row below is resolved live from Sepolia ENS (ENSv2); the tick means the chain matches.`}
      />
      {SECTIONS.map(([kind, title, about]) => {
        const rows = NAMES.filter((n) => n.kind === kind);
        if (!rows.length) return null;
        return (
          <Card key={kind} title={`${title} · ${rows.length}`}>
            <p className="mb-3 text-sm text-muted">{about}</p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                    <th className="py-2 pr-3">Name</th>
                    <th className="py-2 pr-3">Address</th>
                    <th className="py-2">Records</th>
                  </tr>
                </thead>
                <tbody>{rows.map((e) => <Row key={e.name} e={e} />)}</tbody>
              </table>
            </div>
          </Card>
        );
      })}
      <p className="text-xs text-muted">Resolver {manifest.resolver} · subregistry {manifest.subregistry} · names under the org resolve through the ENS Universal Resolver.</p>
    </div>
  );
}
