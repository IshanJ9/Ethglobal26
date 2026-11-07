"use client";

import { sepoliaTransport } from "@/lib/ens";
import { useEffect, useState } from "react";
import { createPublicClient, createWalletClient, parseAbi, toHex, type Address, type Hex } from "viem";
import { packetToBytes } from "viem/ens";
import { sepolia } from "viem/chains";
import manifest from "../../../../../../deployments/ens.json";
import rolesJson from "../../../../../../deployments/ens-roles.json";
import { useRequireSession } from "@/lib/auth";
import { demoAccount } from "@/lib/wallet";
import { Button, Card, ErrorNote, HashPill, PageTitle } from "@/components/ui";

// Granular, hierarchical access on ENSv2: each department has its own PermissionedResolver, and EAC roles say
// who may write which record. Every cell below is a live eth_call simulation on Sepolia, not a hard-coded table.
type Entry = { name: string; kind: string; addr?: string; text: Record<string, string> };
type Roles = { resolvers: Record<string, string>; roles?: { admin: string; hr: string; managers: Record<string, string>; manager_keys: string[]; issuer: string; review_agent: string; aliases: Record<string, string> } };
const R = rolesJson as unknown as Roles;
const NAMES = (manifest.names as unknown as Entry[]).filter((e) => e.kind === "person");
const EXPLORER = "https://sepolia.etherscan.io";
const pub = createPublicClient({ chain: sepolia, transport: sepoliaTransport() });
const ABI = parseAbi([
  "function setText(bytes name, string key, string value)",
  "function setAddress(bytes name, uint256 coinType, bytes addressBytes)",
]);
const dns = (n: string) => toHex(packetToBytes(n));
const deptOf = (name: string) => NAMES.find((e) => e.name === name)?.text.department?.split(".")[0] ?? "";

const ACTORS: Array<{ id: string; label: string; role: string }> = [
  { id: "p_hr", label: "Jon (HR)", role: "HR: SET_TEXT + SET_ADDRESS on every department resolver; register/unregister people on the registry" },
  { id: "p_eng_mgr", label: "Elena (Software manager)", role: "setText for title, cluster, status only, on the Software resolver only" },
  { id: "p_sales_mgr", label: "Grace (Sales manager)", role: "setText for title, cluster, status only, on the Sales resolver only" },
  { id: "p_dev_b", label: "Ben (Software engineer)", role: "No write roles: can read everything, edit nothing" },
];
const P = (l: string) => `${l}.${(manifest as unknown as { parent: string }).parent}`;

type Op = { key: string; kind: "text" | "addr" };
const CASES: Array<{ actor: string; target: string; op: Op; expect: boolean; why: string }> = [
  { actor: "p_hr", target: P("ben"), op: { key: "title", kind: "text" }, expect: true, why: "HR is above everyone" },
  { actor: "p_hr", target: P("farid"), op: { key: "description", kind: "text" }, expect: true, why: "HR can write any text record, any department" },
  { actor: "p_hr", target: P("ben"), op: { key: "addr", kind: "addr" }, expect: true, why: "HR may rotate a wallet address" },
  { actor: "p_eng_mgr", target: P("ben"), op: { key: "title", kind: "text" }, expect: true, why: "manager edits a report's title" },
  { actor: "p_eng_mgr", target: P("chen"), op: { key: "cluster", kind: "text" }, expect: true, why: "manager moves a report between clusters" },
  { actor: "p_eng_mgr", target: P("ben"), op: { key: "description", kind: "text" }, expect: false, why: "key not delegated to managers" },
  { actor: "p_eng_mgr", target: P("ben"), op: { key: "addr", kind: "addr" }, expect: false, why: "managers cannot touch wallet addresses" },
  { actor: "p_eng_mgr", target: P("farid"), op: { key: "title", kind: "text" }, expect: false, why: "Farid is in Sales: another resolver" },
  { actor: "p_sales_mgr", target: P("farid"), op: { key: "title", kind: "text" }, expect: true, why: "Sales manager, own department" },
  { actor: "p_sales_mgr", target: P("ben"), op: { key: "title", kind: "text" }, expect: false, why: "Ben is not in Sales" },
  { actor: "p_dev_b", target: P("chen"), op: { key: "title", kind: "text" }, expect: false, why: "peer cannot edit a peer" },
  { actor: "p_dev_b", target: P("ben"), op: { key: "title", kind: "text" }, expect: false, why: "no self-promotion" },
  { actor: "p_dev_b", target: P("elena"), op: { key: "title", kind: "text" }, expect: false, why: "cannot edit upward" },
];

