"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError, type Persona } from "./api";
import { getSession, setSession, useSession } from "./session";

/** Pages that need a signed-in persona: redirects to /login when there is none. */
export function useRequireSession(): Persona | null {
  const session = useSession();
  const router = useRouter();
  useEffect(() => {
    // useSyncExternalStore reports null during hydration; read storage directly before redirecting.
    if (!session && !getSession()) router.replace("/login");
  }, [session, router]);
  return session?.persona ?? null;
}

/** Drop the session and go to /login when any of these errors is `unauthorized` (expired JWT). */
export function useSignOutOnUnauthorized(...errors: unknown[]) {
  const router = useRouter();
  const qc = useQueryClient();
  const expired = errors.some((e) => e instanceof ApiError && e.code === "unauthorized");
  useEffect(() => {
    if (expired) {
      setSession(null);
      qc.clear();
      router.replace("/login");
    }
  }, [expired, router, qc]);
}

export const isManager = (p: Persona | null) => p?.role === "manager" || p?.role === "hr";
