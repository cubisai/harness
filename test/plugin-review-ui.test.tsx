import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PluginOwnerNote, PluginParts } from "../src/renderer/src/components/PluginParts";
import { contributionViews } from "../src/main/apps/parts";
import { validateApp } from "../src/main/apps/manifest";
import { APP_TEMPLATES } from "../src/main/creator/app-tools";

describe("plugin part review", () => {
  it("labels an unavailable owned row and offers plugin management, not independent removal", () => {
    const html = renderToStaticMarkup(<PluginOwnerNote owner={{ key: "g~notes", title: "Notes", enabled: false }} onManage={() => {}} />);
    expect(html).toContain("Managed by Notes"); expect(html).toContain("Off or unavailable"); expect(html).toContain("Manage plugin");
    expect(html).not.toContain(">Uninstall<");
  });
  it("has compact disclosures for exact rules, credentials/stdio risk, scopes and Update changes", () => {
    const html = renderToStaticMarkup(<PluginParts parts={[
      { kind: "command", name: "/notes.review", description: "Review", detail: "Do not edit", change: "added" },
      { kind: "rule", name: "shop.summary", description: "Always ask", detail: "Confirm this exact tool", change: "changed" },
      { kind: "connector", name: "p-notes-shop", description: "node fixture.mjs", detail: "Required variables: ${KEY}", risk: true, change: "removed" },
      { kind: "automation", name: "daily-review", description: "Daily · Off/Ask", projectId: "project-one" },
    ]} />);
    expect(html).toContain("Bundled parts"); expect(html).toContain("<details"); expect(html).toContain("<summary");
    expect(html).toContain("New"); expect(html).toContain("Changed"); expect(html).toContain("Removed");
    expect(html).toContain("${KEY}"); expect(html).toContain("Runs a local program"); expect(html).toContain("project-one");
    expect(html).toContain("Installing starts no connector, sign-in or automation run");
    expect(html).not.toContain("<button");
    expect(renderToStaticMarkup(<PluginParts />)).toBe("");
  });
  it("reviews connector headers/OAuth and full automation settings, not just their targets", () => {
    const spec = { type: "http" as const, url: "https://fixture.invalid/mcp", headers: { Authorization: "Bearer ${KEY}" }, oauth: { scopes: "read:notes" } };
    const views = contributionViews("notes", { connectors: [{ name: "shop", spec }] });
    expect(views[0]?.detail).toContain("read:notes"); expect(views[0]?.detail).toContain("Authorization"); expect(views[0]?.detail).toContain("${KEY}");
  });
  it("ships a valid bundle template without connectors, schedules or automatic side effects", () => {
    expect(APP_TEMPLATES).toContain("bundle");
    const files = ["app.json", "index.html", "skills/review/SKILL.md"].map((path) => ({ path, content: readFileSync(`resources/creator/templates/bundle/${path}`, "utf8") }));
    const r = validateApp("bundle", files);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.errors.join(" "));
    expect(r.manifest.contributes?.commands).toHaveLength(1); expect(r.manifest.contributes?.skills).toHaveLength(1);
    expect(r.manifest.contributes?.connectors).toBeUndefined(); expect(r.manifest.contributes?.automations).toBeUndefined();
  });
});
