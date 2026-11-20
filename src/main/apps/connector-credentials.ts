// A separate vault namespace: a bundled connector is never an entry in a user's mcp.json.
// Spec changes get new credential identities, so Update cannot silently forward an old key to a new target.
import { createHash } from "node:crypto";
import type { PluginConnector } from "../../shared/plugin-parts";
import { stableStringify } from "../cache-policy";
import { requiredVarsOf } from "../extensions/manifest";
import { resolveSpec } from "../mcp/servers";
import type { McpVault } from "../mcp/vault";

export function connectorCredentialKey(owner: string, part: PluginConnector): string {
  if (!/^g~[a-z0-9][a-z0-9-]{0,63}$/.test(owner)) throw new Error("Invalid connector owner.");
  return `plugin:${owner}:${part.name}:${createHash("sha256").update(stableStringify(part.spec)).digest("hex")}`;
}

export class PluginConnectorCredentials {
  constructor(private vault: McpVault, private env: NodeJS.ProcessEnv = process.env) {}

  inspect(owner: string, part: PluginConnector) {
    const key = connectorCredentialKey(owner, part), stored = this.vault.get(key);
    return {
      locked: this.vault.has(key) && !stored,
      hasClientSecret: Boolean(stored?.oauth?.clientSecret),
      variables: requiredVarsOf(part.spec).map((name) => ({ name, saved: Boolean(stored?.env?.[name]), missing: !stored?.env?.[name] && !this.env[name] })),
    };
  }

  resolve(owner: string, part: PluginConnector) {
    const key = connectorCredentialKey(owner, part);
    const stored = this.vault.get(key);
    if (this.vault.has(key) && !stored) throw new Error("This connector's saved credentials can't be opened on this computer. Enter them again.");
    const variables = { ...this.env, ...stored?.env };
    const missing = requiredVarsOf(part.spec).filter((v) => !variables[v]);
    if (missing.length) throw new Error(`This connector needs variables: ${missing.join(", ")}. Enter them in CubiQ before connecting.`);
    return resolveSpec(part.spec, variables);
  }

  /** Values only for the reviewed placeholders, not edits to its command, URL or headers. */
  save(owner: string, part: PluginConnector, values: Record<string, string>, clientSecret?: string): void {
    const allowed = new Set(requiredVarsOf(part.spec));
    if (Object.entries(values).some(([k, v]) => !allowed.has(k) || typeof v !== "string" || v.includes("\0") || Buffer.byteLength(v) > 16 * 1024)) throw new Error("Enter values only for this connector's reviewed variables (at most 16 KB each).");
    const key = connectorCredentialKey(owner, part), next = { ...this.vault.get(key)?.env };
    for (const [k, v] of Object.entries(values)) { if (v) next[k] = v; else delete next[k]; }
    this.vault.update(key, { env: next, ...(clientSecret !== undefined ? { oauth: { ...this.vault.get(key)?.oauth, clientSecret: clientSecret || undefined } } : {}) });
  }

  /** Called from the committed bundle journal. Off deliberately never calls this. */
  cleanup(owner: string, keep: PluginConnector[]): void {
    // Validate even for an empty keep list before using a prefix to remove anything.
    connectorCredentialKey(owner, { name: "validate", spec: { type: "stdio", command: "validate" } });
    const keys = new Set(keep.map((part) => connectorCredentialKey(owner, part)));
    for (const key of this.vault.keys(`plugin:${owner}:`)) if (!keys.has(key)) this.vault.remove(key);
  }
}
