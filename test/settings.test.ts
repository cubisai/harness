import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Store } from "../src/main/db";
import { Service } from "../src/main/service";
import { SettingsStore, type SecretBox } from "../src/main/settings";
import type { AgentDriver } from "../src/main/agents/types";
import { catalog, closeAfter, tempDir } from "./helpers";

/** Reversible, and visibly not plaintext, so the tests can tell a stored key was encoded. */
const box: SecretBox = {
  available: true,
  encrypt: (s) => Buffer.from([...s].reverse().join("")).toString("base64"),
  decrypt: (b) => [...Buffer.from(b, "base64").toString()].reverse().join(""),
};

const fresh = () => join(tempDir(), "settings.json");

describe("SettingsStore", () => {
  it("starts from defaults and persists updates", () => {
    const file = fresh();
    const s = new SettingsStore(file, box);
    expect(s.get()).toEqual({ theme: "system", defaultAgent: null, defaultPermissionMode: "ask", autoUpdate: true, editor: null });
    s.update({ theme: "dark", defaultAgent: "codex", defaultPermissionMode: "auto-edit", autoUpdate: false, editor: "zed" });
    expect(new SettingsStore(file, box).get()).toEqual({ theme: "dark", defaultAgent: "codex", defaultPermissionMode: "auto-edit", autoUpdate: false, editor: "zed" });
  });

  it("ignores invalid values", () => {
    const s = new SettingsStore(fresh(), box);
    s.update({ theme: "neon" as never, defaultPermissionMode: "yolo" as never });
    expect(s.get()).toMatchObject({ theme: "system", defaultPermissionMode: "ask" });
  });

  it("stores keys encrypted and reports only whether they are set", () => {
    const file = fresh();
    const s = new SettingsStore(file, box);
    s.setSecret("deepseek", "  sk-secret  ");
    expect(readFileSync(file, "utf-8")).not.toContain("sk-secret");
    expect(s.view().secretsSet).toEqual({ anthropic: false, deepseek: true, openai: false });
    expect(JSON.stringify(s.view())).not.toContain("sk-secret");
    expect(new SettingsStore(file, box).env()).toEqual({ DEEPSEEK_API_KEY: "sk-secret" });
    s.setSecret("deepseek", null);
    expect(s.env()).toEqual({});
  });

  it("skips a key it can't decrypt and survives a corrupt file", () => {
    const file = fresh();
    new SettingsStore(file, box).setSecret("openai", "sk-x");
    const broken: SecretBox = { ...box, decrypt: () => { throw new Error("other machine"); } };
    expect(new SettingsStore(file, broken).env()).toEqual({});
    writeFileSync(file, "{not json");
    expect(new SettingsStore(file, box).get().theme).toBe("system");
  });
});

describe("Service defaults for new threads", () => {
  const driver = (id: string): AgentDriver => ({
    id,
    label: id,
    defaultModel: `${id}-1`,
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
