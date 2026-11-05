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
          <Link href="/" className="font-display text-2xl font-bold tracking-tight">
            Proofwork
          </Link>
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
