// F1: claim -> AI draft -> signing package -> employee signature -> co-sign grant -> co-signer signs/declines.
// (AGENT_A 3.9, 3.10; INTEGRATION section 6 F1.)
import { randomBytes } from "node:crypto";
import {
  CLAIM_TYPES,
  claimDigest,
  commit,
  kraIdBytes32,
  makeDomain,
  randomSalt,
  recoverClaimSigner,
  toClaimMessage,
  type Hex,
} from "@proofwork/crypto";
import type { components } from "@proofwork/shared";
import { getAddress, isAddressEqual, type Address } from "viem";
import type { Config } from "../config.ts";
import { ApiError, errors } from "../errors.ts";
import type { AuditRepo } from "../db/audit.ts";
import type { ClaimRepo, ClaimRow, GrantRow } from "../db/claims.ts";
import type { DB } from "../db/index.ts";
import type { OrgRepo, Persona } from "../db/org.ts";
import { canView, visibleEmployeeIds } from "../auth/auth.ts";
import type { ClaimDrafter, ClaimBody } from "../ai/inference.ts";
import type { Envelope } from "../ledger/envelope.ts";
import type { Ledger } from "../ledger/ledger.ts";
import { consumeNullifier, type WorldResult, type WorldVerifier } from "../world/verifier.ts";
import { iso, newId, randomUint53, safeEqual, sha256Hex, type Clock } from "../util.ts";

export type Claim = components["schemas"]["Claim"];
export type ClaimCreate = components["schemas"]["ClaimCreate"];
export type SigningPackage = components["schemas"]["SigningPackage"];
export type TypedDataClaim = components["schemas"]["TypedDataClaim"];
export type CosignGrant = components["schemas"]["CosignGrant"];
export type CosignView = components["schemas"]["CosignView"];

export const COSIGN_WORLD_ACTION = "pw-cosign-claim";
const SIGNING_TTL_S = 72 * 3600;
/** Claims may only feed KRAs that are not fed by a system of record. */
const CLAIMABLE_SOURCES = new Set(["cosign", "worklog", "manual"]);

