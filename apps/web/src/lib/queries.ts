"use client";

import { useQuery } from "@tanstack/react-query";
import { api, unwrap } from "./api";
import { useSession } from "./session";

// Typed read hooks shared by pages. Keys include the persona so switching persona never shows stale data.

const usePid = () => useSession()?.persona.persona_id;

export function useCycles() {
  const pid = usePid();
  return useQuery({ queryKey: ["cycles", pid], queryFn: () => unwrap(api.GET("/v1/cycles")), enabled: !!pid, staleTime: 60_000 });
}

/** The open cycle shown by default (first open one, else the first). */
export function useCurrentCycle() {
  const q = useCycles();
  const items = q.data?.items ?? [];
  return { ...q, cycle: items.find((c) => c.status === "open") ?? items[0] };
}

export function useEmployees() {
  const pid = usePid();
  return useQuery({ queryKey: ["employees", pid], queryFn: () => unwrap(api.GET("/v1/org/employees")), enabled: !!pid, staleTime: 60_000 });
}

export function usePlan(planId: string | undefined) {
  const pid = usePid();
  return useQuery({
    queryKey: ["plan", planId, pid],
    queryFn: () => unwrap(api.GET("/v1/org/plans/{plan_id}", { params: { path: { plan_id: planId! } } })),
    enabled: !!pid && !!planId,
    staleTime: 300_000,
  });
}

export function useClaims(cycleId?: string) {
  const pid = usePid();
  return useQuery({
    queryKey: ["claims", cycleId, pid],
    queryFn: () => unwrap(api.GET("/v1/claims", { params: { query: { cycle_id: cycleId } } })),
    enabled: !!pid,
  });
}

export function useClaim(id: string) {
  const pid = usePid();
  return useQuery({
    queryKey: ["claim", id, pid],
    queryFn: () => unwrap(api.GET("/v1/claims/{claim_id}", { params: { path: { claim_id: id } } })),
    enabled: !!pid && !!id,
  });
}

export function useEvidence(f: { employee_id?: string; cycle_id?: string }) {
  const pid = usePid();
  return useQuery({
    queryKey: ["evidence", f.employee_id, f.cycle_id, pid],
    queryFn: () => unwrap(api.GET("/v1/evidence", { params: { query: f } })),
    enabled: !!pid,
  });
}

export function useScorecards(f: { employee_id?: string; cycle_id?: string }) {
  const pid = usePid();
  return useQuery({
    queryKey: ["scorecards", f.employee_id, f.cycle_id, pid],
    queryFn: () => unwrap(api.GET("/v1/scorecards", { params: { query: f } })),
    enabled: !!pid,
  });
}

export function useScorecard(id: string) {
  const pid = usePid();
  return useQuery({
    queryKey: ["scorecard", id, pid],
    queryFn: () => unwrap(api.GET("/v1/scorecards/{scorecard_id}", { params: { path: { scorecard_id: id } } })),
    enabled: !!pid && !!id,
  });
}

export function usePayout(scorecardId: string | undefined, enabled = true) {
  const pid = usePid();
  return useQuery({
    queryKey: ["payout", scorecardId, pid],
    queryFn: () => unwrap(api.GET("/v1/payouts/{scorecard_id}", { params: { path: { scorecard_id: scorecardId! } } })),
    enabled: !!pid && !!scorecardId && enabled,
    retry: false,
  });
}
