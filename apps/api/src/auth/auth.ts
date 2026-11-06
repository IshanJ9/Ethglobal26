// Dev login issues HS256 JWTs (jose). `authenticate` resolves the bearer token to a Persona.
// ABAC policy (INTEGRATION section 9). Cross-user access to a resource => 404, never 403,
// except explicit role violations on known resources (e.g. self-approval n01).
import { SignJWT, jwtVerify } from "jose";
import type { FastifyReply, FastifyRequest } from "fastify";
import { errors } from "../errors.ts";
import type { Employee, OrgRepo, Persona } from "../db/org.ts";

declare module "fastify" {
  interface FastifyRequest {
    persona?: Persona;
  }
}

const ISSUER = "proofwork-api";
const TTL = "12h";

export class Jwt {
  private readonly key: Uint8Array;
  constructor(secret: string) {
    this.key = new TextEncoder().encode(secret);
  }
  sign(p: Persona): Promise<string> {
    return new SignJWT({ role: p.role, employee_id: p.employee_id })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(p.persona_id)
      .setIssuer(ISSUER)
      .setIssuedAt()
      .setExpirationTime(TTL)
      .sign(this.key);
  }
  async verify(token: string): Promise<string> {
    const { payload } = await jwtVerify(token, this.key, { issuer: ISSUER, algorithms: ["HS256"] });
    if (!payload.sub) throw new Error("no sub");
    return payload.sub;
  }
}

export function makeAuthenticate(jwt: Jwt, org: OrgRepo) {
  return async function authenticate(req: FastifyRequest, _reply: FastifyReply) {
    const h = req.headers.authorization;
    if (!h || !h.startsWith("Bearer ")) throw errors.unauthorized();
    let sub: string;
    try {
      sub = await jwt.verify(h.slice(7).trim());
    } catch {
      throw errors.unauthorized("Invalid or expired token");
    }
    const p = org.persona(sub);
    if (!p) throw errors.unauthorized("Unknown persona");
    req.persona = p;
  };
}

export function me(req: FastifyRequest): Persona {
  if (!req.persona) throw errors.unauthorized();
  return req.persona;
}

// ---- policy ----
export const isHr = (p: Persona) => p.role === "hr" || p.role === "admin";
export const isInternal = (p: Persona) => p.role !== "external_cosigner";

/** Can `p` read `employee`'s evidence / scorecards / claims? self, their manager, or HR. */
export function canView(p: Persona, employee: Pick<Employee, "employee_id" | "manager_employee_id"> | undefined): boolean {
  if (!employee || !isInternal(p)) return false;
  if (isHr(p)) return true;
  if (p.employee_id === employee.employee_id) return true;
  return p.role === "manager" && employee.manager_employee_id === p.employee_id;
}

/** Manager-of-employee or HR, and never the employee themself. Used for approvals. */
export function canApprove(p: Persona, employee: Pick<Employee, "employee_id" | "manager_employee_id">): boolean {
  if (p.employee_id === employee.employee_id) return false;
  if (isHr(p)) return true;
  return p.role === "manager" && employee.manager_employee_id === p.employee_id;
}

export function visibleEmployeeIds(p: Persona, org: OrgRepo): string[] {
  return org
    .employees()
    .filter((e) => canView(p, e))
    .map((e) => e.employee_id);
}

/** Loads an employee the caller may see, else 404 (no id probing). */
export function viewableEmployee(p: Persona, org: OrgRepo, employeeId: string): Employee {
  const e = org.employee(employeeId);
  if (!e || !canView(p, e)) throw errors.notFound("Employee not found");
  return e;
}