export function toClaim(r: ClaimRow): Claim {
  const c: Claim = {
    claim_id: r.claim_id,
    employee_id: r.employee_id,
    cycle_id: r.cycle_id,
    kra_id: r.kra_id,
    state: r.state as Claim["state"],
    body: JSON.parse(r.body_json),
    evidence_excerpt: r.excerpt,
    cosigner_address: getAddress(r.cosigner_address),
    cosigner_label: r.cosigner_label,
    ai_flags: JSON.parse(r.ai_flags_json),
    evidence_id: r.evidence_id,
    decline_reason: r.decline_reason,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
  if (r.inference_json) c.inference = JSON.parse(r.inference_json);
  if (r.claim_commitment) c.claim_commitment = r.claim_commitment;
  if (r.evidence_commitment) c.evidence_commitment = r.evidence_commitment;
  if (r.employee_sig) c.employee_signature = r.employee_sig;
  if (r.cosigner_sig) c.cosigner_signature = r.cosigner_sig;
  return c;
}

export class ClaimService {
  constructor(
    private readonly db: DB,
    private readonly repo: ClaimRepo,
    private readonly org: OrgRepo,
    private readonly ledger: Ledger,
    private readonly audit: AuditRepo,
    private readonly envelope: Envelope,
    private readonly drafter: ClaimDrafter,
    private readonly world: WorldVerifier,
    private readonly config: Config,
    private readonly clock: Clock,
  ) {}

  private now() {
    return iso(this.clock.now());
  }

  /** Claim the caller may see, else 404. */
  private visible(p: Persona, id: string): ClaimRow {
    const r = this.repo.get(id);
    if (!r || !canView(p, this.org.employee(r.employee_id))) throw errors.notFound("Claim not found");
    return r;
  }

  /** Claim owned by the caller (employee actions), else 404 / 403. */
  private owned(p: Persona, id: string): ClaimRow {
    const r = this.visible(p, id);
    if (r.employee_id !== p.employee_id) throw errors.forbidden("Only the employee who made the claim can do this");
    return r;
  }

  private checkOccurredOn(body: ClaimBody, cycleId: string) {
    const c = this.org.cycle(cycleId)!;
    if (body.occurred_on < c.starts_on || body.occurred_on > c.ends_on) {
      throw errors.validation(`occurred_on must lie inside the cycle (${c.starts_on}..${c.ends_on})`);
    }
  }

  async create(p: Persona, input: ClaimCreate): Promise<Claim> {
    const employee = this.org.employee(p.employee_id);
    if (!employee || p.role === "external_cosigner") throw errors.forbidden("Only employees can create claims");
    const cycle = this.org.cycle(input.cycle_id);
    if (!cycle) throw errors.validation(`Unknown cycle_id ${input.cycle_id}`);
    if (cycle.status !== "open") throw errors.validation("Cycle is closed");
    const plan = this.org.plan(employee.plan_id)!;
    const kra = plan.kras.find((k) => k.kra_id === input.kra_id);
    if (!kra) throw errors.validation(`kra_id ${input.kra_id} is not in plan ${plan.plan_id}`);
    if (!CLAIMABLE_SOURCES.has(kra.source ?? "")) throw errors.validation(`KRA ${kra.kra_id} is fed by a system of record and cannot be claimed`);
    const cosigner = getAddress(input.cosigner_address);
    if (isAddressEqual(cosigner, employee.wallet_address as Address)) throw errors.validation("Co-signer must be someone other than the employee");

    // Untrusted text goes to the drafter as data; it never influences state, kra, cycle or addresses.
    const d = await this.drafter.draft(input.raw_text, cycle, input.cosigner_label);
    const now = this.now();
    const row: ClaimRow = {
      claim_id: newId("clm"),
      employee_id: employee.employee_id,
      cycle_id: cycle.cycle_id,
      kra_id: kra.kra_id,
      state: "drafted",
      body_json: JSON.stringify(d.body),
      excerpt: d.excerpt,
      cosigner_address: cosigner,
      cosigner_label: input.cosigner_label,
      ai_flags_json: JSON.stringify(d.flags),
      inference_json: JSON.stringify(d.inference),
      frozen_at: null,
      typed_data_json: null,
      digest: null,
      claim_commitment: null,
      evidence_commitment: null,
      nonce: null,
      deadline: null,
      employee_sig: null,
      cosigner_sig: null,
      evidence_id: null,
      decline_reason: null,
      created_at: now,
      updated_at: now,
    };
    this.db.transaction(() => {
      this.repo.insert(row);
      this.audit.append(now, p.persona_id, "claim.drafted", row.claim_id, {
        ai_flags: d.flags,
        inference_provider: d.inference.provider,
        request_id: d.inference.request_id,
        output_hash: d.inference.output_hash ?? null,
      });
    })();
    return toClaim(row);
  }

  get(p: Persona, id: string): Claim {
    return toClaim(this.visible(p, id));
  }

  list(p: Persona, f: { cycle_id?: string; state?: string }): Claim[] {
    return this.repo.list({ employeeIds: visibleEmployeeIds(p, this.org), cycleId: f.cycle_id, state: f.state }).map(toClaim);
  }

  editDraft(p: Persona, id: string, patch: { body?: ClaimBody; evidence_excerpt?: string }): Claim {
    const r = this.owned(p, id);
    if (r.state !== "drafted" || r.frozen_at) throw errors.invalidState("Draft is frozen once the signing package is issued", { state: r.state });
    const upd: Partial<ClaimRow> = { updated_at: this.now() };
    if (patch.body) {
      this.checkOccurredOn(patch.body, r.cycle_id);
      upd.body_json = JSON.stringify(patch.body);
    }
    if (patch.evidence_excerpt !== undefined) upd.excerpt = patch.evidence_excerpt;
    this.repo.update(id, upd);
    this.audit.append(upd.updated_at!, p.persona_id, "claim.draft_edited", id, { fields: Object.keys(patch) });
    return toClaim(this.repo.get(id)!);
  }

  private salts(id: string): { claimSalt: Hex; evidenceSalt: Hex } {
    const s = this.repo.secrets(id);
    if (!s?.dek_wrapped || !s.claim_salt_enc || !s.evidence_salt_enc) throw errors.internal("claim secrets missing");
    const dek = this.envelope.unwrap(s.dek_wrapped);
    return { claimSalt: this.envelope.decrypt(dek, s.claim_salt_enc) as Hex, evidenceSalt: this.envelope.decrypt(dek, s.evidence_salt_enc) as Hex };
  }

  private packageOf(r: ClaimRow): SigningPackage {
    const { claimSalt, evidenceSalt } = this.salts(r.claim_id);
    return {
      claim_id: r.claim_id,
      typed_data: JSON.parse(r.typed_data_json!),
      digest: r.digest!,
      claim_value: JSON.parse(r.body_json),
      claim_salt: claimSalt,
      evidence_value: { excerpt: r.excerpt },
      evidence_salt: evidenceSalt,
    };
  }

  /** Freezes the draft; idempotent (same salts/nonce on repeat calls). */
  signingPackage(p: Persona, id: string): SigningPackage {
    const r = this.owned(p, id);
    if (r.frozen_at) return this.packageOf(r);
    if (r.state !== "drafted") throw errors.invalidState("Claim is not in drafted state", { state: r.state });

    const employee = this.org.employee(r.employee_id)!;
    const cycle = this.org.cycle(r.cycle_id)!;
    const body = JSON.parse(r.body_json) as ClaimBody;
    this.checkOccurredOn(body, r.cycle_id);
    const claimSalt = randomSalt();
    const evidenceSalt = randomSalt();
    const claimCommitment = commit(claimSalt, body);
    const evidenceCommitment = commit(evidenceSalt, { excerpt: r.excerpt });
    const nonce = randomUint53();
    const deadline = Math.floor(this.clock.now().getTime() / 1000) + SIGNING_TTL_S;
    const domain = makeDomain(this.config.CHAIN_ID, getAddress(this.config.REGISTRY_ADDRESS));
    const message = {
      employee: getAddress(employee.wallet_address),
      claimCommitment,
      evidenceCommitment,
      cycleId: cycle.numeric_id,
      kraId: kraIdBytes32(r.kra_id),
      cosigner: getAddress(r.cosigner_address),
      nonce,
      deadline,
    };
    const typed: TypedDataClaim = { domain: { ...domain }, types: CLAIM_TYPES as unknown as Record<string, unknown>, primaryType: "Claim", message };
    const digest = claimDigest(domain, toClaimMessage(message));
    const { dek, wrapped } = this.envelope.newDek();
    const now = this.now();
    this.db.transaction(() => {
      this.repo.saveSecrets(id, {
        dek_wrapped: wrapped,
        claim_salt_enc: this.envelope.encrypt(dek, claimSalt),
        evidence_salt_enc: this.envelope.encrypt(dek, evidenceSalt),
      });
      this.repo.update(id, {
        frozen_at: now,
        updated_at: now,
        typed_data_json: JSON.stringify(typed),
        digest,
        claim_commitment: claimCommitment,
        evidence_commitment: evidenceCommitment,
        nonce,
        deadline,
      });
      this.audit.append(now, p.persona_id, "claim.signing_package_issued", id, { digest, claim_commitment: claimCommitment, evidence_commitment: evidenceCommitment });
    })();
    return this.packageOf(this.repo.get(id)!);
  }

  private async recover(r: ClaimRow, signature: Hex): Promise<Address | null> {
    const t = JSON.parse(r.typed_data_json!) as TypedDataClaim;
    try {
      return await recoverClaimSigner(makeDomain(t.domain.chainId, getAddress(t.domain.verifyingContract)), toClaimMessage(t.message), signature);
    } catch {
      return null;
    }
  }

  async submit(p: Persona, id: string, signature: Hex): Promise<Claim> {
    const r = this.owned(p, id);
    if (r.state !== "drafted") throw errors.invalidState("Claim was already submitted", { state: r.state });
    if (!r.frozen_at) throw errors.invalidState("Fetch the signing package before submitting");
    if (Math.floor(this.clock.now().getTime() / 1000) > (r.deadline ?? 0)) throw errors.invalidState("Signing package deadline has passed");
    const employee = this.org.employee(r.employee_id)!;
    const signer = await this.recover(r, signature);
    if (!signer || !isAddressEqual(signer, employee.wallet_address as Address)) {
      throw new ApiError(400, "signature_mismatch", "Signature does not recover to the employee wallet for this typed data");
    }
    const plan = this.org.plan(employee.plan_id)!;
    const kra = plan.kras.find((k) => k.kra_id === r.kra_id)!;
    const body = JSON.parse(r.body_json) as ClaimBody;
    const { evidenceSalt } = this.salts(id);
    const now = this.now();
    this.db.transaction(() => {
      const { item } = this.ledger.ingest(
        {
          employee_id: r.employee_id,
          cycle_id: r.cycle_id,
          source: "cosign",
          kind: "client_cosign",
          ref: `claim:${r.claim_id}`,
          observed_at: `${body.occurred_on}T00:00:00Z`,
          observations: [{ metric_key: kra.metric_key, value: 1 }],
        },
        {
          actor: p.persona_id,
          status: "unverified",
          claimId: r.claim_id,
          commitment: r.evidence_commitment as Hex,
          salt: evidenceSalt,
          payload: { excerpt: r.excerpt },
        },
      );
      this.repo.update(id, { state: "pending_cosign", employee_sig: signature.toLowerCase(), evidence_id: item.evidence_id, updated_at: now });
      this.audit.append(now, p.persona_id, "claim.submitted", id, { signer, evidence_id: item.evidence_id });
    })();
    return toClaim(this.repo.get(id)!);
  }

  createGrant(p: Persona, id: string, authMethod: "world_id" | "magic_link_wallet", ttlHours = 72): CosignGrant {
    const r = this.owned(p, id);
    if (r.state !== "pending_cosign") throw errors.invalidState("Claim must be pending_cosign (submit it first)", { state: r.state });
    const token = randomBytes(32).toString("base64url");
    const now = this.clock.now();
    const g: GrantRow = {
      grant_id: newId("grt"),
      claim_id: id,
      auth_method: authMethod,
      token_sha256: sha256Hex(token),
      world_action: authMethod === "world_id" ? COSIGN_WORLD_ACTION : null,
      expires_at: iso(new Date(now.getTime() + ttlHours * 3600_000)),
      created_at: iso(now),
      closed_at: null,
      closed_reason: null,
    };
    this.db.transaction(() => {
      for (const old of this.repo.openGrants(id)) this.repo.closeGrant(old.grant_id, iso(now), "revoked");
      this.repo.insertGrant(g);
      this.audit.append(iso(now), p.persona_id, "cosign.grant_created", id, { grant_id: g.grant_id, auth_method: authMethod, expires_at: g.expires_at });
    })();
    return { grant_id: g.grant_id, claim_id: id, auth_method: authMethod, expires_at: g.expires_at, url: `/cosign#token=${token}`, token };
  }

  /** Token -> live grant + claim. 401 unknown token; 410 closed/expired (closing expired grants as a side effect). */
  private resolve(token: string | undefined): { g: GrantRow; r: ClaimRow } {
    if (!token || token.length > 200) throw errors.unauthorized("Missing co-sign token");
    const h = sha256Hex(token);
    const g = this.repo.grantByTokenHash(h);
    if (!g || !safeEqual(g.token_sha256, h)) throw errors.unauthorized("Invalid co-sign token");
    const r = this.repo.get(g.claim_id)!;
    if (g.closed_at) throw new ApiError(410, "grant_closed", "This co-sign link is closed");
    const now = this.clock.now();
    if (now.getTime() > Date.parse(g.expires_at)) {
      this.db.transaction(() => {
        this.repo.closeGrant(g.grant_id, iso(now), "expired");
        if (r.state === "pending_cosign") {
          this.repo.update(r.claim_id, { state: "expired", updated_at: iso(now) });
          if (r.evidence_id) this.ledger.setStatus(r.evidence_id, "rejected", "system", "cosign grant expired");
        }
        this.audit.append(iso(now), "system", "cosign.grant_expired", r.claim_id, { grant_id: g.grant_id });
      })();
      throw new ApiError(410, "grant_closed", "This co-sign link has expired");
    }
    if (r.state !== "pending_cosign") throw new ApiError(410, "grant_closed", "This claim is no longer awaiting a co-signature");
    return { g, r };
  }

  /** Minimum view: the one claim, its excerpt, typed data, AI flags are on the Claim (see CR-001). No ids of other things, no scores. */
  view(token: string | undefined): CosignView {
    const { g, r } = this.resolve(token);
    const employee = this.org.employee(r.employee_id)!;
    this.audit.append(this.now(), `cosigner:${r.claim_id}`, "cosign.viewed", r.claim_id, { grant_id: g.grant_id });
    const v: CosignView = {
      claim_id: r.claim_id,
      auth_method: g.auth_method as CosignView["auth_method"],
      requester_display_name: employee.display_name,
      body: JSON.parse(r.body_json),
      evidence_excerpt: r.excerpt,
      typed_data: JSON.parse(r.typed_data_json!),
      expires_at: g.expires_at,
    };
    if (r.employee_sig) v.employee_signature = r.employee_sig;
    if (g.world_action) v.world_action = g.world_action;
    return v;
  }

  async sign(token: string | undefined, signature: Hex, worldResult?: WorldResult): Promise<Claim> {
    const { g, r } = this.resolve(token);
    const signer = await this.recover(r, signature);
    if (!signer || !isAddressEqual(signer, r.cosigner_address as Address)) {
      this.audit.append(this.now(), `cosigner:${r.claim_id}`, "cosign.signature_rejected", r.claim_id, { grant_id: g.grant_id });
      throw new ApiError(400, "signature_mismatch", "Signature does not recover to the requested co-signer address");
    }
    let nullifier: string | null = null;
    if (g.auth_method === "world_id") {
      const chk = await this.world.verify({ action: g.world_action!, signal: r.digest!, result: worldResult });
      if (!chk.ok) throw new ApiError(401, "world_verification_failed", `World verification failed: ${chk.reason}`);
      nullifier = chk.nullifier;
    }
    const now = this.now();
    this.db.transaction(() => {
      if (nullifier && !consumeNullifier(this.db, nullifier, `${g.world_action}:${r.claim_id}`, now)) {
        throw new ApiError(401, "world_verification_failed", "World proof was already used (replay)");
      }
      this.repo.update(r.claim_id, { state: "verified", cosigner_sig: signature.toLowerCase(), updated_at: now });
      if (r.evidence_id) this.ledger.setStatus(r.evidence_id, "verified", `cosigner:${r.claim_id}`, "co-signed");
      this.repo.closeGrant(g.grant_id, now, "signed");
      this.audit.append(now, `cosigner:${r.claim_id}`, "cosign.signed", r.claim_id, { grant_id: g.grant_id, signer, world: g.auth_method === "world_id" });
    })();
    return toClaim(this.repo.get(r.claim_id)!);
  }

  decline(token: string | undefined, reason: string): Claim {
    const { g, r } = this.resolve(token);
    const now = this.now();
    this.db.transaction(() => {
      this.repo.update(r.claim_id, { state: "declined", decline_reason: reason, updated_at: now });
      if (r.evidence_id) this.ledger.setStatus(r.evidence_id, "rejected", `cosigner:${r.claim_id}`, "co-signer declined");
      this.repo.closeGrant(g.grant_id, now, "declined");
      this.audit.append(now, `cosigner:${r.claim_id}`, "cosign.declined", r.claim_id, { grant_id: g.grant_id });
    })();
    return toClaim(this.repo.get(r.claim_id)!);
  }
}
