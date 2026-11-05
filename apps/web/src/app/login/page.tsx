"use client";

import { useRouter } from "next/navigation";
import { useMutation } from "@tanstack/react-query";
import { api, ApiError, unwrap, type Persona } from "@/lib/api";
import { usePublicConfig } from "@/lib/config";
import { errorMessage } from "@/lib/errors";
import { shortHex } from "@/lib/format";
import { DEPARTMENT_LABEL, PERSONAS, ROLE_LABEL } from "@/lib/personas";
import { setSession } from "@/lib/session";

const GROUP_ORDER: Persona["department"][] = ["software", "sales", "marketing", "hr", "external"];

export default function LoginPage() {
  const router = useRouter();
  const { data: cfg } = usePublicConfig();

  const login = useMutation({
    mutationFn: (persona_id: Persona["persona_id"]) =>
      unwrap(api.POST("/v1/dev/login", { body: { persona_id } })),
    onSuccess: ({ token, persona }) => {
      setSession({ token, persona });
      router.push("/");
    },
  });

  if (cfg && cfg.auth_mode !== "dev") {
    return (
      <section className="max-w-xl">
        <h1 className="font-display text-3xl font-semibold">Sign in</h1>
        <p className="mt-3 text-muted">
          {cfg.org_name} uses single sign-on. Company SSO is not connected in this build.
        </p>
      </section>
    );
  }

  return (
    <section>
      <div className="max-w-2xl">
        <h1 className="font-display text-3xl font-semibold tracking-tight">Choose who you are</h1>
        <p className="mt-2 text-muted">
          Demo sign-in for {cfg?.org_name ?? "the seeded company"}. Each person has their own role,
          reporting line and demo signing key, so what you see changes with who you pick.
        </p>
      </div>

      {login.isError ? (
        <p role="alert" className="mt-6 rounded border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          {login.error instanceof ApiError && login.error.code === "not_found"
            ? "Demo sign-in is not available on this API yet. The server has no /v1/dev/login route."
            : `Sign-in failed: ${errorMessage(login.error)}`}
        </p>
      ) : null}

      <div className="mt-8 grid gap-x-8 gap-y-8 md:grid-cols-2 lg:grid-cols-3">
        {GROUP_ORDER.map((dept) => {
          const people = PERSONAS.filter((p) => p.department === dept);
          if (people.length === 0) return null;
          return (
            <div key={dept}>
              <h2 className="border-b border-line pb-1 font-display text-lg font-semibold">
                {DEPARTMENT_LABEL[dept]}
              </h2>
              <ul className="mt-2 flex flex-col gap-1.5">
                {people.map((p) => {
                  const pending = login.isPending && login.variables === p.persona_id;
                  return (
                    <li key={p.persona_id}>
                      <button
                        onClick={() => login.mutate(p.persona_id)}
                        disabled={login.isPending}
                        className="group flex w-full items-center justify-between gap-3 rounded-md border border-line bg-surface px-3 py-2.5 text-left hover:border-ink disabled:opacity-60"
                      >
                        <span className="min-w-0">
                          <span className="block font-medium">{p.display_name}</span>
                          <span className="block text-sm text-muted">{ROLE_LABEL[p.role]}</span>
                        </span>
                        <span className="shrink-0 text-right">
                          <span className="block font-mono text-xs text-muted">
                            {p.ens_name ?? shortHex(p.wallet_address)}
                          </span>
                          <span className="block text-xs text-ink group-hover:underline">
                            {pending ? "Signing in…" : "Sign in"}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
  );
}
