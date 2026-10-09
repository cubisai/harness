// Keeps one agent per saved provider: a provider added in Settings shows up as
// its own agent, a removed one goes away. Drivers read their provider live, so
// an edit (models, key, URL) needs no new driver.

import type { Provider } from "../../shared/types";
import type { AgentDriver } from "../agents/types";
import { createProviderDriver, providerAgentId, type ProviderDriverDeps } from "./driver";

export type ProviderAgentsDeps = Omit<ProviderDriverDeps, "provider" | "secret" | "secretHeaders"> & {
  providers(): Provider[];
  secret(providerId: string): string | null;
  secretHeaders(providerId: string): Record<string, string>;
};

/** A provider that can run as an agent: at least one model, a protocol the harness speaks. */
export function runnable(p: Provider): boolean {
  return p.models.length > 0 && p.wireProtocol !== "gemini";
}

export class ProviderAgents {
  private readonly drivers = new Map<string, AgentDriver>();

  constructor(private readonly deps: ProviderAgentsDeps) {}

  /** The current drivers, in the providers' saved order; made or dropped as the list changed. */
  list(): AgentDriver[] {
    const saved = this.deps.providers().filter(runnable);
    const ids = new Set(saved.map((p) => providerAgentId(p.id)));
    for (const id of [...this.drivers.keys()]) if (!ids.has(id)) this.drivers.delete(id);
    return saved.map((p) => {
      const id = providerAgentId(p.id);
      let d = this.drivers.get(id);
      if (!d) {
        const { providers, secret, secretHeaders, ...rest } = this.deps;
        d = createProviderDriver(p.id, {
          ...rest,
          provider: () => providers().find((x) => x.id === p.id),
          secret: () => secret(p.id),
          secretHeaders: () => secretHeaders(p.id),
        });
        this.drivers.set(id, d);
      }
      return d;
    });
  }
}
