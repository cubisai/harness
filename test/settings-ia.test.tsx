import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FORMER_SECTIONS, SETTINGS_GROUPS, SettingsGroupContent } from "../src/renderer/src/components/SettingsSheet";
import type { SettingsView } from "../src/shared/types";
import { DEFAULT_LAYOUT } from "../src/shared/layout";

const settings: SettingsView = {
  theme: "system",
  motion: "instant",
  density: "comfortable",
  defaultAgent: null,
  defaultPermissionMode: "ask",
  autoUpdate: true,
  editor: null,
  paneLayout: DEFAULT_LAYOUT,
  providers: [],
  providerCredential: {},
  migratedProviders: [],
  secretsEncrypted: true,
} as SettingsView;

const groupIds = SETTINGS_GROUPS.map((g) => g.id);
const html = Object.fromEntries(groupIds.map((id) => [id, renderToStaticMarkup(<SettingsGroupContent group={id} settings={settings} />)]));

describe("Settings IA", () => {
  it("has the six groups in order", () => {
    expect(SETTINGS_GROUPS.map((g) => g.label)).toEqual(["Appearance", "Threads", "Agents & Providers", "Skills & MCP", "Data & Security", "Updates"]);
  });

  it("maps every former section heading to exactly one group", () => {
    const former = ["Appearance", "New threads", "Editor", "Providers", "Updates", "Skills and agents"];
    expect(Object.keys(FORMER_SECTIONS).sort()).toEqual([...former].sort());
    for (const heading of former) expect(groupIds).toContain(FORMER_SECTIONS[heading]);
  });

  it("gives every section one group", () => {
    const sections = SETTINGS_GROUPS.flatMap((g) => [...g.sections]);
    expect(new Set(sections).size).toBe(sections.length);
    expect(SETTINGS_GROUPS.find((g) => g.id === "agents")?.sections).toContain("Providers");
  });

  it("puts each control in exactly one group", () => {
    // Providers render only with the store's settings; their group is pinned above.
    const controls = ["Theme", "Motion", "Density", "Splash screen", "Agent", "Permissions", "Open files in", "Installed", "Skills", "MCP tool search", "Keys", "Data folder", "Version", "Auto-update"];
    for (const label of controls) {
      const where = groupIds.filter((id) => html[id]!.includes(`class="label"`) && new RegExp(`class="label"[^>]*>${label}<`).test(html[id]!));
      expect(where, label).toHaveLength(1);
    }
    expect(html.skills).toContain("Open MCP Servers");
  });

  it("offers both splash clips and Off, with the agent clip on when unset", () => {
    expect(html.appearance).toMatch(/class="on"[^>]*>CubiQ agent</);
    expect(html.appearance).toContain(">Night voyage<");
    expect(html.appearance).toContain(">Preview<");
  });
});
