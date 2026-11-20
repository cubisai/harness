import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginConnectorAccounts } from "../src/main/apps/connector-accounts";
import { connectorCredentialKey, PluginConnectorCredentials } from "../src/main/apps/connector-credentials";
import type { OwnedConnector } from "../src/main/apps/connectors";
import { McpAuth } from "../src/main/mcp/oauth";
import { McpVault } from "../src/main/mcp/vault";
import { startMockOAuthServer, type MockOAuthServer } from "./fixtures/mock-oauth-server";
import { tempDir } from "./helpers";
import type { McpServerSpec } from "../src/shared/types";

const servers: MockOAuthServer[] = [], auths: McpAuth[] = [];
afterEach(async () => { auths.splice(0).forEach((auth) => auth.cancelAll()); await Promise.all(servers.splice(0).map((s) => s.close())); });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
function fixture(spec: McpServerSpec = { type: "stdio", command: "never-run", env: { KEY: "${KEY}" } }, opts: { open?: (url: string) => Promise<void>; fetchFn?: typeof fetch } = {}) {
  let enabled = true, revision = "one", removed = false;
  const vault = new McpVault(join(tempDir(), "secrets.json"), { available: true, encrypt: (s) => Buffer.from(s).toString("base64"), decrypt: (s) => Buffer.from(s, "base64").toString() });
  const credentials = new PluginConnectorCredentials(vault, {}), open = vi.fn(opts.open ?? (async () => {}));
  const auth = new McpAuth({ vault, openExternal: open, ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}) }); auths.push(auth);
  const original: OwnedConnector = { name: "shop", spec, runtimeName: "p-notes-shop", revision, owner: { key: "g~notes", title: "Notes", enabled, revision } };
  const bundles = {
    connectors: () => removed ? [] : [{ ...original, revision, owner: { ...original.owner, enabled, revision } }],
    assertConnector: (part: OwnedConnector) => { if (removed || !enabled || part.revision !== revision) throw new Error("Owner Off or changed"); },
  };
  const check = vi.fn(async () => ({ name: original.runtimeName, state: "connected" as const, tools: [] })), changed = vi.fn();
  const accounts = new PluginConnectorAccounts({ bundles, credentials, auth, peek: () => ({ name: original.runtimeName, state: "checking", tools: [] }), check, changed });
  const handle = { key: original.owner.key, name: original.name, revision };
  return { vault, credentials, auth, open, accounts, check, changed, original, handle,
    off: () => { enabled = false; revision = "off"; accounts.invalidate(original.owner.key); },
    on: () => { enabled = true; revision = "on"; },
    update: () => { revision = "two"; accounts.invalidate(original.owner.key); },
    remove: () => { removed = true; accounts.invalidate(original.owner.key); credentials.cleanup(original.owner.key, []); },
  };
}
async function localServer() { const server = await startMockOAuthServer(); servers.push(server); return server; }

