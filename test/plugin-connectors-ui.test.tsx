import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { PluginConnectorsSection } from "../src/renderer/src/components/PluginConnectorsSection";
import type { PluginConnectorView } from "../src/shared/plugin-parts";

function view(patch: Partial<PluginConnectorView> = {}): PluginConnectorView {
  return { key: "g~notes", name: "shop", revision: "one", runtimeName: "p-notes-shop", owner: { key: "g~notes", title: "Notes", enabled: true, revision: "one" },
    type: "http", target: "https://fixture.invalid/mcp", variables: [{ name: "KEY", saved: true, missing: false }], locked: false,
    hasClientSecret: false, canSignIn: true, canSetClientSecret: false, signingIn: false, status: { name: "p-notes-shop", state: "checking", tools: [] }, ...patch };
}
describe("bundled Connector Library rows", () => {
  it("uses readable ink for owned action errors without changing standalone connector styles", () => {
    const css = readFileSync("src/renderer/src/styles/mcp.css", "utf8");
    expect(css).toMatch(/\.plugin-connectors \.mcp-error\s*\{\s*color:\s*var\(--text\);\s*\}/);
    expect(css).toMatch(/^\.mcp-error\s*\{\s*color:\s*var\(--danger\);/m);
  });
  it("labels ownership/scope and only offers explicit Check/Sign in and value settings", () => {
    const reload = vi.fn(), html = renderToStaticMarkup(<PluginConnectorsSection connectors={[view()]} onReload={reload} />);
    expect(html).toContain("Plugin · Notes · All projects"); expect(html).toContain("Not checked");
    expect(html).toContain("KEY: saved"); expect(html).toContain("Credentials…"); expect(html).toContain("Sign in");
    expect(html).not.toContain("Remove"); expect(html).not.toContain("Uninstall"); expect(reload).not.toHaveBeenCalled();
  });
  it("unavailable owners disable actions and a pending sign-in has a reachable Cancel", () => {
    const off = view({ owner: { key: "g~notes", title: "Notes", enabled: false } });
    const html = renderToStaticMarkup(<PluginConnectorsSection connectors={[off]} onReload={() => {}} />);
    expect(html).toContain("Owner Off or unavailable"); expect(html.match(/disabled=""/g)?.length).toBe(3);
    const pending = renderToStaticMarkup(<PluginConnectorsSection connectors={[view({ signingIn: true })]} onReload={() => {}} />);
    expect(pending).toContain("Cancel sign-in"); expect(pending).toContain('role="status"');
    expect(renderToStaticMarkup(<PluginConnectorsSection connectors={[]} onReload={() => {}} />)).toBe("");
  });
});
