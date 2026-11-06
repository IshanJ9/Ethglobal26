// GitHub webhook receiver: POST /webhooks/github (raw body kept for HMAC), GET /healthz.
// Plain node:http so the exact bytes GitHub signed are what we verify.
import { createServer, type Server } from "node:http";
import type { IngestCore } from "./core.ts";

const MAX_BODY = 5 * 1024 * 1024;

export function buildServer(core: IngestCore, log: (m: string) => void = console.log): Server {
  return createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url === "/healthz") return send(200, { ok: true });
    if (req.method !== "POST" || req.url !== "/webhooks/github") return send(404, { error: "not found" });
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) req.destroy();
      else chunks.push(c);
    });
    req.on("end", async () => {
      try {
        const event = String(req.headers["x-github-event"] ?? "");
        const r = await core.github(event, Buffer.concat(chunks), req.headers["x-hub-signature-256"] as string | undefined);
        log(`github ${event} -> ${r.status}${(r.body as any).ingested ? ` ingested=${(r.body as any).ingested.length}` : ""}${(r.body as any).skipped ? ` skipped=${(r.body as any).skipped}` : ""}`);
        send(r.status, r.body);
      } catch (e) {
        log(`github webhook error: ${(e as Error).message}`);
        send(502, { error: (e as Error).message });
      }
    });
  });
}
