"use client";

import { API_BASE, SPEC_MAJOR } from "@/lib/api";
import { useSpecHandshake } from "@/lib/config";

/** Blocks the app when the API speaks a different spec major (INTEGRATION 5.9). */
export function SpecBanner() {
  const hs = useSpecHandshake();

  if (hs.state === "mismatch") {
    return (
      <div role="alertdialog" aria-modal="true" aria-labelledby="spec-title"
        className="fixed inset-0 z-50 grid place-items-center bg-ink/70 p-4">
        <div className="max-w-md rounded-md bg-surface p-6 shadow-lg">
          <h2 id="spec-title" className="font-display text-xl font-semibold">
            This app and the API disagree on the spec
          </h2>
          <p className="mt-2 text-sm text-muted">
            The web app is built for spec {SPEC_MAJOR}.x, but the API at {API_BASE} reports{" "}
            {hs.serverVersion}. Pull the latest main on both sides and restart. Actions are blocked
            until the versions match.
          </p>
        </div>
      </div>
    );
  }

  if (hs.state === "unknown") {
    return (
      <div role="status" className="hatch-mock px-4 py-1.5 text-sm font-medium text-ink">
        The API did not report a spec version (it answered “{hs.serverVersion}”). This is expected
        with the schema-only mock API; data on screen is placeholder.
      </div>
    );
  }

  if (hs.state === "unreachable") {
    return (
      <div role="status" className="border-b border-danger/30 bg-danger/10 px-4 py-2 text-sm text-danger">
        Cannot reach the API at {API_BASE}. Start it with <code className="font-mono">pnpm mock:api</code>{" "}
        or the real server, then reload.
      </div>
    );
  }

  return null;
}
