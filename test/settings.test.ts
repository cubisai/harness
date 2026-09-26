import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Store } from "../src/main/db";
import { Service } from "../src/main/service";
import { SettingsStore, type SecretBox } from "../src/main/settings";
import * as settingsModule from "../src/main/settings";
import type { ProviderInput } from "../src/shared/types";
import { DEFAULT_LAYOUT } from "../src/shared/layout";
import type { AgentDriver } from "../src/main/agents/types";
import { SAFE_DEFAULTS } from "../src/main/agents/capabilities";
import { catalog, closeAfter, fixturesDir, tempDir } from "./helpers";

/** Reversible, and visibly not plaintext, so the tests can tell a stored key was encoded. */
const box: SecretBox = {
  available: true,
  encrypt: (s) => Buffer.from([...s].reverse().join("")).toString("base64"),
  decrypt: (b) => [...Buffer.from(b, "base64").toString()].reverse().join(""),
};

const fresh = () => join(tempDir(), "settings.json");

/** A copy of the v1 fixture: the migration writes, so tests must not touch the checked-in file. */
const legacyFixture = () => {
  const file = fresh();
  writeFileSync(file, readFileSync(join(fixturesDir, "legacy-settings.json"), "utf-8"));
  return file;
};

const fixtureJson = () => JSON.parse(readFileSync(join(fixturesDir, "legacy-settings.json"), "utf-8"));

const providerInput = (patch: Partial<ProviderInput> = {}): ProviderInput => ({
  id: "deepseek",
  label: "DeepSeek",
  wireProtocol: "openai-chat",
  baseURL: "https://api.deepseek.com",
  models: [],
  ...patch,
});

