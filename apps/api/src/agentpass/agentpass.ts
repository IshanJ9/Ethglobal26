// World ID Agent Pass (https://auth.world.org/docs): a human checkpoint before an agent acts.
//
// The 0G review agent decrypts an employee's evidence vault and writes HR text about them. Before it may do that,
// the workflow pauses: we start an OIDC Device Authorization Grant with World IdP (headless agent flow, always fresh
// authentication, Orb class required), show the user code / QR, and poll the token endpoint server side. The ID token
// is validated here (RS256 via JWKS, iss, aud, exp, acr, auth_time newer than the attempt), and its (iss, sub) must be
// the World ID linked to the requesting persona (enrolled on first approval, and never linkable to a second persona).
// The approval is saved with the exact operation hash and is usable once, within APPROVAL_TTL, by that persona only.
// Every refusal leaves the operation blocked.
import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { canonicalJson, keccakUtf8, type Hex } from "@proofwork/crypto";
import type { components } from "@proofwork/shared";
import { ApiError, errors } from "../errors.ts";
import { canView, isHr } from "../auth/auth.ts";
import type { AuditRepo } from "../db/audit.ts";
import type { DB } from "../db/index.ts";
import type { OrgRepo, Persona } from "../db/org.ts";
import type { Config } from "../config.ts";
import type { Envelope } from "../ledger/envelope.ts";
import { iso, type Clock } from "../util.ts";

export type AgentCheckpoint = components["schemas"]["AgentCheckpoint"];
export type AgentOperation = components["schemas"]["AgentOperation"];

export const WORLD_IDP_ISSUER = "https://auth.world.org";
const ORB = "https://world.org/oidc/acr/orb";
const ACCEPTED_ACR = new Set([ORB, "https://world.org/oidc/acr/orb-face"]);
const APPROVAL_TTL_S = 600;
const CLOCK_SKEW_S = 60;

interface Row {
  checkpoint_id: string;
  persona_id: string;
  operation_json: string;
  operation_hash: string;
  status: AgentCheckpoint["status"];
  device_code_enc: string | null;
  dek_wrapped: string | null;
  user_code: string | null;
  verification_uri: string | null;
  verification_uri_complete: string | null;
  interval_s: number;
  next_poll_at: string;
  expires_at: string;
  world_json: string | null;
  reason: string | null;
  created_at: string;
  decided_at: string | null;
  used_at: string | null;
}

export const operationHash = (op: AgentOperation): Hex =>
  keccakUtf8(canonicalJson({ kind: op.kind, employee_id: op.employee_id, cycle_id: op.cycle_id, peer_employee_id: op.peer_employee_id ?? null }));

export interface IdpEndpoints { device: string; token: string; jwks: string }

export class AgentPassService {
  readonly mode: "off" | "live";
  private endpointsP: Promise<IdpEndpoints> | null = null;
  private jwks: JWTVerifyGetKey | null;

  constructor(
    private readonly db: DB,
    private readonly org: OrgRepo,
    private readonly envelope: Envelope,
    private readonly audit: AuditRepo,
    private readonly config: Config,
    private readonly clock: Clock,
    private readonly http: typeof fetch = fetch,
    jwks?: JWTVerifyGetKey,
    private readonly agentName = "review-agent",
  ) {
    this.mode = config.AGENT_PASS_MODE === "live" && config.WORLD_IDP_CLIENT_ID && config.WORLD_IDP_CLIENT_SECRET ? "live" : "off";
    this.jwks = jwks ?? null;
  }

  private now() { return this.clock.now(); }

  private endpoints(): Promise<IdpEndpoints> {
    return (this.endpointsP ??= (async () => {
      const d = (await (await this.http(`${WORLD_IDP_ISSUER}/.well-known/openid-configuration`)).json()) as Record<string, string>;
      if (d.issuer !== WORLD_IDP_ISSUER) throw errors.internal("World IdP discovery returned an unexpected issuer");
      return { device: d.device_authorization_endpoint, token: d.token_endpoint, jwks: d.jwks_uri };
    })().catch((e) => { this.endpointsP = null; throw e; }));
  }

  private basicAuth() {
    return "Basic " + Buffer.from(`${encodeURIComponent(this.config.WORLD_IDP_CLIENT_ID!)}:${encodeURIComponent(this.config.WORLD_IDP_CLIENT_SECRET!)}`).toString("base64");
  }

  private row(id: string) {
    return this.db.prepare("SELECT * FROM agent_checkpoints WHERE checkpoint_id = ?").get(id) as Row | undefined;
  }

  private toApi(r: Row): AgentCheckpoint {
    return {
      checkpoint_id: r.checkpoint_id,
      operation: JSON.parse(r.operation_json),
      operation_hash: r.operation_hash as Hex,
      agent: this.config.ENS_PARENT_NAME ? `${this.agentName}.${this.config.ENS_PARENT_NAME}` : this.agentName,
      status: r.status,
      user_code: r.status === "pending" ? r.user_code : null,
      verification_uri: r.status === "pending" ? r.verification_uri : null,
      verification_uri_complete: r.status === "pending" ? r.verification_uri_complete : null,
      expires_at: r.expires_at,
      interval_s: r.interval_s,
      requested_by: r.persona_id,
      world: r.world_json ? JSON.parse(r.world_json) : null,
      reason: r.reason,
      created_at: r.created_at,
      decided_at: r.decided_at,
    };
  }

