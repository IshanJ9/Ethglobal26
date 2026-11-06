"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { errorMessage } from "@/lib/errors";
import { formatUsdc, shortHex } from "@/lib/format";

// Small shared building blocks. Plain styling for now; the Apple-style pass restyles these in one place.

export function PageTitle({ title, sub, right }: { title: ReactNode; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="font-display text-3xl font-semibold tracking-tight">{title}</h1>
        {sub ? <p className="mt-1 text-muted">{sub}</p> : null}
      </div>
      {right}
    </div>
  );
}

export function Card({ title, right, children, className = "" }: { title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg border border-line bg-surface p-4 ${className}`}>
      {title || right ? (
        <div className="mb-3 flex items-center justify-between gap-3">
          {title ? <h2 className="font-display text-lg font-semibold">{title}</h2> : <span />}
          {right}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-0.5 font-display text-2xl font-semibold tabular-nums">{value}</div>
      {sub ? <div className="text-xs text-muted">{sub}</div> : null}
    </div>
  );
}

export function Money({ amount, className = "" }: { amount: string | null | undefined; className?: string }) {
  if (amount == null) return <span className="text-muted">-</span>;
  return <span className={`tabular-nums ${className}`}>{formatUsdc(amount)}</span>;
}

type Tone = "ok" | "warn" | "bad" | "info" | "neutral";
const TONE: Record<Tone, string> = {
  ok: "border-chain/40 bg-chain/10 text-chain",
  warn: "border-human/40 bg-human/10 text-human",
  bad: "border-danger/40 bg-danger/10 text-danger",
  info: "border-code/40 bg-code/10 text-code",
  neutral: "border-line bg-paper text-muted",
};
const STATUS_TONE: Record<string, Tone> = {
  verified: "ok", vested: "ok", approved: "ok", attested: "ok", active: "info", closed: "neutral", succeeded: "ok",
  submitted: "info", pending_cosign: "info", pending_approval: "info", pending: "info", registered: "info", provisional: "info", running: "info", queued: "info",
  drafted: "neutral", draft: "neutral", none: "neutral", unverified: "neutral", superseded: "neutral", cancelled: "neutral",
  declined: "bad", denied: "bad", rejected: "bad", reverted: "bad", revoked: "bad", failed: "bad", expired: "warn", disputed: "warn", shredded: "warn",
};

export function StatusChip({ status, tone }: { status: string; tone?: Tone }) {
  const t = tone ?? STATUS_TONE[status] ?? "neutral";
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${TONE[t]}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

export function HashPill({ value, href, head = 6, tail = 4 }: { value: string | null | undefined; href?: string | null; head?: number; tail?: number }) {
  const [copied, setCopied] = useState(false);
  if (!value) return <span className="text-muted">-</span>;
  const text = shortHex(value, head, tail);
  return (
    <span className="inline-flex items-center gap-1 font-mono text-xs">
      {href ? (
        <a href={href} target="_blank" rel="noreferrer" className="underline decoration-line underline-offset-2 hover:decoration-ink" title={value}>
          {text}
        </a>
      ) : (
        <span title={value}>{text}</span>
      )}
      <button
        type="button"
        aria-label="Copy"
        onClick={() => {
          navigator.clipboard?.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          });
        }}
        className="rounded px-1 text-muted hover:text-ink"
      >
        {copied ? "copied" : "copy"}
      </button>
    </span>
  );
}

export function Button({
  children, onClick, disabled, kind = "primary", type = "button", className = "",
}: { children: ReactNode; onClick?: () => void; disabled?: boolean; kind?: "primary" | "secondary" | "danger"; type?: "button" | "submit"; className?: string }) {
  const k = {
    primary: "bg-ink text-surface hover:bg-ink/90",
    secondary: "border border-line bg-surface hover:border-ink",
    danger: "border border-danger/50 bg-surface text-danger hover:bg-danger/10",
  }[kind];
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={`rounded-md px-3.5 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${k} ${className}`}>
      {children}
    </button>
  );
}

export function ErrorNote({ error, className = "" }: { error: unknown; className?: string }) {
  if (!error) return null;
  return (
    <p role="alert" className={`rounded border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger ${className}`}>
      {errorMessage(error)}
    </p>
  );
}

export function Loading({ what = "Loading" }: { what?: string }) {
  return <p className="animate-pulse text-sm text-muted">{what}…</p>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded border border-dashed border-line px-3 py-4 text-center text-sm text-muted">{children}</p>;
}

/** Who produced a value (UX rule: every input says where it came from). */
export function ActorTag({ actor, label }: { actor: "ai" | "code" | "human" | "chain"; label: string }) {
  const c = { ai: "bg-ai", code: "bg-code", human: "bg-human", chain: "bg-chain" }[actor];
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted">
      <span aria-hidden className={`h-2 w-2 rounded-full ${c}`} />
      {label}
    </span>
  );
}

export function TextLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="text-code underline decoration-code/30 underline-offset-2 hover:decoration-code">
      {children}
    </Link>
  );
}
