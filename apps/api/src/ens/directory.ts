// Startup ENS refresh (ENS_NETWORK != none). Runs in the background so a slow RPC never blocks the API:
//  - agent: <AGENT_ENS_NAME>.<ENS_PARENT_NAME> is used in run traces and PublicConfig only once it resolves to the
//    agent's signing address; until then (or on mismatch) the bare AGENT_ENS_NAME label is shown.
//  - people: persona/employee ens_name is set only for names that resolve to that person's exact wallet.
import type { Config } from "../config.ts";
import type { DB } from "../db/index.ts";
import { fullName, resolveAgent, resolvePeople, type AgentEns, type EnsLookup } from "./resolver.ts";

export class EnsDirectory {
  agentName: string;
  agent: AgentEns | null = null;
  people = new Map<string, string>();
  ready: Promise<void> = Promise.resolve();
  private readonly listeners: Array<(name: string) => void> = [];

  constructor(private readonly c: Config, private readonly db: DB, private readonly agentAddress: string, private readonly log: (m: string) => void) {
    this.agentName = c.AGENT_ENS_NAME;
  }

  onAgentName(fn: (name: string) => void) {
    this.listeners.push(fn);
  }

  start(lookup: EnsLookup | null) {
    if (!lookup || this.c.ENS_NETWORK === "none" || !this.c.ENS_PARENT_NAME) return;
    this.ready = this.refresh(lookup).catch((e) => this.log(`ENS refresh failed: ${(e as Error).message}`));
  }

  async refresh(lookup: EnsLookup) {
    const parent = this.c.ENS_PARENT_NAME!;
    const agent = await resolveAgent(lookup, fullName(this.c.AGENT_ENS_NAME, parent), this.agentAddress);
    this.agent = agent;
    if (agent.matches) {
      this.agentName = agent.name;
      for (const fn of this.listeners) fn(agent.name);
      this.log(`ENS agent ${agent.name} verified (role=${agent.text.role ?? "-"})`);
    } else {
      this.log(`ENS agent ${agent.name} ${agent.resolved ? `resolves to ${agent.resolved}, not the agent key` : "does not resolve"}; showing "${this.agentName}"`);
    }
    const people = this.db.prepare("SELECT display_name, wallet_address FROM org_personas").all() as Array<{ display_name: string; wallet_address: string }>;
    this.people = await resolvePeople(lookup, parent, people);
    const tx = this.db.transaction(() => {
      this.db.prepare("UPDATE org_personas SET ens_name = NULL").run();
      this.db.prepare("UPDATE org_employees SET ens_name = NULL").run();
      const p = this.db.prepare("UPDATE org_personas SET ens_name = ? WHERE lower(wallet_address) = ?");
      const e = this.db.prepare("UPDATE org_employees SET ens_name = ? WHERE lower(wallet_address) = ?");
      for (const [wallet, name] of this.people) {
        p.run(name, wallet);
        e.run(name, wallet);
      }
    });
    tx();
    this.log(`ENS people verified: ${this.people.size}/${people.length} (${[...this.people.values()].join(", ") || "none"})`);
  }
}