  private decide(r: Row, status: AgentCheckpoint["status"], reason: string | null, world: unknown = null) {
    const at = iso(this.now());
    this.db
      .prepare("UPDATE agent_checkpoints SET status = ?, reason = ?, world_json = COALESCE(?, world_json), decided_at = ?, device_code_enc = NULL WHERE checkpoint_id = ? AND status = 'pending'")
      .run(status, reason, world ? JSON.stringify(world) : null, at, r.checkpoint_id);
    this.audit.append(at, r.persona_id, `agent_pass.${status}`, r.checkpoint_id, { operation_hash: r.operation_hash, reason });
  }

  private mine(p: Persona, id: string) {
    const r = this.row(id);
    if (!r || r.persona_id !== p.persona_id) throw errors.notFound("Checkpoint not found");
    return r;
  }

  /** Who may authorize the review agent: HR, or the employee's manager (same rule as preparing a review). */
  private authorize(p: Persona, op: AgentOperation) {
    const emp = this.org.employee(op.employee_id);
    if (!emp || !canView(p, emp)) throw errors.notFound("Employee not found");
    if (!(isHr(p) || (p.role === "manager" && emp.manager_employee_id === p.employee_id))) {
      throw errors.forbidden("Only HR or the employee's manager can authorize the review agent");
    }
  }

