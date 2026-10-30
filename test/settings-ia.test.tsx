import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FORMER_SECTIONS, SETTINGS_GROUPS, SettingsGroupContent, richRepliesOf, richRepliesPatch } from "../src/renderer/src/components/SettingsSheet";
import { SPLASH_IDS, type SettingsView } from "../src/shared/types";
import { SPLASHES } from "../src/renderer/src/components/Splash";
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
  it("has the seven groups in order", () => {
    expect(SETTINGS_GROUPS.map((g) => g.label)).toEqual(["Appearance", "Threads", "Agents & Providers", "Skills & MCP", "Data & Security", "Updates", "Experiments"]);
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
    const controls = ["Theme", "Motion", "Density", "Splash screen", "Agent", "Permissions", "Open files in", "Installed", "Skills", "MCP tool search", "Keys", "Data folder", "Version", "Auto-update", "Code mode"];
    for (const label of controls) {
      const where = groupIds.filter((id) => html[id]!.includes(`class="label"`) && new RegExp(`class="label"[^>]*>${label}<`).test(html[id]!));
      expect(where, label).toHaveLength(1);
    }
    expect(html.skills).toContain("Open MCP Servers");
  });

  it("has an Issues section in Threads whose File issue? cards switch reads On when unset", () => {
    expect(SETTINGS_GROUPS.find((g) => g.id === "threads")?.sections).toContain("Issues");
    expect(html.threads).toContain("File issue? cards");
    const off = renderToStaticMarkup(<SettingsGroupContent group="threads" settings={{ ...settings, issueOffers: false }} />);
    expect(html.threads).toMatch(/<button class="on">On<\/button><button class="">Off<\/button>/);
    expect(off).toMatch(/<button class="">On<\/button><button class="on">Off<\/button>/);
  });

  it("keeps Code mode in Experiments, with Read-only + MCP marked Recommended", () => {
    expect(SETTINGS_GROUPS.find((g) => g.id === "experiments")?.sections).toEqual(["Code mode"]);
    expect(html.experiments).not.toContain("Browser tools");
    expect(html.agents).not.toContain("Code mode");
    expect(html.experiments).toContain(">Read-only + MCP (Recommended)<");
    expect(html.experiments).toMatch(/class="on"[^>]*>Off</);
  });

  it("picks the splash clip from a list, with the agent clip shown when unset", () => {
    expect(html.appearance).toContain('aria-label="Splash screen"');
    expect(html.appearance).toContain(">CubiQ agent<");
    expect(html.appearance).toContain(">Preview<");
    expect(SPLASHES.map((o) => o.id)).toEqual([...SPLASH_IDS]);
  });
});

describe("Rich replies", () => {
  it("is one row with three stops in place of Interactive answers and Load link previews", () => {
    const all = Object.values(html).join("");
    expect(all).toContain(">Rich replies<");
    expect(all).toContain(">On + link previews<");
    expect(all).not.toContain(">Interactive answers<");
    expect(all).not.toContain(">Load link previews<");
  });

  it("maps each stop to the two settings and back", () => {
    for (const stop of ["off", "on", "links"] as const) expect(richRepliesOf(richRepliesPatch(stop))).toBe(stop);
    expect(richRepliesPatch("off")).toEqual({ uiBlocks: false, linkPreviews: false });
    expect(richRepliesPatch("on")).toEqual({ uiBlocks: true, linkPreviews: false });
    expect(richRepliesPatch("links")).toEqual({ uiBlocks: true, linkPreviews: true });
    expect(richRepliesOf({})).toBe("off");
    // Previews on with blocks off (set before the merge) shows as the fullest stop.
    expect(richRepliesOf({ uiBlocks: false, linkPreviews: true })).toBe("links");
  });
});
