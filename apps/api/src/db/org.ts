// Org registry: personas, employees, cycles, plans. Loaded from spec/fixtures by seedOrg().
import type { components } from "@proofwork/shared";
import { getAddress } from "viem";
import { clustersFixture, seedOrg, specJson } from "../fixtures.ts";
import type { DB } from "./index.ts";

export type Persona = components["schemas"]["Persona"];
export type Employee = components["schemas"]["Employee"];
export type Cycle = components["schemas"]["Cycle"];
export type Plan = components["schemas"]["Plan"];

/** Idempotent: inserts fixture rows that are missing. */
export function loadOrgFixtures(db: DB): void {
  const org = seedOrg();
  const tx = db.transaction(() => {
    const p = db.prepare(
      `INSERT OR IGNORE INTO org_personas (persona_id, employee_id, display_name, role, department, wallet_address, ens_name, manager_employee_id, world_id_verified)
       VALUES (@persona_id, @employee_id, @display_name, @role, @department, @wallet_address, @ens_name, @manager_employee_id, @w)`,
    );
    for (const x of org.personas) p.run({ ens_name: null, manager_employee_id: null, ...x, w: x.world_id_verified ? 1 : 0 });
    // Upsert (CR-004): fixture changes such as a new cluster plan reach existing databases too.
    const e = db.prepare(
      `INSERT INTO org_employees (employee_id, display_name, department, level, plan_id, wallet_address, ens_name, manager_employee_id)
       VALUES (@employee_id, @display_name, @department, @level, @plan_id, @wallet_address, @ens_name, @manager_employee_id)
       ON CONFLICT(employee_id) DO UPDATE SET display_name = excluded.display_name, department = excluded.department, level = excluded.level,
         plan_id = excluded.plan_id, manager_employee_id = excluded.manager_employee_id`,
    );
    for (const x of org.employees) e.run({ ens_name: null, manager_employee_id: null, ...x });
    const c = db.prepare(
      `INSERT OR IGNORE INTO org_cycles (cycle_id, numeric_id, label, starts_on, ends_on, status) VALUES (@cycle_id, @numeric_id, @label, @starts_on, @ends_on, @status)`,
    );
    for (const x of org.cycles) c.run(x);
    const pl = db.prepare(`INSERT INTO org_plans (plan_id, plan_json) VALUES (?, ?) ON CONFLICT(plan_id) DO UPDATE SET plan_json = excluded.plan_json`);
    for (const id of org.plan_ids as string[]) pl.run(id, JSON.stringify(specJson(`fixtures/plans/${id}.json`)));
  });
  tx();
}

const personaRow = (r: any): Persona => ({
  persona_id: r.persona_id,
  employee_id: r.employee_id,
  display_name: r.display_name,
  role: r.role,
  department: r.department,
  wallet_address: getAddress(r.wallet_address),
  ens_name: r.ens_name ?? null,
  manager_employee_id: r.manager_employee_id ?? null,
  world_id_verified: !!r.world_id_verified,
});

/** CR-004: the peer cluster of an employee is department.level when that cluster exists. */
const CLUSTER_IDS = () => new Set(clustersFixture().clusters.map((c) => c.cluster_id));
export const clusterIdOf = (e: { department: string; level: string }): string | null => {
  const id = `${e.department}.${e.level}`;
  return CLUSTER_IDS().has(id) ? id : null;
};

const employeeRow = (r: any): Employee => ({
  employee_id: r.employee_id,
  display_name: r.display_name,
  department: r.department,
  level: r.level,
  plan_id: r.plan_id,
  wallet_address: getAddress(r.wallet_address),
  ens_name: r.ens_name ?? null,
  manager_employee_id: r.manager_employee_id ?? null,
  cluster_id: clusterIdOf(r),
});

export const orgRepo = (db: DB) => ({
  persona(id: string): Persona | undefined {
    const r = db.prepare("SELECT * FROM org_personas WHERE persona_id = ?").get(id);
    return r ? personaRow(r) : undefined;
  },
  personaByEmployee(employeeId: string): Persona | undefined {
    const r = db.prepare("SELECT * FROM org_personas WHERE employee_id = ?").get(employeeId);
    return r ? personaRow(r) : undefined;
  },
  employee(id: string): Employee | undefined {
    const r = db.prepare("SELECT * FROM org_employees WHERE employee_id = ?").get(id);
    return r ? employeeRow(r) : undefined;
  },
  employees(): Employee[] {
    return db.prepare("SELECT * FROM org_employees ORDER BY employee_id").all().map(employeeRow);
  },
  cycle(id: string): Cycle | undefined {
    return db.prepare("SELECT * FROM org_cycles WHERE cycle_id = ?").get(id) as Cycle | undefined;
  },
  cycleByNumeric(n: number): Cycle | undefined {
    return db.prepare("SELECT * FROM org_cycles WHERE numeric_id = ?").get(n) as Cycle | undefined;
  },
  cycles(): Cycle[] {
    return db.prepare("SELECT * FROM org_cycles ORDER BY numeric_id").all() as Cycle[];
  },
  plan(id: string): Plan | undefined {
    const r = db.prepare("SELECT plan_json FROM org_plans WHERE plan_id = ?").pluck().get(id) as string | undefined;
    return r ? (JSON.parse(r) as Plan) : undefined;
  },
  plans(): Plan[] {
    return (db.prepare("SELECT plan_json FROM org_plans ORDER BY plan_id").pluck().all() as string[]).map((s) => JSON.parse(s));
  },
});
export type OrgRepo = ReturnType<typeof orgRepo>;
