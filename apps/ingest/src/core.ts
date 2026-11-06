// Framework-free ingest logic, shared by the Telegram bot and the GitHub webhook (and tested without either).
import { randomBytes } from "node:crypto";
import type { ProofworkApi } from "./api.ts";
import { ClaimFiler, type Cosigner, type FilerContext, type Kra } from "./claims.ts";
import { mapGithubEvent, verifySignature, type MapContext } from "./github.ts";
import { Bindings, readLinkCode } from "./links.ts";
import { redact } from "./redact.ts";
import { chunkMessages, exportText, parseWhatsApp, type WaMessage } from "./whatsapp.ts";

export type InformalSource = "telegram_text" | "telegram_forward" | "whatsapp_export";

export interface Pending {
  id: string;
  personaId: string;
  source: InformalSource;
  text: string; // redacted
  createdAt: number;
}

export interface CoreOptions {
  api: ProofworkApi;
  linkSecret: string;
  connectorKey: string;
  cosigner: Cosigner;
  webBase: string;
  bindings: Bindings;
  cycleId?: string;
  github?: { secret: string; ctx: MapContext };
  now?: () => number;
}

const PENDING_TTL_MS = 30 * 60_000;
/** WhatsApp exports can hold months of chat; only the most recent chunks become claims. */
export const MAX_WA_CHUNKS = 5;

/** Replaces chat author names with stable "Person N" labels so names never leave the bot. */
export function pseudonymise(msgs: WaMessage[]): WaMessage[] {
  const ids = new Map<string, string>();
  return msgs.map((m) => {
    const a = m.author ?? "System";
    if (!ids.has(a)) ids.set(a, `Person ${ids.size + 1}`);
    return { ...m, author: ids.get(a)! };
  });
}

export class IngestCore {
  readonly filer: ClaimFiler;
  private readonly pending = new Map<string, Pending>();
  private authMode: "dev" | "sso" | null = null;
  private readonly now: () => number;

  constructor(private readonly o: CoreOptions) {
    this.filer = new ClaimFiler(o.api, { webBase: o.webBase, cycleId: o.cycleId });
    this.now = o.now ?? Date.now;
  }

  async mode(): Promise<"dev" | "sso"> {
    this.authMode ??= (await this.o.api.call<any>("GET", "/v1/config/public")).auth_mode;
    return this.authMode!;
  }

  // ---- linking ----
  async link(telegramUserId: number, code: string): Promise<{ personaId: string; displayName: string }> {
    const personaId = readLinkCode(this.o.linkSecret, code.trim(), Math.floor(this.now() / 1000));
    if (!personaId) throw new Error("This link code is invalid or expired. Ask for a new one.");
    if ((await this.mode()) !== "dev") throw new Error("Linking through the bot needs AUTH_MODE=dev on the API.");
    const ctx = await this.filer.context(personaId); // proves the persona exists and is an employee
    this.o.bindings.set(telegramUserId, personaId);
    return { personaId, displayName: ctx.displayName };
  }

  personaFor(telegramUserId: number): string {
    const p = this.o.bindings.get(telegramUserId);
    if (!p) throw new Error("You are not linked yet. Open the link your manager sent you (t.me/<bot>?start=<code>).");
    return p;
  }

  async kras(telegramUserId: number): Promise<Kra[]> {
    return (await this.filer.context(this.personaFor(telegramUserId))).kras;
  }

  // ---- informal evidence -> pending -> claim ----
  /** Redacts and parks the text until the user picks a KRA. Returns the pending id and the KRA choices. */
  async prepare(telegramUserId: number, source: InformalSource, rawText: string): Promise<{ pending: Pending; kras: Kra[] }> {
    const personaId = this.personaFor(telegramUserId);
    this.gc();
    const text = redact(rawText).trim();
    if (!text) throw new Error("Nothing to file: the message is empty.");
    const { kras } = await this.filer.context(personaId);
    if (!kras.length) throw new Error("Your plan has no KRA that accepts co-signed claims: it is scored only from systems of record (CRM / HRIS), so chat evidence cannot count toward it.");
    const pending: Pending = { id: randomBytes(6).toString("hex"), personaId, source, text, createdAt: this.now() };
    this.pending.set(pending.id, pending);
    return { pending, kras };
  }

  /** WhatsApp export (.txt or .zip) -> up to MAX_WA_CHUNKS pending items (most recent days first). */
  async prepareWhatsApp(telegramUserId: number, fileName: string, bytes: Uint8Array) {
    const msgs = parseWhatsApp(exportText(fileName, bytes));
    if (msgs.length < 2) throw new Error("That file does not look like a WhatsApp chat export.");
    const chunks = chunkMessages(pseudonymise(msgs));
    const recent = chunks.slice(-MAX_WA_CHUNKS).reverse();
    const out = [];
    for (const c of recent) out.push({ day: c.day, count: c.messages.length, ...(await this.prepare(telegramUserId, "whatsapp_export", `WhatsApp chat, ${c.day}:\n${c.text}`)) });
    return { totalMessages: msgs.length, totalChunks: chunks.length, items: out };
  }

  pendingItem(id: string, telegramUserId: number): Pending {
    const p = this.pending.get(id);
    if (!p || p.personaId !== this.personaFor(telegramUserId)) throw new Error("That item expired. Send it again.");
    return p;
  }

  /** Files the parked text as a drafted claim under the chosen KRA (AI drafts the structured body). */
  async file(telegramUserId: number, pendingId: string, kraId: string) {
    const p = this.pendingItem(pendingId, telegramUserId);
    const ctx = await this.filer.context(p.personaId);
    if (!ctx.kras.some((k) => k.kra_id === kraId)) throw new Error(`KRA ${kraId} is not claimable on your plan.`);
    const claim = await this.filer.draft(ctx, p.text, kraId, this.o.cosigner);
    this.pending.delete(pendingId);
    return claim;
  }

  /** Employee signature + co-sign magic link (dev), or the web link to sign (sso). */
  async requestCosign(telegramUserId: number, claimId: string) {
    const personaId = this.personaFor(telegramUserId);
    const ctx: FilerContext = await this.filer.context(personaId);
    return this.filer.signAndRequestCosign(personaId, ctx, claimId, await this.mode());
  }

  // ---- GitHub (official, system of record) ----
  async github(event: string, rawBody: Buffer | string, signature: string | undefined) {
    const gh = this.o.github;
    if (!gh?.secret) return { status: 503, body: { error: "GITHUB_WEBHOOK_SECRET is not set" } };
    if (!verifySignature(gh.secret, rawBody, signature)) return { status: 401, body: { error: "bad signature" } };
    if (event === "ping") return { status: 200, body: { ok: true, pong: true } };
    const { drafts, skipped } = mapGithubEvent(event, JSON.parse(rawBody.toString()), gh.ctx);
    const ingested = [];
    for (const d of drafts) {
      const item = await this.o.api.ingestEvidence(this.o.connectorKey, d);
      ingested.push({ evidence_id: item.evidence_id, kind: item.kind, ref: item.ref, status: item.status });
    }
    return { status: 200, body: { ok: true, ingested, ...(skipped ? { skipped } : {}) } };
  }

  private gc() {
    const cutoff = this.now() - PENDING_TTL_MS;
    for (const [k, v] of this.pending) if (v.createdAt < cutoff) this.pending.delete(k);
  }
}
