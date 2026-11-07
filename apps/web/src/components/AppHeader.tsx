"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { setSession, useSession } from "@/lib/session";
import { ROLE_LABEL } from "@/lib/personas";
import { usePublicConfig } from "@/lib/config";
import { useTheme } from "@/lib/theme";
import { ModeBadge } from "./ModeBadge";
import { ProvenanceStrip } from "./ProvenanceStrip";

const NAV = "rounded-lg px-3 py-2 text-muted hover:text-ink";

/** The Proofwork mark: a ring with a dot (from the design file). */
export function Wordmark() {
  return (
    <span className="flex items-center gap-2.5">
      <span aria-hidden className="inline-flex h-[26px] w-[26px] items-center justify-center rounded-full border-2 border-accent">
        <span className="h-2 w-2 rounded-full bg-accent" />
      </span>
      <span className="font-display text-2xl tracking-[-0.01em]">
        Proof<em className="text-accent">work</em>
      </span>
    </span>
  );
}

export function AppHeader() {
  const session = useSession();
  const router = useRouter();
  const qc = useQueryClient();
  const pathname = usePathname();
  const { data: cfg } = usePublicConfig();
  const [theme, toggleTheme] = useTheme();

  function signOut() {
    setSession(null);
    qc.clear();
    router.push("/login");
  }

  // The session lives in sessionStorage, so the server (and a cold load still compiling) cannot know it.
  // Until the client has hydrated, show a neutral header rather than the signed-out one.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  // Signed-out visitors on / see the landing page, which explains the pipeline itself.
  const onLanding = !session && pathname === "/";

  return (
    <header className="sticky top-0 z-20 border-b border-line bg-bar/90 backdrop-blur-md">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-3 sm:px-8">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
          <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
            <Link href="/" className="text-ink hover:text-ink">
              <Wordmark />
            </Link>
            {!hydrated ? (
              <span aria-hidden className="h-5 w-48 rounded-full bg-line/60" />
            ) : session && session.persona.role !== "external_cosigner" ? (
              <nav className="flex flex-wrap text-[15px]">
                <Link href="/" className={NAV}>My cycle</Link>
                <Link href="/claims/new" className={NAV}>New claim</Link>
                {session.persona.role === "manager" || session.persona.role === "hr" ? (
                  <>
                    <Link href="/team" className={NAV}>Team</Link>
                    <Link href="/clusters" className={NAV}>Clusters</Link>
                    <Link href="/org/plans" className={NAV}>Plans</Link>
                  </>
                ) : null}
                <Link href="/reviews" className={NAV}>Reviews</Link>
                <Link href="/org/directory" className={NAV}>Directory</Link>
                {session.persona.role === "hr" ? <Link href="/audit" className={NAV}>Audit</Link> : null}
                <Link href="/privacy" className={NAV}>Privacy</Link>
                <Link href="/verify" className={NAV}>Verify</Link>
              </nav>
            ) : (
              <nav className="flex flex-wrap text-[15px]">
                {!session ? <Link href="/#how" className={NAV}>How it works</Link> : null}
                <Link href="/verify" className={NAV}>Verify</Link>
                {!session ? <Link href="/login" className={NAV}>Try it live</Link> : null}
              </nav>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2.5 text-sm">
            {cfg ? (
              <span className="hidden items-center gap-1.5 lg:flex" aria-label="Integration modes">
                <span className="flex items-center gap-1 text-xs text-muted">Arc <ModeBadge mode={cfg.chain_mode} /></span>
                <span className="flex items-center gap-1 text-xs text-muted">World <ModeBadge mode={cfg.world_mode} /></span>
                <span className="flex items-center gap-1 text-xs text-muted">0G <ModeBadge mode={cfg.zerog_mode} /></span>
              </span>
            ) : null}
            <button
              type="button"
              onClick={toggleTheme}
              aria-label="Toggle light and dark mode"
              className="rounded-lg border border-line bg-surface px-3 py-1.5 text-ink hover:border-accent"
            >
              {theme === "dark" ? "Light" : "Dark"}
            </button>
            {hydrated && session ? (
              <>
                <span className="flex flex-col items-end leading-tight">
                  <span className="font-medium">{session.persona.display_name}</span>
                  <span className="text-xs text-muted">{ROLE_LABEL[session.persona.role]}</span>
                </span>
                <button onClick={signOut} className="rounded-lg border border-line bg-surface px-3 py-1.5 text-ink hover:border-accent">
                  Switch persona
                </button>
              </>
            ) : null}
          </div>
        </div>
        {!hydrated || onLanding ? null : <ProvenanceStrip />}
      </div>
    </header>
  );
}
