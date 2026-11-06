"use client";

import { useRef } from "react";
import { useMutation, type UseMutationOptions } from "@tanstack/react-query";
import { ApiError } from "./api";

/**
 * One Idempotency-Key per user action (docs/api-notes.md, INTEGRATION 5.8).
 *
 * A key is minted when the user starts an action and is reused for every attempt of that same action: automatic
 * retries, double clicks while in flight, and a manual "try again" after a retryable failure (network, 429, 5xx).
 * The server replays the first 2xx for a reused key, so none of these can apply the action twice.
 * The key is dropped after success or a non-retryable error, and whenever the inputs change: reusing a key with a
 * different body is a 409 on the server.
 */
export function isRetryable(e: unknown): boolean {
  if (!(e instanceof ApiError)) return false;
  return e.code === "network" || e.status === 429 || e.status >= 500;
}

/** Request options that attach the action's key; spread into `api.POST(path, { body, ...idem(key) })`. */
export const idem = (key: string) => ({ headers: { "Idempotency-Key": key } });

export function useAction<V, R>(
  fn: (vars: V, idempotencyKey: string) => Promise<R>,
  options: Omit<UseMutationOptions<R, Error, V>, "mutationFn" | "retry"> = {},
) {
  const current = useRef<{ sig: string; key: string } | null>(null);
  const { onSuccess, onError, ...rest } = options;

  return useMutation<R, Error, V>({
    ...rest,
    mutationFn: (vars) => {
      const sig = JSON.stringify(vars ?? null);
      if (!current.current || current.current.sig !== sig) current.current = { sig, key: crypto.randomUUID() };
      return fn(vars, current.current.key);
    },
    // Retries call mutationFn again with the same vars, so they carry the same key.
    retry: (failures, e) => failures < 2 && isRetryable(e),
    retryDelay: (n) => 400 * 2 ** n,
    onSuccess: (...a) => {
      current.current = null;
      return onSuccess?.(...a);
    },
    onError: (...a) => {
      if (!isRetryable(a[0])) current.current = null;
      return onError?.(...a);
    },
  });
}