describe("owned connector account operations", () => {
  it("listing and saving are local, expose only value presence and never start/sign in", () => {
    const e = fixture();
    expect(e.accounts.list()[0]?.variables).toEqual([{ name: "KEY", saved: false, missing: true }]);
    e.accounts.save(e.handle, { KEY: "secret-value" });
    expect(JSON.stringify(e.accounts.list())).not.toContain("secret-value");
    expect(e.accounts.list()[0]?.variables).toEqual([{ name: "KEY", saved: true, missing: false }]);
    expect(e.check).not.toHaveBeenCalled(); expect(e.open).not.toHaveBeenCalled();
    expect(() => e.accounts.save(e.handle, { OTHER: "forged" })).toThrow(/reviewed variables/);
    expect(() => e.accounts.save(e.handle, { KEY: "bad\0value" })).toThrow();
    expect(() => e.accounts.save(e.handle, {}, "client-secret")).toThrow(/reviewed OAuth client/);
  });
  it("Off retains credentials; On starts nothing and every stale settings action refuses", async () => {
    const e = fixture(); e.accounts.save(e.handle, { KEY: "retained" }); e.off();
    expect(e.credentials.resolve(e.original.owner.key, e.original)).toMatchObject({ env: { KEY: "retained" } });
    expect(e.accounts.list()[0]?.owner.enabled).toBe(false);
    expect(() => e.accounts.save(e.handle, { KEY: "changed" })).toThrow();
    await expect(e.accounts.connect(e.handle)).rejects.toThrow(); await expect(e.accounts.check(e.handle)).rejects.toThrow();
    e.on(); expect(e.check).not.toHaveBeenCalled(); expect(e.open).not.toHaveBeenCalled();
    await expect(e.accounts.check(e.handle)).rejects.toThrow(/changed/);
    await e.accounts.check({ ...e.handle, revision: "on" }); expect(e.check).toHaveBeenCalledOnce();
  });
  it("removal cleans only owned vault keys and a changed spec never inherits another target's values", () => {
    const e = fixture(); e.vault.update("global:shop", { env: { KEY: "external" } }); e.accounts.save(e.handle, { KEY: "owned" });
    const replacement = { ...e.original, spec: { type: "stdio" as const, command: "other", env: { KEY: "${KEY}" } } };
    expect(connectorCredentialKey(e.original.owner.key, replacement)).not.toBe(connectorCredentialKey(e.original.owner.key, e.original));
    expect(() => e.credentials.resolve(replacement.owner.key, replacement)).toThrow(/KEY/);
    e.remove(); expect(e.vault.get("global:shop")?.env?.KEY).toBe("external"); expect(e.accounts.list()).toEqual([]);
    expect(e.vault.keys("plugin:")).toEqual([]);
  });
  it.each(["off", "update", "remove"] as const)("%s cancels a pending browser callback without restoring tokens", async (operation) => {
    const server = await localServer(), opened = deferred<string>();
    const e = fixture({ type: "http", url: `${server.base}/mcp`, oauth: { callbackPort: 0 } }, { open: async (url) => { opened.resolve(url); } });
    const run = e.accounts.connect(e.handle); await opened.promise;
    e[operation](); expect((await run).ok).toBe(false);
    expect(e.vault.get(connectorCredentialKey(e.original.owner.key, e.original))?.oauth?.tokens).toBeUndefined();
    expect(server.requests.some((r) => r.pathname === "/token")).toBe(false);
    expect(e.auth.isSigningIn(connectorCredentialKey(e.original.owner.key, e.original))).toBe(false);
  });
  it("an old cancellation's finally cannot remove a newer sign-in", async () => {
    const server = await localServer(), first = deferred<string>(), second = deferred<string>(); let opens = 0;
    const e = fixture({ type: "http", url: `${server.base}/mcp`, oauth: { callbackPort: 0 } }, { open: async (url) => { (++opens === 1 ? first : second).resolve(url); } });
    const a = e.accounts.connect(e.handle); await first.promise; e.accounts.cancel(e.handle);
    const b = e.accounts.connect(e.handle); await second.promise; expect((await a).ok).toBe(false);
    expect(e.auth.isSigningIn(connectorCredentialKey(e.original.owner.key, e.original))).toBe(true);
    e.accounts.cancel(e.handle); expect((await b).ok).toBe(false);
  });
  it("a cancelled token exchange that ignores abort cannot resurrect removed ownership", async () => {
    const server = await localServer(), token = deferred<Response>(), tokenStarted = deferred<void>();
    const e = fixture({ type: "http", url: `${server.base}/mcp`, oauth: { callbackPort: 0 } }, {
      open: async (raw) => {
        const url = new URL(raw), callback = new URL(url.searchParams.get("redirect_uri")!);
        callback.searchParams.set("code", "c1"); callback.searchParams.set("state", url.searchParams.get("state")!); callback.searchParams.set("iss", server.base);
        void fetch(callback).catch(() => {});
      },
      fetchFn: (async (raw, init) => {
        if (new URL(String(raw)).pathname === "/token") { tokenStarted.resolve(); return token.promise; }
        return fetch(raw, init);
      }) as typeof fetch,
    });
    const run = e.accounts.connect(e.handle); await tokenStarted.promise; e.remove();
    expect((await run).ok).toBe(false);
    token.resolve(new Response(JSON.stringify({ access_token: "late-token", token_type: "Bearer" }), { headers: { "content-type": "application/json" } }));
    // Let the already-issued fetch continuation run; its provider write is gated too.
    await token.promise; await Promise.resolve(); await Promise.resolve();
    expect(e.vault.keys("plugin:")).toEqual([]);
  });
  it("a cancelled background refresh cannot repopulate Uninstall's vault key", async () => {
    const server = await localServer(), token = deferred<Response>(), started = deferred<void>();
    const e = fixture({ type: "http", url: `${server.base}/mcp` }, { fetchFn: (async () => { started.resolve(); return token.promise; }) as typeof fetch });
    const key = connectorCredentialKey(e.original.owner.key, e.original);
    e.vault.update(key, { oauth: { tokens: { access_token: "old", token_type: "Bearer", refresh_token: "refresh", obtained_at: 0, expires_in: 1 }, client: { client_id: "fixture" }, discovery: { authorizationServerUrl: server.base, authorizationServerMetadata: { token_endpoint: `${server.base}/token`, token_endpoint_auth_methods_supported: ["none"] } } } });
    const run = e.auth.refresh(key, e.original.spec as Extract<McpServerSpec, { url: string }>); await started.promise;
    e.remove(); expect(await run).toBeNull();
    token.resolve(new Response(JSON.stringify({ access_token: "late", token_type: "Bearer" }), { headers: { "content-type": "application/json" } }));
    await token.promise; await Promise.resolve(); await Promise.resolve();
    expect(e.vault.has(key)).toBe(false);
  });
});
