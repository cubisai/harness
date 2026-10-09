// T9.6: the settings.json release gate. The v1 → v2 migration itself is
// Phase 1's (test/settings.test.ts); this pins what a release needs on top:
// the legacy fixture still migrates losslessly, a corrupt file is kept before
// it's reset, an export round-trips, and a downgrade still finds secrets.*.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SettingsStore, type SecretBox } from "../src/main/settings";
import { ANTIGRAVITY_ACK_VERSION } from "../src/shared/provider-rules";
import { fixturesDir, tempDir } from "./helpers";

/** Reversible, and visibly not plaintext. */
const box: SecretBox = {
  available: true,
  encrypt: (s) => Buffer.from([...s].reverse().join("")).toString("base64"),
  decrypt: (b) => [...Buffer.from(b, "base64").toString()].reverse().join(""),
};
const legacy = () => JSON.parse(readFileSync(join(fixturesDir, "legacy-settings.json"), "utf-8"));

function legacyCopy(): string {
  const file = join(tempDir(), "settings.json");
  writeFileSync(file, readFileSync(join(fixturesDir, "legacy-settings.json"), "utf-8"));
  return file;
}

describe("settings.json release gate", () => {
  it("migrates the legacy fixture to schemaVersion 2 with secrets.* intact and the keys still readable", () => {
    const file = legacyCopy();
    const s = new SettingsStore(file, box);
    const disk = JSON.parse(readFileSync(file, "utf-8"));
    expect(disk.schemaVersion).toBe(2);
    expect(disk.secrets).toEqual(legacy().secrets);
    expect(s.get().theme).toBe("dark");
    expect(s.providerSecret("anthropic")).toBe(box.decrypt(legacy().secrets.anthropic));
  });

  it("keeps a copy of a corrupt file before starting from defaults", () => {
    const dir = tempDir();
    const file = join(dir, "settings.json");
    writeFileSync(file, '{"secrets": {"anthropic": "abc"');
    const s = new SettingsStore(file, box);
    expect(s.get().theme).toBe("system");
    const copies = readdirSync(dir).filter((n) => n.startsWith("settings.json.corrupt-"));
    expect(copies).toHaveLength(1);
    expect(readFileSync(join(dir, copies[0]!), "utf-8")).toBe('{"secrets": {"anthropic": "abc"');
  });

  it("round-trips providers, credential choices and preferences through export → wipe → import", () => {
    const a = new SettingsStore(join(tempDir(), "settings.json"), box);
    a.saveProvider({ id: "gw", label: "Gateway", wireProtocol: "openai-responses", baseURL: "https://gw.example.com/v1", models: [] }, "gw-secret-1");
    a.setCredential("codex", { kind: "byok", providerId: "gw" });
    a.update({ theme: "dark", density: "compact", antigravityAck: { version: ANTIGRAVITY_ACK_VERSION, at: 0 }, antigravity: true });
    const exported = JSON.parse(JSON.stringify(a.exportData()));
    expect(JSON.stringify(exported)).not.toContain("gw-secret-1");
    expect(exported.settings.antigravity).toBeUndefined();

    const b = new SettingsStore(join(tempDir(), "settings.json"), box);
    const view = b.importData(exported);
    expect(view.providers.map((p) => p.id)).toEqual(["gw"]);
    expect(b.view().providerCredential.codex).toEqual({ kind: "byok", providerId: "gw" });
    expect(b.providerSecret("gw")).toBe("gw-secret-1"); // same machine: the ciphertext still opens
    expect(b.get().theme).toBe("dark");
    expect(b.get().density).toBe("compact");
    // The opt-in is per install: an import never turns it on.
    expect(b.antigravityEnabled()).toBe(false);
  });

  it("drops a choice whose provider the export lacks, and rejects a file that isn't an export", () => {
    const s = new SettingsStore(join(tempDir(), "settings.json"), box);
    s.importData({ kind: "unskilled-settings", version: 1, exportedAt: 0, settings: {}, providers: [], credentials: { claude: { kind: "byok", providerId: "gone" } } });
    expect(s.credential("claude")).toEqual({ kind: "subscription" });
    expect(() => s.importData({ theme: "dark" })).toThrow(/Not a CubiQ settings export/);
  });

  it("leaves secrets.* for an older build after an import (downgrade)", () => {
    const file = legacyCopy();
    const s = new SettingsStore(file, box);
    s.importData({ kind: "unskilled-settings", version: 1, exportedAt: 0, settings: {}, providers: [], credentials: {} });
    expect(JSON.parse(readFileSync(file, "utf-8")).secrets).toEqual(legacy().secrets);
  });
});
