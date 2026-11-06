import seed from "../../../../spec/fixtures/seed-org.json";
import type { Persona } from "./api";

// Read-only seed fixture: the dev persona picker needs names before anyone is signed in,
// and the API has no "list personas" endpoint. Identity still comes from /v1/dev/login.
export const PERSONAS = seed.personas as Persona[];

export const DEPARTMENT_LABEL: Record<Persona["department"], string> = {
  software: "Software",
  sales: "Sales",
  marketing: "Marketing",
  product: "Product",
  hr: "People team",
  external: "External",
};

export const ROLE_LABEL: Record<Persona["role"], string> = {
  employee: "Employee",
  manager: "Manager",
  hr: "HR",
  external_cosigner: "Client co-signer",
  admin: "Admin",
};
