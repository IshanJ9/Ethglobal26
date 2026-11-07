"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { errorMessage } from "@/lib/errors";
import { formatUsdc, shortHex } from "@/lib/format";

// Shared building blocks, styled to the Proofwork design (Newsreader display, Plex body, pill actions).

export function PageTitle({ title, sub, right }: { title: ReactNode; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-balance font-display text-[clamp(34px,4vw,48px)] font-light leading-[1.02] tracking-[-0.02em]">{title}</h1>
        {sub ? <p className="mt-2 max-w-2xl text-ink-2">{sub}</p> : null}
      </div>
      {right}
    </div>
  );
}

export function Card({ title, right, children, className = "" }: { title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-[14px] border border-line bg-surface p-5 sm:p-6 ${className}`}>
      {title || right ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          {title ? <h2 className="font-display text-2xl font-normal leading-tight">{title}</h2> : <span />}
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
      <div className="text-sm text-muted">{label}</div>
      <div className="mt-1 font-display text-[34px] font-light leading-none tabular-nums">{value}</div>
      {sub ? <div className="mt-1.5 text-xs text-muted">{sub}</div> : null}
    </div>
  );
}

export function Money({ amount, className = "" }: { amount: string | null | undefined; className?: string }) {
  if (amount == null) return <span className="text-muted">-</span>;
  return <span className={`tabular-nums ${className}`}>{formatUsdc(amount)}</span>;
}

type Tone = "ok" | "warn" | "bad" | "info" | "neutral";
const TONE: Record<Tone, string> = {
  ok: "border-ok text-ok",
  warn: "border-warn text-warn",
  bad: "border-danger text-danger",
  info: "border-code text-code",
  neutral: "border-muted/60 text-muted",
};
// The design marks each state with a glyph as well as a colour, so it reads without colour too.
const TONE_GLYPH: Record<Tone, string> = { ok: "✓", warn: "!", bad: "✕", info: "●", neutral: "○" };
const STATUS_TONE: Record<string, Tone> = {
  verified: "ok", vested: "ok", approved: "ok", attested: "ok", active: "info", closed: "neutral", succeeded: "ok",
  submitted: "info", pending_cosign: "info", pending_approval: "info", pending: "info", registered: "info", provisional: "info", running: "info", queued: "info",
  drafted: "neutral", draft: "neutral", none: "neutral", unverified: "neutral", superseded: "neutral", cancelled: "neutral",
  declined: "bad", denied: "bad", rejected: "bad", reverted: "bad", revoked: "bad", failed: "bad", expired: "warn", disputed: "warn", shredded: "warn",
};

export function StatusChip({ status, tone }: { status: string; tone?: Tone }) {
  const t = tone ?? STATUS_TONE[status] ?? "neutral";
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[13px] font-medium ${TONE[t]}`}>
      <span aria-hidden className="text-[11px]">{TONE_GLYPH[t]}</span>
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
        <a href={href} target="_blank" rel="noreferrer" className="underline decoration-line underline-offset-[3px] hover:text-accent hover:decoration-accent" title={value}>
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
        className="rounded px-1 text-faint hover:text-accent"
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
    primary: "border border-accent bg-accent font-semibold text-on-accent hover:border-accent-hover hover:bg-accent-hover",
    secondary: "border border-line bg-surface text-ink hover:border-accent",
    danger: "border border-danger bg-transparent text-danger hover:bg-danger/10",
  }[kind];
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={`whitespace-nowrap rounded-full px-5 py-2.5 text-[15px] font-medium leading-tight disabled:cursor-not-allowed disabled:opacity-50 ${k} ${className}`}>
      {children}
    </button>
  );
}

export function ErrorNote({ error, className = "" }: { error: unknown; className?: string }) {
  if (!error) return null;
  return (
    <p role="alert" className={`rounded-[10px] border border-danger/60 bg-danger/10 px-3 py-2 text-sm text-danger ${className}`}>
      {errorMessage(error)}
    </p>
  );
}

export function Loading({ what = "Loading" }: { what?: string }) {
  return <p className="animate-pulse text-sm text-muted">{what}…</p>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-[10px] border border-dashed border-muted/50 px-3 py-5 text-center text-sm text-muted">{children}</p>;
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
    <Link href={href} className="text-accent underline decoration-accent/40 underline-offset-[3px] hover:decoration-accent">
      {children}
    </Link>
  );
}
