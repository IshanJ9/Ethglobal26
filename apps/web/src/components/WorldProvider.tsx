"use client";

import { IDKitRequestWidget, proofOfHuman, type IDKitResult } from "@worldcoin/idkit";
import { useEffect, useRef, useState } from "react";
import { registerLiveWorld, type LiveWorldRequest, type WorldResult } from "@/lib/world";

type Pending = LiveWorldRequest & { resolve: (r: WorldResult) => void; reject: (e: Error) => void };

const ENVIRONMENT = (process.env.NEXT_PUBLIC_WORLD_ENVIRONMENT as "production" | "staging" | undefined) ?? "production";
const ALLOW_LEGACY = process.env.NEXT_PUBLIC_WORLD_ALLOW_LEGACY === "1";

/**
 * Mounts the IDKit widget once and lets requestWorldProof() open it from anywhere (approval, co-sign).
 * The proof is bound to the server's action + signal; the API verifies it with World (WorldVerifier, Agent A).
 */
export function WorldProvider() {
  const [req, setReq] = useState<Pending | null>(null);
  const settled = useRef(false);

  useEffect(() => {
    registerLiveWorld(
      (r) =>
        new Promise<WorldResult>((resolve, reject) => {
          settled.current = false;
          setReq({ ...r, resolve, reject });
        }),
    );
    return () => registerLiveWorld(null);
  }, []);

  if (!req) return null;
  const finish = (fn: () => void) => {
    if (settled.current) return;
    settled.current = true;
    fn();
  };

  return (
    <IDKitRequestWidget
      open
      onOpenChange={(open) => {
        if (!open) {
          finish(() => req.reject(new Error("World verification was closed before it finished.")));
          setReq(null);
        }
      }}
      app_id={req.appId as `app_${string}`}
      action={req.action}
      rp_context={req.rpContext}
      allow_legacy_proofs={ALLOW_LEGACY}
      environment={ENVIRONMENT}
      preset={proofOfHuman({ signal: req.signal })}
      onSuccess={(result: IDKitResult) => {
        finish(() => req.resolve({ adapter: "idkit", payload: result as unknown as Record<string, unknown> }));
        setReq(null);
      }}
      onError={(code) => {
        finish(() => req.reject(new Error(`World verification failed: ${code}`)));
        setReq(null);
      }}
    />
  );
}
