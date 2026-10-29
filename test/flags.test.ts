// T9.3: the release flags are the ones that already exist — the Antigravity
// opt-in — not a second flag system. Everything that needs a terms
// acknowledgement starts off; flipping one flag moves only its own driver.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ACP_PRESETS, loadAcpAgents, OPT_IN_AGENT_IDS } from "../src/main/agents/registry";
import { SettingsStore, type SecretBox } from "../src/main/settings";
import { ANTIGRAVITY_ACK_VERSION } from "../src/shared/provider-rules";
import { tempDir } from "./helpers";

const box: SecretBox = { available: false, encrypt: (s) => s, decrypt: (s) => s };
const fresh = () => new SettingsStore(join(tempDir(), "settings.json"), box);
const optInIds = [...new Set([...OPT_IN_AGENT_IDS, ...ACP_PRESETS.filter((p) => p.optIn).map((p) => p.id)])];

describe("release flags", () => {
  it("starts with the Antigravity opt-in off", () => {
    const s = fresh().get();
    expect(s.antigravity).toBe(false);
    expect(s.antigravityAck).toBeNull();
  });

  it("gates exactly one agent behind the opt-in: Antigravity, whose ACP server uses its own Google sign-in", () => {
    expect(optInIds).toEqual(["antigravity"]);
  });
});

describe("Antigravity opt-in", () => {
  const all = () => true;

  it("leaves Antigravity out of the agents with a fresh settings file", () => {
    const file = join(tempDir(), "agents.json");
    const store = fresh();
    const { agents } = loadAcpAgents(file, all, { optedIn: store.antigravityEnabled() });
    expect(agents.map((a) => a.id)).not.toContain("antigravity");
    expect(agents.map((a) => a.id)).toContain("opencode");
  });

  it("keeps an agents.json entry that replaces the gated preset out too", () => {
    const file = join(tempDir(), "agents.json");
    writeFileSync(file, JSON.stringify({ agents: [{ id: "antigravity", label: "Mine", command: "agy_acp_server.par", args: [] }] }));
    expect(loadAcpAgents(file, all).agents.map((a) => a.id)).not.toContain("antigravity");
    // Opted in, the preset owns the id; an agents.json entry never becomes it.
    expect(loadAcpAgents(file, all, { optedIn: true }).agents.map((a) => a.id)).not.toContain("antigravity");
  });

  it("won't turn on without the acknowledgement", () => {
    const store = fresh();
    store.update({ antigravity: true });
    expect(store.get().antigravity).toBe(false);
    expect(store.antigravityEnabled()).toBe(false);
  });

  it("turns on with an acknowledgement it stamps itself, and keeps it across a restart", () => {
    const file = join(tempDir(), "settings.json");
    const before = Date.now();
    new SettingsStore(file, box).update({ antigravityAck: { version: ANTIGRAVITY_ACK_VERSION, at: 0 }, antigravity: true });
    const reopened = new SettingsStore(file, box);
    expect(reopened.antigravityEnabled()).toBe(true);
    expect(reopened.get().antigravityAck!.at).toBeGreaterThanOrEqual(before);
    // index.ts passes this to loadAcpAgents, which offers the preset once opted in.
    const { agents } = loadAcpAgents(join(tempDir(), "agents.json"), all, { optedIn: reopened.antigravityEnabled() });
    expect(agents.map((a) => a.id)).toContain("antigravity");
  });

  it("ignores an acknowledgement of another disclosure version", () => {
    const store = fresh();
    store.update({ antigravityAck: { version: ANTIGRAVITY_ACK_VERSION + 1, at: 1 }, antigravity: true });
    expect(store.antigravityEnabled()).toBe(false);
  });

  it("turns off, and stays off when the acknowledgement is withdrawn", () => {
    const store = fresh();
    store.update({ antigravityAck: { version: ANTIGRAVITY_ACK_VERSION, at: 0 }, antigravity: true });
    store.update({ antigravity: false });
    expect(store.antigravityEnabled()).toBe(false);
    store.update({ antigravity: true, antigravityAck: null });
    expect(store.antigravityEnabled()).toBe(false);
  });
});
