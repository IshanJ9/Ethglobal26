"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError, unwrap } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { shortHex } from "@/lib/format";
import { DEPARTMENT_LABEL, ROLE_LABEL } from "@/lib/personas";
import { setSession, useSession } from "@/lib/session";

export default function HomePage() {
  const session = useSession();
  const router = useRouter();

  const me = useQuery({
    queryKey: ["me", session?.persona.persona_id],
    queryFn: () => unwrap(api.GET("/v1/me")),
    enabled: !!session,
  });

  useEffect(() => {
    if (!session) router.replace("/login");
  }, [session, router]);

  useEffect(() => {
    if (me.error instanceof ApiError && me.error.code === "unauthorized") {
      setSession(null);
      router.replace("/login");
    }
  }, [me.error, router]);

  if (!session) return null;
  const p = me.data ?? session.persona;

  return (
    <section className="max-w-3xl">
      <h1 className="font-display text-3xl font-semibold tracking-tight">My cycle</h1>
      <p className="mt-2 text-muted">
        Your claims, evidence and scorecard for the current appraisal cycle will appear here.
      </p>

      {me.isError && !(me.error instanceof ApiError && me.error.code === "unauthorized") ? (
        <p role="alert" className="mt-6 text-sm text-danger">{errorMessage(me.error)}</p>
      ) : null}

      <dl className="mt-8 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 rounded-md border border-line bg-surface p-4 text-sm">
        <dt className="text-muted">Signed in as</dt>
        <dd className="font-medium">{p.display_name}</dd>
        <dt className="text-muted">Role</dt>
        <dd>{ROLE_LABEL[p.role]}, {DEPARTMENT_LABEL[p.department]}</dd>
        <dt className="text-muted">Wallet</dt>
        <dd className="font-mono" title={p.wallet_address}>{shortHex(p.wallet_address, 10, 8)}</dd>
        <dt className="text-muted">ENS</dt>
        <dd>{p.ens_name ?? <span className="text-muted">Not resolved</span>}</dd>
        <dt className="text-muted">World ID</dt>
        <dd>{p.world_id_verified ? "Verified human" : <span className="text-muted">Not verified</span>}</dd>
      </dl>
    </section>
  );
}
