import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { McpScopes, McpServerStore, migrateMcpSecrets, resolveSpec, viewOf } from "../src/main/mcp/servers";
import { expandEnvRefs, isSecretValue, McpVault, VAULT_MARK } from "../src/main/mcp/vault";
import type { SecretBox } from "../src/main/settings";
import { tempDir } from "./helpers";

const CANARY = "sk-canary-7f3a9b1e5d";

/** A stand-in for safeStorage: XOR with a key, so ciphertext never contains the plain text. */
function box(key = 0x5a, available = true): SecretBox {
  return {
    available,
    encrypt: (s) => Buffer.from(Buffer.from(s, "utf-8").map((b) => b ^ key)).toString("base64"),
    decrypt: (b) => {
      const out = Buffer.from(Buffer.from(b, "base64").map((x) => x ^ key)).toString("utf-8");
      // A wrong key gives bytes that aren't the JSON the vault wrote.
      JSON.parse(out);
      return out;
    },
  };
}

/** Every file under `dir`, recursively, as text. */
function allText(dir: string): string {
  let out = "";
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    out += statSync(p).isDirectory() ? allText(p) : readFileSync(p, "utf-8");
  }
  return out;
}

describe("McpVault", () => {
  it("round-trips an entry, privately, and lists values for redaction", () => {
    const dir = tempDir();
    const vault = new McpVault(join(dir, "mcp-secrets.json"), box());
    vault.set("global:api", { headers: { Authorization: `Bearer ${CANARY}` } });
    expect(new McpVault(join(dir, "mcp-secrets.json"), box()).get("global:api")).toEqual({ headers: { Authorization: `Bearer ${CANARY}` } });
    expect(vault.values()).toEqual([`Bearer ${CANARY}`]);
    expect(allText(dir)).not.toContain(CANARY);
    if (process.platform !== "win32") expect(statSync(join(dir, "mcp-secrets.json")).mode & 0o777).toBe(0o600);
    vault.set("global:api", {});
    expect(vault.has("global:api")).toBe(false);
  });

  it("reads an entry another key can't open as missing", () => {
    const file = join(tempDir(), "mcp-secrets.json");
    new McpVault(file, box(0x5a)).set("global:api", { env: { TOKEN: CANARY } });
    const other = new McpVault(file, box(0x33));
    expect(other.has("global:api")).toBe(true);
    expect(other.get("global:api")).toBeNull();
  });

  it("refuses to store where the OS can't encrypt", () => {
    const vault = new McpVault(join(tempDir(), "mcp-secrets.json"), box(0x5a, false));
    expect(() => vault.set("global:api", { env: { TOKEN: CANARY } })).toThrow(/can't encrypt/);
  });

  it("tells secrets from env references", () => {
    expect(isSecretValue(CANARY)).toBe(true);
    expect(isSecretValue("Bearer ${GH_TOKEN}")).toBe(false);
    expect(isSecretValue("${env:GH_TOKEN}")).toBe(false);
    expect(isSecretValue(VAULT_MARK)).toBe(false);
    expect(isSecretValue("")).toBe(false);
    expect(expandEnvRefs("Bearer ${A} ${env:B} ${C:-dflt} ${D}", { A: "a", B: "b" })).toBe("Bearer a b dflt ");
  });
});

describe("McpServerStore with a vault", () => {
  it("keeps secret values out of mcp.json and gives them back on read", () => {
    const dir = tempDir();
    const vault = new McpVault(join(dir, "mcp-secrets.json"), box());
    const store = new McpServerStore(join(dir, "mcp.json"), vault);
    store.save({ name: "api", enabled: true, spec: { type: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: `Bearer ${CANARY}`, "X-Org": "${ORG}" } } });
    store.save({ name: "docs", enabled: true, spec: { type: "stdio", command: "npx", args: ["-y", "docs"], env: { TOKEN: CANARY } } });
    expect(JSON.parse(readFileSync(join(dir, "mcp.json"), "utf-8")).mcpServers).toEqual({
      api: { type: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: VAULT_MARK, "X-Org": "${ORG}" } },
      docs: { type: "stdio", command: "npx", args: ["-y", "docs"], env: { TOKEN: VAULT_MARK } },
    });
    expect(allText(dir)).not.toContain(CANARY);
    const fresh = new McpServerStore(join(dir, "mcp.json"), new McpVault(join(dir, "mcp-secrets.json"), box()));
    expect(fresh.list().map((s) => s.spec)).toEqual([
      { type: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: `Bearer ${CANARY}`, "X-Org": "${ORG}" } },
      { type: "stdio", command: "npx", args: ["-y", "docs"], env: { TOKEN: CANARY } },
    ]);
  });

  it("keeps a blank edit's value, moves it on rename, and drops it on remove", () => {
    const dir = tempDir();
    const vault = new McpVault(join(dir, "mcp-secrets.json"), box());
    const store = new McpServerStore(join(dir, "mcp.json"), vault);
    store.save({ name: "api", enabled: true, spec: { type: "http", url: "https://a.example.com/mcp", headers: { Authorization: CANARY } } });
    store.save({ name: "api2", enabled: true, spec: { type: "http", url: "https://a.example.com/mcp", headers: { Authorization: "" } } }, "api");
    expect(vault.keys()).toEqual(["global:api2"]);
    expect(store.list()[0]!.spec).toEqual({ type: "http", url: "https://a.example.com/mcp", headers: { Authorization: CANARY } });
    store.setEnabled("api2", false);
    expect(store.list()[0]!.spec).toEqual({ type: "http", url: "https://a.example.com/mcp", headers: { Authorization: CANARY } });
    store.remove("api2");
    expect(vault.keys()).toEqual([]);
  });

  it("moves a plain-text file from before the vault into it", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "projects", "p1"), { recursive: true });
    writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { api: { type: "http", url: "https://a.example.com/mcp", headers: { Authorization: CANARY } } } }));
    writeFileSync(join(dir, "projects", "p1", "mcp.json"), JSON.stringify({ mcpServers: { docs: { command: "npx", env: { TOKEN: `${CANARY}-p` } } }, offGlobal: ["x"] }));
    const vault = new McpVault(join(dir, "mcp-secrets.json"), box());
    const global = new McpServerStore(join(dir, "mcp.json"), vault);
    const scopes = new McpScopes(global, (id) => join(dir, "projects", id), vault);
    migrateMcpSecrets(global, scopes, join(dir, "projects"));
    expect(allText(dir)).not.toContain(CANARY);
    expect(vault.keys().sort()).toEqual(["global:api", "project:p1:docs"]);
    expect(scopes.project("p1").offGlobal()).toEqual(["x"]);
    expect(scopes.effective("p1").map((s) => s.spec)).toEqual([
      { type: "stdio", command: "npx", env: { TOKEN: `${CANARY}-p` } },
      { type: "http", url: "https://a.example.com/mcp", headers: { Authorization: CANARY } },
    ]);
  });

  it("marks a server locked when its secrets don't open here, and sends nothing in their place", () => {
    const dir = tempDir();
    new McpServerStore(join(dir, "mcp.json"), new McpVault(join(dir, "mcp-secrets.json"), box(0x5a))).save({
      name: "api",
      enabled: true,
      spec: { type: "http", url: "https://a.example.com/mcp", headers: { Authorization: CANARY, "X-Org": "${ORG}" } },
    });
    const vault = new McpVault(join(dir, "mcp-secrets.json"), box(0x33));
    const global = new McpServerStore(join(dir, "mcp.json"), vault);
    expect(viewOf(global.list()[0]!).locked).toBe(true);
    const scopes = new McpScopes(global, (id) => join(dir, "projects", id), vault);
    expect(scopes.effective(null)[0]!.spec).toEqual({ type: "http", url: "https://a.example.com/mcp", headers: { "X-Org": "" } });
    // Entering the value again unlocks it.
    global.save({ name: "api", enabled: true, spec: { type: "http", url: "https://a.example.com/mcp", headers: { Authorization: "new", "X-Org": "${ORG}" } } }, "api");
    expect(viewOf(global.list()[0]!).locked).toBeUndefined();
  });

  it("refuses new secrets without encryption, but env references and old values still work", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { old: { command: "x", env: { TOKEN: CANARY } } } }));
    const store = new McpServerStore(join(dir, "mcp.json"), new McpVault(join(dir, "mcp-secrets.json"), box(0x5a, false)));
    expect(store.list()[0]!.spec).toEqual({ type: "stdio", command: "x", env: { TOKEN: CANARY } });
    expect(() => store.save({ name: "api", enabled: true, spec: { type: "stdio", command: "y", env: { TOKEN: "plain" } } })).toThrow(/can't encrypt/);
    store.save({ name: "api", enabled: true, spec: { type: "stdio", command: "y", env: { TOKEN: "${MY_TOKEN}" } } });
    store.setEnabled("old", false);
    expect(store.list().map((s) => s.name)).toEqual(["old", "api"]);
  });
});

describe("resolveSpec", () => {
  it("fills env references everywhere an agent reads them", () => {
    const env = { HOST: "h.example.com", TOKEN: "t", DIR: "/data" };
    expect(resolveSpec({ type: "http", url: "https://${HOST}/mcp", headers: { Authorization: "Bearer ${TOKEN}" } }, env)).toEqual({
      type: "http",
      url: "https://h.example.com/mcp",
      headers: { Authorization: "Bearer t" },
    });
    expect(resolveSpec({ type: "stdio", command: "npx", args: ["fs", "${DIR}"], env: { K: "${env:TOKEN}" } }, env)).toEqual({
      type: "stdio",
      command: "npx",
      args: ["fs", "/data"],
      env: { K: "t" },
    });
  });
});
