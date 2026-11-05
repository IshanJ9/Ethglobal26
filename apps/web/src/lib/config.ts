"use client";

import { useQuery } from "@tanstack/react-query";
import { api, getLastSpecHeader, SPEC_MAJOR, unwrap } from "./api";

/** Chain id, contract addresses and the EIP-712 domain come only from here (AGENT_B rule 4). */
export function usePublicConfig() {
  return useQuery({
    queryKey: ["config", "public"],
    queryFn: () => unwrap(api.GET("/v1/config/public")),
    staleTime: 60_000,
  });
}

export type Handshake =
  | { state: "checking" }
  | { state: "ok"; serverVersion: string }
  | { state: "mismatch"; serverVersion: string }
  | { state: "unknown"; serverVersion: string }
  | { state: "unreachable"; error: unknown };

const major = (v: string) => Number.parseInt(v.split(".")[0] ?? "", 10);

/** Spec handshake: compare the server's major with SPEC_MAJOR (INTEGRATION 5.9). */
export function useSpecHandshake(): Handshake {
  const q = useQuery({
    queryKey: ["healthz"],
    queryFn: () => unwrap(api.GET("/healthz")),
    refetchInterval: 30_000,
    retry: 1,
  });
  if (q.isPending) return { state: "checking" };
  if (q.isError) return { state: "unreachable", error: q.error };
  const serverVersion = getLastSpecHeader() ?? q.data.spec_version;
  // A non-semver value (e.g. a schema-only mock) is reported, not treated as a mismatch.
  if (!/^\d+\.\d+\.\d+/.test(serverVersion)) return { state: "unknown", serverVersion };
  return major(serverVersion) === SPEC_MAJOR
    ? { state: "ok", serverVersion }
    : { state: "mismatch", serverVersion };
}