describe("SettingsStore", () => {
  it("starts from defaults and persists updates", () => {
    const file = fresh();
    const s = new SettingsStore(file, box);
    expect(s.get()).toEqual({ theme: "system", defaultAgent: null, defaultPermissionMode: "ask", autoUpdate: true, editor: null, providerInjection: {}, paneLayout: DEFAULT_LAYOUT });
    s.update({ theme: "dark", defaultAgent: "codex", defaultPermissionMode: "auto-edit", autoUpdate: false, editor: "zed" });
    expect(new SettingsStore(file, box).get()).toEqual({ theme: "dark", defaultAgent: "codex", defaultPermissionMode: "auto-edit", autoUpdate: false, editor: "zed", providerInjection: {}, paneLayout: DEFAULT_LAYOUT });
  });

  it("keeps only boolean per-agent injection flags", () => {
    const file = fresh();
    const s = new SettingsStore(file, box);
    s.update({ providerInjection: { codex: true, bad: "x" } as never });
    expect(s.get().providerInjection).toEqual({ codex: true });
    expect(new SettingsStore(file, box).get().providerInjection).toEqual({ codex: true });
  });

  it("ignores a providerInjection that is not a plain object", () => {
    const s = new SettingsStore(fresh(), box);
    s.update({ providerInjection: ["codex"] as never });
    expect(s.get().providerInjection).toEqual({});
  });

  it("ignores invalid values", () => {
    const s = new SettingsStore(fresh(), box);
    s.update({ theme: "neon" as never, defaultPermissionMode: "yolo" as never });
    expect(s.get()).toMatchObject({ theme: "system", defaultPermissionMode: "ask" });
  });

  it("stores provider keys encrypted and reports only whether they are set", () => {
    const file = fresh();
    const s = new SettingsStore(file, box);
    s.saveProvider(providerInput());
    s.setProviderSecret("deepseek", "  sk-secret  ");
    expect(readFileSync(file, "utf-8")).not.toContain("sk-secret");
    const view = s.view();
    expect(view.providers.find((p) => p.id === "deepseek")?.hasSecret).toBe(true);
    expect(JSON.stringify(view)).not.toContain("sk-secret");
    expect(new SettingsStore(file, box).providerEnv("deepseek")).toEqual({ DEEPSEEK_API_KEY: "sk-secret" });
    s.setProviderSecret("deepseek", null);
    expect(s.providerEnv("deepseek")).toEqual({});
    expect(s.view().providers.find((p) => p.id === "deepseek")?.hasSecret).toBe(false);
  });

  it("does not rewrite a corrupt file at startup", () => {
    const file = fresh();
    writeFileSync(file, "{not json");
    new SettingsStore(file, box);
    expect(readFileSync(file, "utf-8")).toBe("{not json");
  });

  it("skips a key it can't decrypt and survives a corrupt file", () => {
    const file = fresh();
    const s = new SettingsStore(file, box);
    s.saveProvider(providerInput({ id: "openai", label: "OpenAI", baseURL: "https://api.openai.com/v1" }));
    s.setProviderSecret("openai", "sk-x");
    const broken: SecretBox = { ...box, decrypt: () => { throw new Error("other machine"); } };
    expect(new SettingsStore(file, broken).providerEnv("openai")).toEqual({});
    writeFileSync(file, "{not json");
    expect(new SettingsStore(file, box).get().theme).toBe("system");
  });

  // T1.2 — versioned settings.json and the one-shot legacy-key migration.
  it("migrates the legacy secrets to providers without touching secrets.*", () => {
    const file = legacyFixture();
    const fixture = fixtureJson();
    const s = new SettingsStore(file, box);
    const providers = s.providers();
    expect(providers).toHaveLength(2);
    const anthropic = providers.find((p) => p.id === "anthropic")!;
    expect(anthropic.wireProtocol).toBe("anthropic-messages");
    expect(anthropic.secret).toEqual({ kind: "safeStorage", ciphertext: fixture.secrets.anthropic });
    expect(s.view().migratedProviders).toEqual(["anthropic", "openai"]);
    const onDisk = JSON.parse(readFileSync(file, "utf-8"));
    expect(onDisk.schemaVersion).toBe(2);
    expect(onDisk.secrets).toEqual(fixture.secrets);
  });

  it("is idempotent: a second construction neither duplicates nor re-runs", () => {
    const file = legacyFixture();
    new SettingsStore(file, box);
    const s = new SettingsStore(file, box);
    expect(s.providers().map((p) => p.id).sort()).toEqual(["anthropic", "openai"]);
    expect(s.view().migratedProviders).toEqual(["anthropic", "openai"]);
    expect(JSON.parse(readFileSync(file, "utf-8")).schemaVersion).toBe(2);
  });

  // T2.x — the v2 → v3 migration that keeps dsh's DeepSeek key once the global export goes.
  const deepseekProvider = () => ({
    id: "deepseek",
    label: "DeepSeek",
    wireProtocol: "openai-chat",
    baseURL: "https://api.deepseek.com",
    models: [],
    secret: { kind: "safeStorage", ciphertext: box.encrypt("sk-deep") },
  });

  it("carries a v1 DeepSeek key through both migrations to dsh in one start", () => {
    const file = fresh();
    writeFileSync(file, JSON.stringify({ secrets: { deepseek: box.encrypt("test-deepseek-key") } }));
    const s = new SettingsStore(file, box);
    expect(s.credential("deepseek")).toEqual({ kind: "byok", providerId: "deepseek" });
    expect(s.providerSecret("deepseek")).toBe("test-deepseek-key");
    const disk = JSON.parse(readFileSync(file, "utf-8"));
    expect(disk.schemaVersion).toBe(3);
    expect(disk.credentials.deepseek).toEqual({ kind: "byok", providerId: "deepseek" });
  });

  it("points dsh at its DeepSeek provider in a v2 file with no choice", () => {
    const file = fresh();
    writeFileSync(file, JSON.stringify({ schemaVersion: 2, providers: [deepseekProvider()] }));
    const s = new SettingsStore(file, box);
    expect(s.credential("deepseek")).toEqual({ kind: "byok", providerId: "deepseek" });
    expect(s.view().providerCredential.deepseek).toEqual({ kind: "byok", providerId: "deepseek" });
    expect(JSON.parse(readFileSync(file, "utf-8")).schemaVersion).toBe(3);
  });

  it("keeps an explicit deepseek subscription in a v2 file", () => {
    const file = fresh();
    writeFileSync(file, JSON.stringify({ schemaVersion: 2, providers: [deepseekProvider()], credentials: { deepseek: { kind: "subscription" } } }));
    const s = new SettingsStore(file, box);
    expect(s.credential("deepseek")).toEqual({ kind: "subscription" });
  });

  it("does not rewrite a v2 file with no deepseek provider", () => {
    const file = fresh();
    writeFileSync(file, JSON.stringify({ schemaVersion: 2, providers: [] }));
    const before = readFileSync(file);
    const s = new SettingsStore(file, box);
    expect(s.credential("deepseek")).toEqual({ kind: "subscription" });
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  // T1.3 — SECRET_ENV is gone; phase 2 removed the global export, and a key reaches an agent only through its injection plan.
  it("no longer exports SECRET_ENV", () => {
    expect("SECRET_ENV" in settingsModule).toBe(false);
  });

  it("keeps a saved deepseek key resolving to its env var through providerEnv", () => {
    const file = fresh();
    writeFileSync(file, JSON.stringify({ secrets: { deepseek: box.encrypt("sk-deep-legacy") } }));
    expect(new SettingsStore(file, box).providerEnv("deepseek")).toEqual({ DEEPSEEK_API_KEY: "sk-deep-legacy" });
  });

  it("rejects a secret for an unknown provider", () => {
    expect(() => new SettingsStore(fresh(), box).setProviderSecret("nope", "x")).toThrow(/unknown provider nope/);
  });

  // T1.4 — subscription by default, except the migrated anthropic key for Claude.
  it("defaults every agent to subscription, changing only Claude's migrated key", () => {
    const freshStore = new SettingsStore(fresh(), box);
    expect(freshStore.credential("claude")).toEqual({ kind: "subscription" });
    expect(freshStore.credential("opencode")).toEqual({ kind: "subscription" });
    const migrated = new SettingsStore(legacyFixture(), box);
    expect(migrated.credential("claude")).toEqual({ kind: "byok", providerId: "anthropic" });
  });

  // T1.9 — the whole view payload is secret-free.
  it("never puts a secret or its ciphertext in the renderer view", () => {
    const file = fresh();
    const s = new SettingsStore(file, box);
    s.saveProvider(providerInput({ id: "gateway", label: "Gateway", baseURL: "https://gateway.example.com" }));
    s.setProviderSecret("gateway", "sk-view-secret");
    const json = JSON.stringify(s.view());
    expect(json).not.toContain("sk-view-secret");
    expect(json).not.toContain(box.encrypt("sk-view-secret"));
    expect(s.view().providers.every((p) => !("secret" in p))).toBe(true);
  });

  // T1.10 — duplicate-id replacement and secret preservation.
  it("replaces a provider on a duplicate id, including its wireProtocol", () => {
    const s = new SettingsStore(fresh(), box);
    const created = s.saveProvider(providerInput({ id: "gateway", label: "Gateway", baseURL: "https://g.example.com" }), "sk-one");
    expect(created.hasSecret).toBe(true);
    const updated = s.saveProvider(
      providerInput({ id: "gateway", label: "Renamed", baseURL: "https://g.example.com", wireProtocol: "anthropic-messages" }),
    );
    expect(updated.wireProtocol).toBe("anthropic-messages");
    expect(updated.label).toBe("Renamed");
    expect(updated.hasSecret).toBe(true); // ciphertext kept when no new value is given
    expect(s.providers()).toHaveLength(1);
  });

  it("refuses a command secret from the renderer", () => {
    const s = new SettingsStore(fresh(), box);
    expect(() => s.saveProvider({ ...providerInput({ id: "cmd", label: "Cmd", baseURL: "https://c.example.com" }), secret: { kind: "command", command: ["sh", "-c", "x"] } })).toThrow(/command secrets/);
    expect(s.providers()).toHaveLength(0);
  });

  it("removes a migrated provider without touching secrets.* and resets its credential", () => {
    const file = legacyFixture();
    const fixture = fixtureJson();
    const s = new SettingsStore(file, box);
    s.removeProvider("anthropic");
    expect(JSON.parse(readFileSync(file, "utf-8")).secrets).toEqual(fixture.secrets);
    expect(s.providers().map((p) => p.id)).toEqual(["openai"]);
    expect(s.credential("claude")).toEqual({ kind: "subscription" });
  });

  it("resolves an envRef secret from process.env without touching the box", () => {
    const throwing: SecretBox = { ...box, decrypt: () => { throw new Error("should not decrypt"); } };
    const s = new SettingsStore(fresh(), throwing);
    process.env.GATEWAY_TEST_KEY = "env-key";
    try {
      s.saveProvider(providerInput({ id: "gateway", label: "Gateway", baseURL: "https://g.example.com", secret: { kind: "envRef", envVar: "GATEWAY_TEST_KEY" } }));
      expect(s.providerSecret("gateway")).toBe("env-key");
    } finally {
      delete process.env.GATEWAY_TEST_KEY;
    }
  });

  it("rejects a credential pointing at an unknown provider", () => {
    const s = new SettingsStore(fresh(), box);
    expect(() => s.setCredential("claude", { kind: "byok", providerId: "ghost" })).toThrow(/unknown provider ghost/);
  });
});

describe("Service defaults for new threads", () => {
  const driver = (id: string): AgentDriver => ({
    id,
    label: id,
    defaultModel: `${id}-1`,
    capabilities: SAFE_DEFAULTS,
    skillsDelivery: { mode: "none" },
    skillCallPrefix: "",
    models: () => [{ id: `${id}-1`, label: id }],
    async runTurn() {},
  });

  it("uses the default agent and permission mode, falling back when the agent is gone", () => {
    const store = new Store(join(tempDir(), "t.db"));
    closeAfter(() => store.close());
    const project = store.addProject(tempDir());
    let agent: string | null = "b";
    const service = new Service(store, catalog(), [driver("a"), driver("b")], () => {}, () => [], () => ({ agent, permissionMode: "full" }));
    expect(service.createThread(project.id)).toMatchObject({ agent: "b", model: "b-1", permissionMode: "full" });
    agent = "uninstalled";
    expect(service.createThread(project.id)).toMatchObject({ agent: "a" });
    expect(service.createThread(project.id, "b")).toMatchObject({ agent: "b" });
  });
});
