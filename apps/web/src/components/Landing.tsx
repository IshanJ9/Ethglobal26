"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { usePublicConfig } from "@/lib/config";

// Public landing page (signed-out visitors on /). Copy follows the Proofwork design file;
// live/mock labels and contract addresses come from the running API, so the page cannot overclaim.

type Mode = "live" | "mock" | "unknown";

const STAGES: { cap: string; who: string; what: string }[] = [
  { cap: "Collect", who: "Evidence agent", what: "Merged PRs, closed tickets, CRM deals and HR records enter the ledger, each encrypted under its own key." },
  { cap: "Co-sign", who: "Client co-signer", what: "Work only a client can confirm becomes a claim. The client signs it with World ID from a one-time link." },
  { cap: "Score", who: "Deterministic engine", what: "Integer arithmetic over verified evidence, inside the peer cluster. The plan's formula hash is published on ENS." },
  { cap: "Approve", who: "Manager", what: "A verified human approves the scorecard with World ID. The proof is bound to that exact scorecard hash." },
  { cap: "Attest", who: "Arc registry", what: "Score commitment, evidence root and formula hash are attested on Arc. No names, no raw scores." },
  { cap: "Pay", who: "BonusVault", what: "USDC is released with a 20% holdback. A reverted PR later forfeits the difference on chain." },
  { cap: "Review", who: "Review agent on 0G", what: "After HR approves the run with Agent Pass, the agent reads the encrypted vault and drafts the review. Every number is checked." },
  { cap: "Anchor", who: "HR and employee", what: "HR anchors the review hash on Arc with World ID. The employee acknowledges it, also with World ID." },
  { cap: "Prove", who: "Employee", what: "A zero-knowledge proof shows “score ≥ 80%” to a bank or recruiter without revealing the score." },
];

const PROBLEMS = [
  { t: "Invisible work", d: "Work done in chats and calls leaves no record anyone can point to." },
  { t: "Opaque numbers", d: "Scores come out of spreadsheets and judgement calls nobody can reproduce." },
  { t: "Quiet changes", d: "Payouts can be altered after the fact, with no trail." },
];

const FLOW = [
  ["Evidence", "GitHub, tickets, CRM, HR, claims"],
  ["Ledger", "Encrypted, committed, hash-chained"],
  ["Claims", "AI-drafted, co-signed"],
  ["Engine", "Deterministic score"],
  ["Approve and attest", "World ID, then Arc registry"],
  ["Vault", "USDC release, holdback"],
  ["Verify", "Public, no login"],
];

const STEPS: { t: string; line: string; detail: string[] }[] = [
  { t: "Evidence comes in", line: "Official systems count at once. Chat and typed claims wait for a co-signer.", detail: [
    "Official: GitHub merged PRs and reviews, tickets, CRM deals, HR records. They enter the ledger as verified.",
    "Informal: text in the app, Telegram, WhatsApp exports become claims. A claim never counts on its own.",
    "The GitHub webhook checks signatures and stores a repeated event once.",
    "The Telegram bot masks phone numbers, emails, card and ID numbers before anything leaves the chat.",
  ] },
  { t: "The ledger keeps it private", line: "Encrypted per record, hash-chained, with Merkle roots anchored on Arc.", detail: [
    "Each record has its own key. Deleting the key makes it unreadable for good (crypto-shredding).",
    "A salted commitment proves a record existed without revealing it.",
    "Records are hash-chained, so editing history breaks the chain and verify catches it.",
    "An encrypted copy goes to 0G Storage and is read back and checked before the AI uses it.",
  ] },
  { t: "Claims are drafted and co-signed", line: "The AI drafts the structure. The employee signs. A co-signer confirms.", detail: [
    "The AI on 0G turns the text into kind, summary, date, duration and counterparty. It flags prompt injection and low confidence.",
    "The AI never sets a KRA, an amount or a state.",
    "The employee signs an EIP-712 message covering commitments, not raw text.",
    "A one-time link goes to the co-signer, who signs or declines with World ID.",
  ] },
  { t: "The engine computes the score", line: "Plain integer code, no AI. The same inputs always give the same score.", detail: [
    "Each plan is a published formula; its hash is part of the proof and is listed on ENS.",
    "People are compared only inside their peer cluster (department and level).",
    "If too little evidence is verified, the multiplier is 0.",
    "Bonus = target × multiplier, from a payout curve that never goes down as the score rises.",
  ] },
  { t: "A person decides, the chain records", line: "A manager approves with World ID. The scorecard is attested on Arc.", detail: [
    "Nobody approves their own scorecard.",
    "On chain: pseudonymous subject ID, score commitment, evidence root, formula hash, approval proof hash, multiplier.",
    "The review agent runs only after HR approves that run with World ID Agent Pass.",
    "A revision creates v2 and supersedes the old attestation.",
  ] },
  { t: "The vault pays in USDC", line: "BonusVault releases the entitlement and holds part back.", detail: [
    "Release pays out and holds back a share (20% for 90 days on the engineering plan).",
    "A downward revision forfeits the difference; an upward one pays the extra.",
    "A dispute freezes payout until HR resolves it.",
    "An AI agent can propose a bonus-pool split; only HR can approve it.",
  ] },
  { t: "Anyone verifies", line: "No login. Paste an ID and re-check it against the chain.", detail: [
    "Checks: commitment, Merkle proof, anchored root, not revoked, signatures, hash chain, formula hash, shredded or not.",
    "Nothing private is revealed. With a reveal (value plus salt) it also proves the content matches.",
    "An employee's zero-knowledge proof is checked by a verifier contract on Arc.",
  ] },
];

