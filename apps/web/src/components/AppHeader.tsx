"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { setSession, useSession } from "@/lib/session";
import { ROLE_LABEL } from "@/lib/personas";
import { ProvenanceStrip } from "./ProvenanceStrip";

export function AppHeader() {
  const session = useSession();
  const router = useRouter();
  const qc = useQueryClient();

  function signOut() {
    setSession(null);
    qc.clear();
    router.push("/login");
  }

  return (
    <header className="border-b border-line bg-paper">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 pb-3 pt-4">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div className="flex items-baseline gap-6">
            <Link href="/" className="font-display text-2xl font-bold tracking-tight">
              Proofwork
            </Link>
            {session && session.persona.role !== "external_cosigner" ? (
              <nav className="flex gap-4 text-sm">
                <Link href="/" className="text-muted hover:text-ink">My cycle</Link>
                <Link href="/claims/new" className="text-muted hover:text-ink">New claim</Link>
                {session.persona.role === "manager" || session.persona.role === "hr" ? (
                  <>
                    <Link href="/team" className="text-muted hover:text-ink">Team</Link>
                    <Link href="/clusters" className="text-muted hover:text-ink">Clusters</Link>
                    <Link href="/org/plans" className="text-muted hover:text-ink">Plans</Link>
                  </>
                ) : null}
                <Link href="/reviews" className="text-muted hover:text-ink">Reviews</Link>
                <Link href="/org/directory" className="text-muted hover:text-ink">Directory</Link>
                {session.persona.role === "hr" ? <Link href="/audit" className="text-muted hover:text-ink">Audit</Link> : null}
                <Link href="/privacy" className="text-muted hover:text-ink">Privacy</Link>
                <Link href="/verify" className="text-muted hover:text-ink">Verify</Link>
              </nav>
            ) : (
              <nav className="flex gap-4 text-sm">
                <Link href="/verify" className="text-muted hover:text-ink">Verify</Link>
              </nav>
            )}
          </div>
          {session ? (
            <div className="flex items-center gap-3 text-sm">
              <span className="flex flex-col items-end leading-tight">
                <span className="font-medium">{session.persona.display_name}</span>
                <span className="text-xs text-muted">{ROLE_LABEL[session.persona.role]}</span>
              </span>
              <button onClick={signOut} className="rounded border border-line bg-surface px-2.5 py-1 hover:border-ink">
                Switch persona
              </button>
            </div>
          ) : null}
        </div>
        <ProvenanceStrip />
      </div>
    </header>
  );
}
