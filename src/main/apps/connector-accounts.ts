// Library operations address reviewed owner/revision identities, never runtime
// names or model-supplied specs. Merely listing accounts has no network effects.
import type { PluginConnectorHandle, PluginConnectorView } from "../../shared/plugin-parts";
import type { McpServerStatus } from "../../shared/types";
import type { McpAuth } from "../mcp/oauth";
import { isRemote } from "../mcp/servers";
import type { PluginBundles } from "./bundles";
import type { OwnedConnector } from "./connectors";
import { connectorCredentialKey, type PluginConnectorCredentials } from "./connector-credentials";

interface AccountDeps {
  bundles: Pick<PluginBundles, "connectors" | "assertConnector">;
  credentials: PluginConnectorCredentials;
  auth: McpAuth;
  peek(part: OwnedConnector): McpServerStatus;
  check(part: OwnedConnector): Promise<McpServerStatus>;
  changed(owner: string): void;
}

export class PluginConnectorAccounts {
  constructor(private deps: AccountDeps) {}

  list(): PluginConnectorView[] {
    return this.deps.bundles.connectors(true).map((part) => {
      const key = connectorCredentialKey(part.owner.key, part), settings = this.deps.credentials.inspect(part.owner.key, part);
      const auth = isRemote(part.spec) ? this.deps.auth.status(key) : undefined;
      const status = !part.owner.enabled ? { name: part.runtimeName, state: "disabled" as const, tools: [], error: "The owning plugin is Off or unavailable." }
        : settings.locked ? { name: part.runtimeName, state: "failed" as const, tools: [], error: "Saved credentials can't be opened here. Enter them again." }
        : settings.variables.some((v) => v.missing) ? { name: part.runtimeName, state: "failed" as const, tools: [], error: "Enter the required variables before connecting." }
        : this.deps.peek(part);
      return { key: part.owner.key, name: part.name, revision: part.revision, runtimeName: part.runtimeName, owner: part.owner,
        type: part.spec.type, target: isRemote(part.spec) ? part.spec.url : [part.spec.command, ...(part.spec.args ?? [])].join(" "),
        ...settings, canSignIn: isRemote(part.spec), canSetClientSecret: isRemote(part.spec) && Boolean(part.spec.oauth?.clientId), signingIn: this.deps.auth.isSigningIn(key), status: { ...status, ...(auth ? { auth } : {}) } };
    });
  }

  private part(handle: PluginConnectorHandle): OwnedConnector {
    if (!handle || typeof handle !== "object" || typeof handle.key !== "string" || typeof handle.name !== "string" || typeof handle.revision !== "string") throw new Error("Invalid bundled connector identity.");
    const part = this.deps.bundles.connectors(true).find((p) => p.owner.key === handle.key && p.name === handle.name && p.revision === handle.revision);
    if (!part) throw new Error("This bundled connector changed or was removed. Reload its current settings.");
    this.deps.bundles.assertConnector(part);
    return part;
  }

  save(handle: PluginConnectorHandle, values: Record<string, string>, clientSecret?: string): void {
    const part = this.part(handle);
    if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error("Invalid connector variables.");
    if (clientSecret !== undefined && (typeof clientSecret !== "string" || clientSecret.includes("\0") || Buffer.byteLength(clientSecret) > 16 * 1024 || !isRemote(part.spec) || !part.spec.oauth?.clientId)) throw new Error("A client secret is only for this connector's reviewed OAuth client (at most 16 KB).");
    this.deps.credentials.save(part.owner.key, part, values, clientSecret);
    this.invalidate(part.owner.key);
  }

  async connect(handle: PluginConnectorHandle): Promise<{ ok: boolean; error?: string }> {
    const part = this.part(handle), spec = this.deps.credentials.resolve(part.owner.key, part);
    if (!isRemote(spec)) throw new Error("Command connectors have no browser sign-in.");
    const valid = () => { try { this.deps.bundles.assertConnector(part); return true; } catch { return false; } };
    const work = this.deps.auth.connect(connectorCredentialKey(part.owner.key, part), spec, valid);
    this.deps.changed(part.owner.key);
    const result = await work;
    // Do not cancel a newer retry or resolve a changed contribution in an old callback.
    if (valid()) this.deps.changed(part.owner.key);
    return result;
  }

  cancel(handle: PluginConnectorHandle): void {
    const part = this.part(handle); this.deps.auth.cancel(connectorCredentialKey(part.owner.key, part)); this.deps.changed(part.owner.key);
  }

  async disconnect(handle: PluginConnectorHandle): Promise<void> {
    const part = this.part(handle), spec = this.deps.credentials.resolve(part.owner.key, part);
    if (!isRemote(spec)) throw new Error("Command connectors have no browser sign-in.");
    await this.deps.auth.disconnect(connectorCredentialKey(part.owner.key, part), spec);
    try { this.deps.bundles.assertConnector(part); this.deps.changed(part.owner.key); } catch { /* A concurrent owner operation already invalidated it. */ }
  }

  async check(handle: PluginConnectorHandle): Promise<void> { await this.deps.check(this.part(handle)); }

  invalidate(owner: string): void {
    // Covers callbacks whose old spec no longer appears in the updated catalog.
    this.deps.auth.cancelPrefix(`plugin:${owner}:`); this.deps.changed(owner);
  }
}