  async create(p: Persona, op: AgentOperation): Promise<AgentCheckpoint> {
    if (this.mode !== "live") throw errors.invalidState("World ID Agent Pass is not configured (AGENT_PASS_MODE=live, WORLD_IDP_CLIENT_ID, WORLD_IDP_CLIENT_SECRET)");
    if (op.kind !== "review.generate") throw errors.validation("Unsupported operation");
    this.authorize(p, op);
    const ep = await this.endpoints();
    const claims = JSON.stringify({ id_token: { acr: { essential: true, values: [...ACCEPTED_ACR] } } });
    const res = await this.http(ep.device, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: this.basicAuth() },
      body: new URLSearchParams({ scope: "openid", claims }).toString(),
    });
    const d = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || typeof d.device_code !== "string") {
      throw new ApiError(502, "internal", `World IdP device authorization failed: ${String(d.error ?? res.status)}`);
    }
    const now = this.now();
    const id = "apc_" + randomBytes(10).toString("hex");
    const { dek, wrapped } = this.envelope.newDek();
    const interval = Math.max(2, Number(d.interval ?? 5));
    const expires = new Date(now.getTime() + Number(d.expires_in ?? 600) * 1000);
    this.db
      .prepare(`INSERT INTO agent_checkpoints (checkpoint_id, persona_id, operation_json, operation_hash, status, device_code_enc, dek_wrapped, user_code, verification_uri,
        verification_uri_complete, interval_s, next_poll_at, expires_at, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, p.persona_id, JSON.stringify({ ...op, peer_employee_id: op.peer_employee_id ?? null }), operationHash(op), this.envelope.encrypt(dek, d.device_code), wrapped,
        String(d.user_code ?? ""), String(d.verification_uri ?? ""), String(d.verification_uri_complete ?? d.verification_uri ?? ""), interval,
        iso(new Date(now.getTime() + interval * 1000)), iso(expires), iso(now));
    this.audit.append(iso(now), p.persona_id, "agent_pass.requested", id, { operation_hash: operationHash(op), agent: this.agentName });
    return this.toApi(this.row(id)!);
  }

  cancel(p: Persona, id: string): AgentCheckpoint {
    const r = this.mine(p, id);
    if (r.status !== "pending") throw errors.invalidState("Checkpoint is no longer pending", { status: r.status });
    this.decide(r, "cancelled", "cancelled by the requester");
    return this.toApi(this.row(id)!);
  }

  /** Poll World IdP once (if due) and validate. Safe to call repeatedly. */
  async get(p: Persona, id: string): Promise<AgentCheckpoint> {
    const r = this.mine(p, id);
    if (r.status !== "pending") return this.toApi(r);
    const now = this.now();
    if (now.getTime() > Date.parse(r.expires_at)) {
      this.decide(r, "expired", "the human did not approve in time");
      return this.toApi(this.row(id)!);
    }
    if (now.getTime() < Date.parse(r.next_poll_at) || !r.device_code_enc || !r.dek_wrapped) return this.toApi(r);

    const ep = await this.endpoints();
    const deviceCode = this.envelope.decrypt(this.envelope.unwrap(r.dek_wrapped), r.device_code_enc);
    const res = await this.http(ep.token, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: this.basicAuth() },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: deviceCode }).toString(),
    });
    const t = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const err = String(t.error ?? res.status);
      if (err === "authorization_pending" || err === "slow_down") {
        const interval = err === "slow_down" ? r.interval_s + 5 : r.interval_s;
        this.db.prepare("UPDATE agent_checkpoints SET interval_s = ?, next_poll_at = ? WHERE checkpoint_id = ?").run(interval, iso(new Date(now.getTime() + interval * 1000)), id);
        return this.toApi(this.row(id)!);
      }
      this.decide(r, err === "expired_token" ? "expired" : "denied", err === "access_denied" ? "the human declined, or the World ID account does not meet the Orb requirement" : `World IdP: ${err}`);
      return this.toApi(this.row(id)!);
    }
    try {
      const world = await this.validate(r, String(t.id_token ?? ""));
      this.decide(r, "approved", null, world);
    } catch (e) {
      this.decide(r, "denied", e instanceof Error ? e.message : String(e));
    }
    return this.toApi(this.row(id)!);
  }

  private async validate(r: Row, idToken: string) {
    if (!idToken) throw new Error("no ID token returned");
    this.jwks ??= createRemoteJWKSet(new URL((await this.endpoints()).jwks));
    const { payload } = await jwtVerify(idToken, this.jwks, {
      issuer: WORLD_IDP_ISSUER,
      audience: this.config.WORLD_IDP_CLIENT_ID!,
      algorithms: ["RS256"],
      currentDate: this.now(),
      clockTolerance: CLOCK_SKEW_S,
    });
    const sub = String(payload.sub ?? "");
    const acr = typeof payload.acr === "string" ? payload.acr : null;
    const amr = Array.isArray(payload.amr) ? payload.amr.map(String) : [];
    const authTime = Number(payload.auth_time ?? 0);
    if (!sub) throw new Error("ID token has no subject");
    if (!acr || !ACCEPTED_ACR.has(acr)) throw new Error(`World ID class ${acr ?? "none"} is not accepted: an Orb-verified human is required`);
    const started = Date.parse(r.created_at) / 1000;
    if (!(authTime >= started - CLOCK_SKEW_S)) throw new Error("authentication is older than this checkpoint (fresh World ID authentication required)");
    if (authTime > this.now().getTime() / 1000 + CLOCK_SKEW_S) throw new Error("authentication time is in the future");

    // (iss, sub) binding: the persona's linked World ID must match; first approval enrolls it, if no one else holds it.
    const iss = String(payload.iss);
    const link = this.db.prepare("SELECT iss, sub FROM world_idp_links WHERE persona_id = ?").get(r.persona_id) as { iss: string; sub: string } | undefined;
    let enrolled = false;
    if (link) {
      if (link.iss !== iss || link.sub !== sub) throw new Error("a different World ID approved this: it is not the one linked to this account");
    } else {
      const other = this.db.prepare("SELECT persona_id FROM world_idp_links WHERE iss = ? AND sub = ?").get(iss, sub) as { persona_id: string } | undefined;
      if (other) throw new Error("this World ID is already linked to another account");
      this.db.prepare("INSERT INTO world_idp_links (persona_id, iss, sub, linked_at) VALUES (?, ?, ?, ?)").run(r.persona_id, iss, sub, iso(this.now()));
      enrolled = true;
    }
    return {
      iss,
      sub_hash: ("0x" + createHash("sha256").update(`${iss}|${sub}`).digest("hex")) as Hex,
      acr,
      amr,
      auth_time: iso(new Date(authTime * 1000)),
      enrolled,
    };
  }

  /**
   * Enforce at the resource (the review agent): an approved, unused checkpoint of this persona for exactly this
   * operation, still within APPROVAL_TTL of the World ID authentication. Marked used atomically. Returns the record
   * to store on the review, or null when Agent Pass is off.
   */
  consume(p: Persona, checkpointId: string | null | undefined, op: AgentOperation) {
    if (this.mode !== "live") return null;
    const fail = (reason: string) => new ApiError(401, "world_verification_failed", `World ID Agent Pass: ${reason}`, { reason: "agent_pass_required" });
    if (!checkpointId) throw fail("the review agent needs a human checkpoint approved with World ID before it reads the vault");
    const r = this.row(checkpointId);
    if (!r || r.persona_id !== p.persona_id) throw fail("checkpoint not found for this account");
    if (r.status === "used") throw fail("this approval was already used (one operation per approval)");
    if (r.status !== "approved") throw fail(`checkpoint is ${r.status}`);
    if (r.operation_hash !== operationHash(op)) throw fail("the approval was for a different operation");
    const world = JSON.parse(r.world_json!);
    if (this.now().getTime() - Date.parse(world.auth_time) > APPROVAL_TTL_S * 1000) throw fail("the approval is older than 10 minutes");
    const at = iso(this.now());
    const ch = this.db.prepare("UPDATE agent_checkpoints SET status = 'used', used_at = ? WHERE checkpoint_id = ? AND status = 'approved'").run(at, checkpointId);
    if (ch.changes !== 1) throw fail("this approval was already used (one operation per approval)");
    this.audit.append(at, p.persona_id, "agent_pass.used", checkpointId, { operation_hash: r.operation_hash });
    return { checkpoint_id: checkpointId, operation_hash: r.operation_hash, acr: world.acr, auth_time: world.auth_time, sub_hash: world.sub_hash };
  }
}