const DEMO = [
  { who: "Asha", t: "files a claim", d: "The AI draft appears with flags. She signs and gets a co-sign link." },
  { who: "The client", t: "co-signs on a phone", d: "The client CFO opens the link and signs with World ID. The claim becomes verified." },
  { who: "Elena", t: "runs the agent", d: "Watch the trace and the agent's ENS identity, then create the scorecard." },
  { who: "Elena", t: "approves and pays", d: "World ID approval, attestation on Arc, then release with holdback." },
  { who: "A PR", t: "is reverted", d: "The scorecard needs revision. v2 shows the score drop and the forfeit." },
  { who: "Anyone", t: "verifies", d: "Paste the scorecard ID and see every check pass, with no login." },
];

const REPO = [
  ["apps/api", "Backend: engine, ledger, review layer, the only chain sender"],
  ["apps/web", "This frontend"],
  ["apps/ingest", "GitHub webhook and Telegram bot"],
  ["contracts", "AttestationRegistry, BonusVault, ZK score proofs"],
  ["spec", "Frozen OpenAPI spec, ABIs, test vectors"],
];

const ROADMAP = ["Real SSO", "Slack connector", "Jira connector", "WhatsApp Business API", "Multi-party ZK setup"];

function H2({ children }: { children: ReactNode }) {
  return (
    <h2 className="m-0 max-w-[820px] text-balance font-display text-[clamp(36px,4.4vw,60px)] font-light leading-[1.02] tracking-[-0.02em]">
      {children}
    </h2>
  );
}

function Band({ id, tinted, children }: { id?: string; tinted?: boolean; children: ReactNode }) {
  return (
    <section id={id} className={`bleed scroll-mt-20 ${tinted ? "border-y border-line bg-surface" : ""}`}>
      <div className="mx-auto flex max-w-[1240px] flex-col gap-12 px-5 py-[clamp(72px,9vw,110px)] sm:px-10">{children}</div>
    </section>
  );
}