function call(target: string, op: Op, value: string, actor: Address) {
  const address = R.resolvers[deptOf(target)] as Address;
  return op.kind === "text"
    ? { address, abi: ABI, functionName: "setText" as const, args: [dns(target), op.key, value] as const, account: actor }
    : { address, abi: ABI, functionName: "setAddress" as const, args: [dns(target), 60n, actor as Hex] as const, account: actor };
}

async function allowed(actorId: string, target: string, op: Op): Promise<boolean> {
  try {
    await pub.simulateContract(call(target, op, "probe", demoAccount(actorId).address) as any);
    return true;
  } catch {
    return false;
  }
}

const short = (n: string) => n.split(".")[0];
const actorLabel = (id: string) => ACTORS.find((a) => a.id === id)?.label ?? id;

export default function AccessPage() {
  const me = useRequireSession();
  const [results, setResults] = useState<Array<boolean | null>>(CASES.map(() => null));
  useEffect(() => {
    CASES.forEach((c, i) => allowed(c.actor, c.target, c.op).then((ok) => setResults((r) => r.map((x, j) => (j === i ? ok : x)))));
  }, []);

  const [actor, setActor] = useState("p_eng_mgr");
  const [target, setTarget] = useState(P("ben"));
  const [key, setKey] = useState("title");
  const [value, setValue] = useState("Senior Software Engineer");
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<{ ok: boolean; msg: string; tx?: string; read?: string } | null>(null);
  const [err, setErr] = useState<unknown>(null);

  async function send() {
    setBusy(true); setOut(null); setErr(null);
    const acct = demoAccount(actor);
    const c = call(target, { key, kind: "text" }, value, acct.address);
    try {
      const sim = await pub.simulateContract({ ...c, account: acct } as any).catch((e: Error) => {
        throw new Error(`Denied by the resolver's access control (EAC): ${actorLabel(actor)} has no role for setText("${key}") on ${short(target)}. ${e.message.split("\n")[0]}`);
      });
      const w = createWalletClient({ chain: sepolia, account: acct, transport: sepoliaTransport() });
      const tx = await w.writeContract(sim.request);
      await pub.waitForTransactionReceipt({ hash: tx });
      // public RPCs are load-balanced: poll until a node that has the new block answers
      let read = "";
      for (let i = 0; i < 8; i++) {
        read = (await pub.getEnsText({ name: target, key }).catch(() => null)) ?? "";
        if (read === value) break;
        await new Promise((r) => setTimeout(r, 2500));
      }
      setOut({ ok: true, msg: `${actorLabel(actor)} wrote ${key} on ${target}`, tx, read });
    } catch (e) {
      setOut({ ok: false, msg: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  if (!me) return null;
  const roles = R.roles;
  return (
    <div className="space-y-6">
      <PageTitle
        title="Who can edit what (ENS access control)"
        sub="ENSv2 PermissionedResolvers: one per department, with EAC roles scoped to a single record key. The hierarchy is enforced by the contracts on Sepolia, not by our backend."
      />

      <Card title="Hierarchy">
        <ol className="space-y-2 text-sm">
          <li><b>Org admin</b> <HashPill value={roles?.admin} /> holds every role (and the admin bit to grant it) on every resolver.</li>
          <li className="pl-4"><b>HR</b> <HashPill value={roles?.hr} /> SET_TEXT and SET_ADDRESS on all department resolvers; REGISTRAR, UNREGISTER and RENEW on the subname registry (hire and offboard).</li>
          <li className="pl-8"><b>Department managers</b>: <code>grantSetterRoles(setText(*, key))</code> for {roles?.manager_keys?.join(", ") ?? "title, cluster, status"}, on their own department’s resolver only.
            {roles ? Object.entries(roles.managers).map(([d, a]) => <span key={d} className="ml-2 inline-flex items-center gap-1 text-xs text-muted">{d} <HashPill value={a} /></span>) : null}
          </li>
          <li className="pl-12"><b>Employees</b>: read everything, write nothing (not even their own title).</li>
          <li><b>Agents</b> (kra-agent, review-agent) live on their own resolvers; the review agent publishes its own prompt hash with its own key. The backend <b>issuer</b> <HashPill value={roles?.issuer} /> may only register and renew review credentials.</li>
          {roles ? <li className="text-xs text-muted">Aliases (linkToNode): {Object.entries(roles.aliases).map(([a, t]) => `${a.split(".").slice(0, 2).join(".")} → ${short(t)}`).join(" · ")}</li> : null}
        </ol>
        <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted">
          {Object.entries(R.resolvers).map(([d, a]) => <span key={d} className="inline-flex items-center gap-1">{d} resolver <HashPill value={a} href={`${EXPLORER}/address/${a}`} /></span>)}
        </div>
      </Card>

      <Card title="Permission matrix (live simulation on Sepolia)" right={<span className="text-xs text-muted">{results.filter((x) => x !== null).length}/{CASES.length} checked</span>}>
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase text-muted">
            <tr><th className="py-1">Who</th><th>Edits</th><th>Record</th><th>Expected</th><th>Chain says</th><th className="hidden sm:table-cell">Why</th></tr>
          </thead>
          <tbody>
            {CASES.map((c, i) => {
              const r = results[i];
              return (
                <tr key={i} className="border-t border-line">
                  <td className="py-1.5">{actorLabel(c.actor)}</td>
                  <td>{short(c.target)}</td>
                  <td><code>{c.op.kind === "addr" ? "addr (ETH)" : c.op.key}</code></td>
                  <td>{c.expect ? "allow" : "deny"}</td>
                  <td>{r === null ? <span className="text-muted">…</span> : <span className={r === c.expect ? (r ? "font-semibold text-emerald-700" : "font-semibold text-red-700") : "font-bold text-amber-600"}>{r ? "allowed" : "reverted"}{r !== c.expect ? " (unexpected)" : ""}</span>}</td>
                  <td className="hidden text-xs text-muted sm:table-cell">{c.why}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      <Card title="Try it: send a real edit" right={<span className="text-xs text-muted">Sepolia · signed with the persona’s demo key</span>}>
        <div className="flex flex-wrap items-end gap-3 text-sm">
          <label>
            <span className="mb-1 block text-muted">As</span>
            <select value={actor} onChange={(e) => setActor(e.target.value)} className="rounded border border-line bg-surface px-2 py-1.5">
              {ACTORS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
            </select>
          </label>
          <label>
            <span className="mb-1 block text-muted">Person</span>
            <select value={target} onChange={(e) => setTarget(e.target.value)} className="rounded border border-line bg-surface px-2 py-1.5">
              {NAMES.map((n) => <option key={n.name} value={n.name}>{short(n.name)} ({deptOf(n.name)})</option>)}
            </select>
          </label>
          <label>
            <span className="mb-1 block text-muted">Record</span>
            <select value={key} onChange={(e) => setKey(e.target.value)} className="rounded border border-line bg-surface px-2 py-1.5">
              {["title", "cluster", "status", "description", "manager"].map((k) => <option key={k}>{k}</option>)}
            </select>
          </label>
          <label>
            <span className="mb-1 block text-muted">New value</span>
            <input value={value} onChange={(e) => setValue(e.target.value)} className="w-56 rounded border border-line bg-surface px-2 py-1.5" />
          </label>
          <Button onClick={send} disabled={busy}>{busy ? "Sending…" : "Send"}</Button>
        </div>
        <p className="mt-2 text-xs text-muted">{ACTORS.find((a) => a.id === actor)?.role}</p>
        <ErrorNote error={err} className="mt-3" />
        {out ? (
          <div className={`mt-3 rounded border px-3 py-2 text-sm ${out.ok ? "border-emerald-600/40 bg-emerald-600/10" : "border-red-600/40 bg-red-600/10 text-red-700"}`}>
            {out.ok ? "✓ " : "✗ "}{out.msg}
            {out.tx ? <span className="ml-2 inline-flex items-center gap-1">tx <HashPill value={out.tx} href={`${EXPLORER}/tx/${out.tx}`} /></span> : null}
            {out.read !== undefined ? <span className="ml-2">· on-chain value now: <b>{out.read}</b></span> : null}
          </div>
        ) : null}
      </Card>
    </div>
  );
}
