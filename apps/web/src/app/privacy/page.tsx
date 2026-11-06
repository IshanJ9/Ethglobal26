"use client";

import { useSession } from "@/lib/session";
import { ROLE_LABEL } from "@/lib/personas";
import { Card, PageTitle } from "@/components/ui";

// INTEGRATION 9. Enforced by the API; this page only explains it.
type Col = "employee" | "manager" | "hr" | "external_cosigner" | "public";
const COLS: { id: Col; label: string }[] = [
  { id: "employee", label: "Employee (self)" },
  { id: "manager", label: "Their manager" },
  { id: "hr", label: "HR" },
  { id: "external_cosigner", label: "Client co-signer" },
  { id: "public", label: "Public" },
];
const ROWS: { action: string; cells: Record<Col, string> }[] = [
  { action: "See your own evidence, claims and scorecards", cells: { employee: "yes", manager: "-", hr: "-", external_cosigner: "-", public: "-" } },
  { action: "See a report's evidence and scorecards", cells: { employee: "no", manager: "yes", hr: "yes, everyone", external_cosigner: "no", public: "no" } },
  { action: "Create a claim and sign it as the employee", cells: { employee: "own only", manager: "no", hr: "no", external_cosigner: "no", public: "no" } },
  { action: "Read one claim and co-sign it", cells: { employee: "no", manager: "no", hr: "no", external_cosigner: "only with a live link for that claim", public: "no" } },
  { action: "Approve a scorecard", cells: { employee: "never your own", manager: "yes, with World step-up", hr: "yes", external_cosigner: "no", public: "no" } },
  { action: "Attest on chain and pay out", cells: { employee: "no", manager: "after approval", hr: "after approval", external_cosigner: "no", public: "no" } },
  { action: "Erase a record (shred)", cells: { employee: "no", manager: "no", hr: "yes", external_cosigner: "no", public: "no" } },
  { action: "Verify a record", cells: { employee: "yes", manager: "yes", hr: "yes", external_cosigner: "yes", public: "yes" } },
];

const ON_CHAIN = [
  ["Salted commitments", "Hashes of claims, evidence and scorecards. Without the salt, nobody can guess the content."],
  ["Merkle roots", "One root per evidence batch; proves an item existed at anchor time."],
  ["Pseudonymous subject ids", "A per-cycle id derived with an org secret: the chain never sees a name or employee id."],
  ["Multiplier and payout amounts", "Basis points and USDC amounts, tied to the subject id only."],
];

export default function PrivacyPage() {
  const me = useSession()?.persona;
  const myCol: Col | null = me ? (me.role === "admin" ? "hr" : (me.role as Col)) : "public";

  return (
    <div className="flex flex-col gap-6">
      <PageTitle title="Who can see what" sub="The API enforces these rules on every request. Asking for something you may not see returns “not found”, so ids cannot be probed." />

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                <th className="py-2 pr-3 font-medium">Action</th>
                {COLS.map((c) => (
                  <th key={c.id} className={`py-2 pr-3 font-medium ${c.id === myCol ? "text-ink" : ""}`}>
                    {c.label}{c.id === myCol ? " (you)" : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ROWS.map((r) => (
                <tr key={r.action} className="border-b border-line/60">
                  <td className="py-2 pr-3">{r.action}</td>
                  {COLS.map((c) => {
                    const v = r.cells[c.id];
                    const tone = v === "no" || v === "-" ? "text-muted" : "text-ink";
                    return <td key={c.id} className={`py-2 pr-3 ${tone} ${c.id === myCol ? "bg-code/5 font-medium" : ""}`}>{v}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {me ? <p className="mt-3 text-xs text-muted">You are signed in as {me.display_name} ({ROLE_LABEL[me.role]}); your column is highlighted.</p> : null}
      </Card>

      <Card title="What goes on chain">
        <ul className="flex flex-col gap-2 text-sm">
          {ON_CHAIN.map(([k, v]) => (
            <li key={k}><b>{k}.</b> <span className="text-muted">{v}</span></li>
          ))}
        </ul>
        <p className="mt-3 text-sm">Never on chain: names, raw claims, evidence text, scores in clear, or employee ids.</p>
      </Card>
    </div>
  );
}