function ModePill({ mode }: { mode: Mode }) {
  const live = mode === "live";
  return (
    <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 font-mono text-[11.5px] tracking-[0.08em] ${live ? "border-accent text-accent" : "border-warn text-warn"}`}>
      <span aria-hidden className={`h-[7px] w-[7px] ${live ? "rounded-full bg-accent" : "bg-warn"}`} />
      {mode === "unknown" ? "Unknown" : live ? "Live" : "Mock"}
    </span>
  );
}

function short(a?: string | null) {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "";
}

function Lifecycle() {
  const [i, setI] = useState(0);
  const s = STAGES[i]!;
  const step = (d: number) => setI((x) => (x + d + STAGES.length) % STAGES.length);
  return (
    <div className="overflow-hidden rounded-[14px] border border-line bg-surface shadow-[0_40px_80px_-40px_rgb(var(--shadow)/0.6)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3 font-mono text-[11px] text-muted">
        <span>Bonus lifecycle · step {i + 1} of {STAGES.length}</span>
        <span className="flex gap-1.5">
          <button type="button" onClick={() => step(-1)} aria-label="Previous step" className="rounded-full border border-line px-3 py-1 text-ink hover:border-accent">‹ Prev</button>
          <button type="button" onClick={() => step(1)} aria-label="Next step" className="rounded-full border border-line px-3 py-1 text-ink hover:border-accent">Next ›</button>
        </span>
      </div>
      <ol className="grid grid-cols-3 gap-px bg-line sm:grid-cols-9" aria-label="Lifecycle steps">
        {STAGES.map((st, k) => (
          <li key={st.cap} className="bg-surface">
            <button
              type="button"
              onClick={() => setI(k)}
              aria-current={k === i ? "step" : undefined}
              className={`h-full w-full px-1 py-2.5 text-center font-mono text-[11px] ${k === i ? "bg-accent text-on-accent" : k < i ? "text-ink" : "text-faint"} hover:text-accent`}
            >
              {st.cap}
            </button>
          </li>
        ))}
      </ol>
      <div className="flex min-h-[230px] flex-col justify-between gap-6 p-6 sm:p-8" aria-live="polite">
        <div className="flex flex-col gap-3">
          <span className="text-sm text-muted">{s.who}</span>
          <p className="m-0 font-display text-[clamp(24px,2.4vw,32px)] font-light leading-[1.15]">{s.what}</p>
        </div>
        <div className="flex items-center gap-2 font-mono text-[11px] text-faint">
          <span className="h-px flex-1 bg-line" />
          proofwork-demo.eth
        </div>
      </div>
    </div>
  );
}

export function Landing() {
  const { data: cfg } = usePublicConfig();
  const [open, setOpen] = useState(0);
  const m = (v?: "live" | "mock"): Mode => v ?? "unknown";
  const explorer = cfg?.chain.explorer_base_url ?? null;
  const ensLive: Mode = cfg ? (cfg.ens && cfg.ens.network && cfg.ens.network !== "none" ? "live" : "mock") : "unknown";
  const divisor = cfg?.chain.amount_divisor ?? 1;

  const sponsors = [
    {
      name: "Arc", mode: m(cfg?.chain_mode),
      use: "AttestationRegistry (evidence roots, score attestations, review anchors), BonusVault (USDC release, holdback, clawback, disputes), ZK score proofs, and a BonusPool built in Arc Studio.",
      where: "Scorecard attestation tx, payout txs, review anchors, the verify page.",
      proof: cfg ? `Registry ${short(cfg.contracts.registry)} · Vault ${short(cfg.contracts.vault)}` : "Contract addresses load from the API",
    },
    {
      name: "World", mode: m(cfg?.world_mode),
      use: "World ID step-ups so a unique human makes each decision: approve a scorecard, co-sign a claim, anchor and acknowledge a review. Agent Pass gates the review agent.",
      where: "Approval screen, co-sign page, review anchor and acknowledgement, the Agent Pass checkpoint.",
      proof: "Each proof is bound to the hash being decided and used once.",
    },
    {
      name: "0G", mode: m(cfg?.zerog_mode),
      use: "Private Computer for claim drafting, review reasoning and the evidence agent. Storage for an encrypted copy of every record.",
      where: "Claim “AI drafted on 0G” trace; review reasoning; evidence replica status.",
      proof: "Provider, request ID and response key are shown. We do not claim a TEE verdict the router does not report.",
    },
    {
      name: "ENS", mode: ensLive,
      use: `Readable identity under ${cfg?.ens?.parent_name ?? "proofwork-demo.eth"}: people, clusters with their plan hash, agents with their prompt hash, and review credentials.`,
      where: "Headers, team list, run traces, co-sign requester, the directory.",
      proof: cfg?.agent.ens_name ?? "kra-agent.proofwork-demo.eth",
    },
  ];

  const proofs: { t: string; v: string; href: string; external: boolean }[] = [
    ...(cfg && explorer
      ? [
          { t: "Arc explorer: registry", v: cfg.contracts.registry, href: `${explorer}/address/${cfg.contracts.registry}`, external: true },
          { t: "Arc explorer: vault", v: cfg.contracts.vault, href: `${explorer}/address/${cfg.contracts.vault}`, external: true },
        ]
      : []),
    ...(cfg?.agent.ens_name
      ? [{ t: "ENS names", v: `${cfg.agent.ens_name} on Sepolia`, href: `https://sepolia.app.ens.domains/${cfg.agent.ens_name}`, external: true }]
      : []),
    { t: "Verify a record", v: "Public verify page. No login.", href: "/verify", external: false },
    { t: "Verify a score proof", v: "Check a zero-knowledge “score ≥ X” proof.", href: "/prove/verify", external: false },
  ];

  return (
    <div className="-my-8">
      {/* Hero */}
      <section className="bleed border-b border-line">
        <div className="mx-auto grid max-w-[1240px] items-center gap-14 px-5 py-[clamp(56px,9vw,120px)] sm:px-10 lg:grid-cols-2">
          <div className="flex flex-col gap-7">
            <p className="m-0 text-sm text-muted">
              <span className="text-accent">Verifiable bonuses</span> · ETHGlobal Mumbai 2026
            </p>
            <h1 className="m-0 text-balance font-display text-[clamp(48px,6.4vw,92px)] font-light leading-[0.96] tracking-[-0.025em]">
              Bonuses you can <em className="text-accent">prove.</em>
            </h1>
            <p className="m-0 max-w-[540px] text-[clamp(17px,1.5vw,20px)] leading-[1.55] text-ink-2">
              Proofwork turns work evidence into a deterministic score, a human-approved scorecard and a USDC payout, with every step checkable by anyone and no private data revealed.
            </p>
            <div className="flex flex-wrap gap-3">
              <Link href="/login" className="inline-flex items-center gap-2.5 rounded-full bg-accent px-6 py-[15px] text-[15px] font-semibold text-on-accent hover:bg-accent-hover hover:text-on-accent">
                Try it live
              </Link>
              <Link href="/verify" className="inline-flex items-center gap-2.5 rounded-full border border-ink/30 px-[22px] py-[14px] text-[15px] text-ink hover:border-accent">
                Verify a record
              </Link>
            </div>
            <p className="m-0 font-mono text-[12px] text-faint">Agents collect. Code computes. Humans decide. Chain proves.</p>
          </div>
          <Lifecycle />
        </div>
      </section>

      {/* Problem */}
      <Band id="problem">
        <H2>Bonuses and appraisals rest on evidence <em className="text-accent">nobody can check.</em></H2>
        <div className="grid border-t border-line sm:grid-cols-3">
          {PROBLEMS.map((p) => (
            <div key={p.t} className="flex flex-col gap-3 py-7 pr-7">
              <h3 className="m-0 font-display text-[28px] font-normal">{p.t}</h3>
              <p className="m-0 text-[15px] leading-[1.55] text-muted">{p.d}</p>
            </div>
          ))}
        </div>
      </Band>

      {/* How it works */}
      <Band id="how" tinted>
        <div className="grid items-end gap-x-14 gap-y-6 lg:grid-cols-2">
          <H2>Seven steps from evidence to <em className="text-accent">proof.</em></H2>
          <p className="m-0 max-w-[520px] text-[17px] leading-[1.6] text-ink-2">One line per step. Open any step for the detail.</p>
        </div>
        <ol className="grid gap-2.5 font-mono text-xs sm:grid-cols-2 lg:grid-cols-4">
          {FLOW.map(([k, v], i) => (
            <li key={k} className="flex flex-col gap-1.5 rounded-[10px] border border-line px-4 py-3.5">
              <span className="text-faint">{i + 1}. {k}</span>
              <span className="text-[13px] leading-[1.4] text-ink">{v}</span>
            </li>
          ))}
        </ol>
        <div className="flex flex-col border-t border-line">
          {STEPS.map((s, i) => {
            const isOpen = open === i;
            return (
              <div key={s.t} className="border-b border-line">
                <button
                  type="button"
                  onClick={() => setOpen(isOpen ? -1 : i)}
                  aria-expanded={isOpen}
                  className="grid w-full grid-cols-[40px_minmax(0,1fr)_auto] items-baseline gap-4 bg-transparent py-[22px] text-left text-ink"
                >
                  <span className="font-mono text-[13px] text-faint">{String(i + 1).padStart(2, "0")}</span>
                  <span className="flex flex-col gap-1.5">
                    <span className="font-display text-[28px] leading-tight">{s.t}</span>
                    <span className="text-[15.5px] leading-[1.5] text-ink-2">{s.line}</span>
                  </span>
                  <span className="whitespace-nowrap font-mono text-[12.5px] text-accent">{isOpen ? "Close −" : "Read more +"}</span>
                </button>
                {isOpen ? (
                  <ul className="m-0 flex max-w-[820px] list-disc flex-col gap-2 pb-7 pl-[74px] pr-4 text-[15px] leading-[1.55] text-muted">
                    {s.detail.map((d) => <li key={d}>{d}</li>)}
                  </ul>
                ) : null}
              </div>
            );
          })}
        </div>
      </Band>

      {/* Sponsors */}
      <Band id="sponsors">
        <div className="grid items-end gap-x-14 gap-y-6 lg:grid-cols-2">
          <H2>Four integrations. <em className="text-accent">Each labelled live or mock.</em></H2>
          <p className="m-0 max-w-[520px] text-[17px] leading-[1.6] text-ink-2">Labels come from the running API, so this page can&apos;t overclaim.</p>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {sponsors.map((s) => (
            <article key={s.name} className="flex flex-col gap-[18px] rounded-[14px] border border-line bg-surface p-[26px]">
              <div className="flex items-center justify-between gap-3">
                <h3 className="m-0 font-display text-[32px] font-normal">{s.name}</h3>
                <ModePill mode={s.mode} />
              </div>
              <dl className="m-0 flex flex-col gap-3.5 text-[14.5px] leading-[1.55]">
                <div><dt className="mb-1 text-[13px] text-faint">What we use</dt><dd className="m-0 text-ink-2">{s.use}</dd></div>
                <div><dt className="mb-1 text-[13px] text-faint">Where it appears</dt><dd className="m-0 text-ink-2">{s.where}</dd></div>
              </dl>
              <div className="mt-auto break-words border-t border-line pt-3.5 font-mono text-xs leading-[1.5] text-muted">{s.proof}</div>
            </article>
          ))}
        </div>
      </Band>

      {/* Proof links */}
      <Band id="proof" tinted>
        <H2>Don&apos;t trust us. <em className="text-accent">Click.</em></H2>
        <div className="flex flex-col border-t border-line">
          {proofs.map((p) => {
            const row = (
              <>
                <span className="font-display text-2xl">{p.t}</span>
                <span className="font-mono text-[12.5px] text-muted [overflow-wrap:anywhere]">{p.v}</span>
                <span className="font-mono text-[12.5px] text-accent">{p.external ? "Open ↗" : "Open"}</span>
              </>
            );
            const cls = "grid items-baseline gap-x-6 gap-y-2 border-b border-line py-5 text-ink hover:text-ink sm:grid-cols-[minmax(160px,0.5fr)_minmax(0,1fr)_auto]";
            return p.external ? (
              <a key={p.t} href={p.href} target="_blank" rel="noreferrer" className={cls}>{row}</a>
            ) : (
              <Link key={p.t} href={p.href} className={cls}>{row}</Link>
            );
          })}
        </div>
        {divisor > 1 ? (
          <p className="m-0 text-sm leading-[1.55] text-muted">
            Vault amounts on Arc testnet are scaled 1:{divisor.toLocaleString("en-US")} (testnet funding). The explorer shows each amount divided by {divisor.toLocaleString("en-US")}.
          </p>
        ) : null}
      </Band>

      {/* Privacy */}
      <Band id="privacy">
        <H2>Privacy and honesty, <em className="text-accent">stated plainly.</em></H2>
        <div className="grid gap-4 md:grid-cols-3">
          {[
            { tag: "On chain", round: true, t: "Only commitments", items: ["Commitments and Merkle roots", "Pseudonymous subject IDs", "Multipliers", "Never names or raw scores"] },
            { tag: "Off chain", round: false, t: "Encrypted and deletable", items: ["Records encrypted per record", "Deleting a key shreds the record", "A hash stays, so verify still proves it existed"] },
            { tag: "Limits", round: false, t: "Labelled, never faked", items: ["Every mock carries a Mock label", "No TEE verdict is claimed for 0G", "The ZK trusted setup is single-party"] },
          ].map((c) => (
            <div key={c.t} className="flex flex-col gap-4 rounded-[14px] border border-line p-[26px]">
              <div className="flex items-center gap-2.5 text-sm text-accent">
                <span aria-hidden className={`h-2 w-2 bg-accent ${c.round ? "rounded-full" : ""}`} />
                {c.tag}
              </div>
              <h3 className="m-0 font-display text-[28px] font-normal">{c.t}</h3>
              <ul className="m-0 flex list-disc flex-col gap-2 pl-[18px] text-[15px] leading-[1.55] text-muted">
                {c.items.map((x) => <li key={x}>{x}</li>)}
              </ul>
            </div>
          ))}
        </div>
      </Band>

      {/* Demo */}
      <Band id="demo" tinted>
        <div className="grid items-end gap-x-14 gap-y-6 lg:grid-cols-2">
          <H2>The three-minute <em className="text-accent">walkthrough.</em></H2>
          <p className="m-0 max-w-[520px] text-[17px] leading-[1.6] text-ink-2">Sign in as a team member and follow the story. Nothing to install.</p>
        </div>
        <ol className="flex flex-col border-t border-line">
          {DEMO.map((d, i) => (
            <li key={d.t} className="grid items-baseline gap-x-4 gap-y-1 border-b border-line py-5 sm:grid-cols-[40px_minmax(0,0.6fr)_minmax(0,1fr)]">
              <span className="font-mono text-[13px] text-faint">{String(i + 1).padStart(2, "0")}</span>
              <span className="font-display text-2xl">{d.who} {d.t}</span>
              <span className="text-[15px] leading-[1.55] text-muted">{d.d}</span>
            </li>
          ))}
        </ol>
        <div>
          <Link href="/login" className="inline-flex items-center rounded-full bg-accent px-6 py-[15px] text-[15px] font-semibold text-on-accent hover:bg-accent-hover hover:text-on-accent">
            Sign in as a team member
          </Link>
        </div>
      </Band>

      {/* Repo and roadmap */}
      <Band id="repo">
        <div className="grid gap-14 lg:grid-cols-[3fr_2fr]">
          <div className="flex flex-col gap-8">
            <H2>A frozen spec, guarded by <em className="text-accent">tests.</em></H2>
            <p className="m-0 max-w-[560px] text-[17px] leading-[1.6] text-ink-2">
              The OpenAPI spec and contract ABIs are frozen. The API refuses any route the spec does not define, and the engine is checked against test vectors in two languages.
            </p>
            <dl className="m-0 flex flex-col border-t border-line font-mono text-[13px]">
              {REPO.map(([k, v]) => (
                <div key={k} className="grid gap-x-6 gap-y-1 border-b border-line py-3 sm:grid-cols-[140px_minmax(0,1fr)]">
                  <dt className="text-ink">{k}</dt>
                  <dd className="m-0 text-muted">{v}</dd>
                </div>
              ))}
            </dl>
          </div>
          <div className="flex flex-col gap-6">
            <h2 className="m-0 font-display text-[36px] font-light">Roadmap</h2>
            <p className="m-0 text-sm text-muted">Not built yet.</p>
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {ROADMAP.map((r) => (
                <li key={r} className="hatch-mock rounded-[10px] px-4 py-3 text-[15px]">{r}</li>
              ))}
            </ul>
          </div>
        </div>
      </Band>

      <footer className="bleed border-t border-line">
        <div className="mx-auto flex max-w-[1240px] flex-wrap items-center justify-between gap-4 px-5 py-8 text-sm text-muted sm:px-10">
          <span>Proofwork · ETHGlobal Mumbai 2026</span>
          <span className="flex gap-5">
            <Link href="/verify" className="text-muted hover:text-accent">Verify</Link>
            <Link href="/login" className="text-muted hover:text-accent">Try it live</Link>
            <Link href="/#how" className="text-muted hover:text-accent">How it works</Link>
          </span>
        </div>
      </footer>
    </div>
  );
}
