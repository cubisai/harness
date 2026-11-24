import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHROME_THEME_TOKENS } from "../src/shared/app-themes";
import { appThemePalette, appThemeContrastErrors } from "../src/shared/app-theme-palette";
import { CHROME_THEME_BASE } from "../src/shared/chrome-theme-tokens.generated";
import { appThemeHash, parseAppTheme } from "../src/main/apps/app-theme-validation";
import { AppThemes } from "../src/main/apps/app-themes";
import { PluginBundles } from "../src/main/apps/bundles";
import { AppRegistry } from "../src/main/apps/registry";
import { Store } from "../src/main/db";
import { ExtensionStore } from "../src/main/extensions/store";
import { validateProposal } from "../src/main/extensions/manifest";
import { validateApp } from "../src/main/apps/manifest";
import { contributionViews } from "../src/main/apps/parts";
import { generateChromeThemeTokens } from "../scripts/design/design-docs.mjs";
import { checkChromeThemeTokens } from "../scripts/design/design-check.mjs";
import { serveApp } from "../src/main/apps/serve";
import { CHECK_THEME_URL, checkHostCsp } from "../src/main/apps/check";
import { appThemeCaption } from "../src/main/apps/app-theme-captions";

const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).reverse().forEach((f) => f()); });
const palette = { light: { primary: "#3f2f22" }, dark: { bg: "#080808" } };
function setup() {
  const root = mkdtempSync(join(tmpdir(), "app-theme-")), store = new Store(join(root, "app.db")), extensions = new ExtensionStore(store.sql);
  cleanup.push(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const dir = join(root, "apps"), registry = new AppRegistry({ globalDir: dir, stateFile: join(root, "on.json"), projectPath: () => null });
  let themes: AppThemes;
  const changed = vi.fn();
  const bundles = new PluginBundles({ db: store.sql, extensions, registry, dir, projectExists: () => false, authoringProject: () => null, checkAgent: () => {}, interrupt: () => {}, changed: () => { registry.forget(join(dir, "palette")); themes?.reconcile(); } });
  bundles.recover();
  const file = join(root, "app-theme-state.json");
  const make = () => new AppThemes({ file, themes: () => bundles.themes(), proposal: (id) => extensions.get(id), changed });
  themes = make(); themes.reconcile();
  const stage = (colors: unknown = palette, html = "<h1>Palette</h1>") => {
    const check = validateProposal({ kind: "app", name: "palette", files: [{ path: "app.json", content: JSON.stringify({ name: "palette", title: "Palette", description: "Local only", ...(colors !== null ? { contributes: { appTheme: colors } } : {}) }) }, { path: "index.html", content: html }] }, { scope: { kind: "global" } });
    if (!check.ok || check.proposal.draft.kind !== "app") throw new Error(check.ok ? "Wrong fixture kind" : check.errors.join(" "));
    return extensions.stage({ threadId: "thread", ...check.proposal });
  };
  const install = (proposal = stage()) => { if (proposal.draft.kind !== "app") throw new Error("Wrong kind"); bundles.install(proposal, proposal.draft, proposal.digest); return proposal; };
  const handle = () => { const { key, hash, revision } = bundles.themes()[0]!; return { key, hash, revision }; };
  return { root, file, store, extensions, bundles, registry, themes, make, stage, install, handle, changed };
}

describe("strict chrome palettes", () => {
  it("keeps macOS native chrome alone and synchronizes only Windows/Linux caption ink", () => {
    expect(appThemeCaption("darwin", "dark", palette)).toBeNull();
    expect(appThemeCaption("win32", "dark", null)).toEqual({ symbolColor: CHROME_THEME_BASE.dark.text });
    expect(appThemeCaption("linux", "light", { light: { text: "#111111" } })).toEqual({ symbolColor: "#111111" });
  });
  it("normalizes opaque colors and hashes canonically without rewriting files", () => {
    expect(parseAppTheme({ dark: { primary: "#ABC" }, light: { primary: "#321" } })).toEqual({ light: { primary: "#332211" }, dark: { primary: "#aabbcc" } });
    expect(appThemeHash({ light: { primary: "#123" } })).toBe(appThemeHash({ light: { primary: "#112233" } }));
    expect(parseAppTheme(undefined)).toBeUndefined();
  });
  it.each([null, [], {}, { light: {} }, { light: [] }, { extra: {} }, { light: { unknown: "#000" } }, { light: { "--bg": "#fff" } }, JSON.parse('{"light":{"__proto__":"#fff"}}')])("rejects malformed shape %j", (value) => expect(() => parseAppTheme(value)).toThrow());
  it.each(["transparent", "red", "#ffff", "#ffffffff", " #fff", "#fff;", "var(--text)", "url(https://fixture.invalid)", "rgb(0 0 0)", "#fff!important", "\\23 fff", "#fff\n", "<style>", 42])("rejects CSS/nonopaque value %j", (value) => expect(() => parseAppTheme({ light: { primary: value } })).toThrow());
  it.each(["signal-ink", "danger", "warning", "success", "canvas-select", "font", "radius-s", "shadow-float", "beam-inner", "zoom", "send-bg"])("protects %s", (name) => expect(() => parseAppTheme({ light: { [name]: "#000" } })).toThrow("Unknown"));
  it("refuses low contrast and preserves existing baseline limitations", () => {
    expect(() => parseAppTheme({ light: { text: "#ffffff" } })).toThrow("text on bg");
    expect(() => parseAppTheme({ dark: { focus: "#0e1013" } })).toThrow("focus on bg");
    expect(appThemeContrastErrors({ light: { "text-tertiary": CHROME_THEME_BASE.light["text-tertiary"] } })).toEqual([]);
    expect(appThemeContrastErrors(palette)).toEqual([]);
  });
  it("derives only companions of changed roles and leaves untouched defaults alone", () => {
    expect(appThemePalette(null, "dark")).toEqual({});
    expect(appThemePalette(palette, "light")).toEqual({ primary: "#3f2f22", "primary-soft": "rgb(63 47 34 / 0.07)" });
    expect(appThemePalette(palette, "dark")).toEqual({ bg: "#080808", "send-bg": "#080808" });
    expect(CHROME_THEME_TOKENS).toHaveLength(15);
  });
  it("ships a valid template and discloses it as one part", () => {
    const dir = "resources/creator/templates/app-theme", manifest = readFileSync(join(dir, "app.json"), "utf8"), name = JSON.parse(manifest).name;
    const app = validateApp(name, [{ path: "app.json", content: manifest }, { path: "index.html", content: readFileSync(join(dir, "index.html"), "utf8") }]);
    expect(app.ok).toBe(true);
    if (!app.ok) throw new Error(app.errors.join(" "));
    expect(contributionViews(name, app.manifest.contributes)).toEqual([expect.objectContaining({ kind: "app-theme", detail: expect.stringContaining("primary"), description: expect.stringContaining("Apply separately") })]);
  });
  it("checks a deterministic generated cache with CRLF support", () => {
    const css = readFileSync("src/renderer/src/styles/app.css", "utf8").replace(/\r\n?/g, "\n"), generated = readFileSync("src/shared/chrome-theme-tokens.generated.ts", "utf8").replace(/\r\n?/g, "\n");
    expect(generateChromeThemeTokens(css)).toBe(generated);
    expect(generateChromeThemeTokens(css.replace(/\n/g, "\r\n"))).toBe(generated);
    const files = [{ path: "src/renderer/src/styles/app.css", text: css }, { path: "src/shared/chrome-theme-tokens.generated.ts", text: generated }];
    expect(checkChromeThemeTokens(files, generateChromeThemeTokens)).toEqual([]);
    expect(checkChromeThemeTokens([{ ...files[0]! }, { ...files[1]!, text: generated + "tamper" }], generateChromeThemeTokens)).toEqual([expect.objectContaining({ code: "design/chrome-theme-stale", severity: "error" })]);
  });
  it("serves a fixed isolated specimen with no network or plugin scripts", async () => {
    const response = serveApp(CHECK_THEME_URL, { appRoot: () => { throw new Error("Must not read app files"); }, bridge: "<script>/* bridge only */</script>" });
    expect(response.status).toBe(200); expect(response.headers.get("Content-Security-Policy")).toContain("connect-src 'none'");
    expect(await response.text()).toContain("Isolated palette coverage"); expect(checkHostCsp()).toContain(CHECK_THEME_URL);
  });
});

describe("reviewed appearance ownership and lifecycle", () => {
  it("Install does not select/write appearance; explicit Apply persists and reopens", () => {
    const e = setup(); e.install(); expect(e.themes.state(1).selected).toBeNull(); expect(existsSync(e.file)).toBe(false);
    const h = e.handle(); e.themes.apply(1, h);
    const restarted = e.make(); restarted.reconcile(); expect(restarted.state(1).selected).toEqual({ key: h.key, hash: h.hash }); expect(restarted.state(1).active).toEqual(palette);
    expect(e.store.sql.prepare("SELECT COUNT(*) AS n FROM automation_runs").get()).toMatchObject({ n: 0 });
  });
  it("rejects unowned handles and proposal Apply, but allows user proposal Preview", () => {
    const e = setup(), p = e.stage(); expect(e.themes.preview(1, { proposalId: p.id }).preview?.theme).toEqual(palette);
    expect(existsSync(e.file)).toBe(false);
    expect(() => e.themes.apply(1, { proposalId: p.id } as never)).toThrow("Install");
    expect(() => e.themes.preview(1, { key: "g~unowned", revision: "x", hash: "x" })).toThrow("unavailable");
    e.install(p); expect(e.themes.state(1).preview).toBeNull(); expect(e.themes.state(1).selected).toBeNull();
  });
  it("preview is window-owned, replacement is single-use, Cancel changes no preferences", () => {
    const e = setup(); e.install(); const h = e.handle(); e.themes.apply(1, h);
    const first = e.themes.preview(1, h).preview!, other = e.themes.preview(2, h).preview!;
    const second = e.themes.preview(1, h).preview!;
    expect(first.token).not.toBe(second.token); expect(e.themes.state(2).preview?.token).toBe(other.token);
    expect(() => e.themes.cancel(1, first.token)).toThrow("superseded");
    expect(() => e.themes.apply(1, h, first.token)).toThrow("superseded");
    e.themes.cancel(1, second.token); expect(e.themes.state(1).active).toEqual(palette);
    e.themes.closeWindow(2); expect(e.themes.state(2).preview).toBeNull();
    expect(e.themes.state(1).selected?.key).toBe(h.key);
  });
  it("Off clears selection/preview and On never reapplies; old revision refuses", () => {
    const e = setup(); e.install(); const h = e.handle(); e.themes.apply(1, h); e.themes.preview(1, h);
    e.bundles.setEnabled(h.key, false); expect(e.themes.state(1)).toMatchObject({ selected: null, preview: null, active: null });
    expect(e.bundles.themes()[0]).toMatchObject({ enabled: false, error: expect.stringContaining("Off") });
    e.bundles.setEnabled(h.key, true); expect(e.themes.state(1).selected).toBeNull(); expect(() => e.themes.apply(1, h)).toThrow("changed");
  });
  it("unchanged theme Update keeps selection, changed/removed content resets after commit", () => {
    const e = setup(); e.install(); const h = e.handle(); e.themes.apply(1, h);
    e.install(e.stage(palette, "<h1>Updated page</h1>")); expect(e.themes.state(1).selected?.hash).toBe(h.hash);
    e.install(e.stage({ light: { primary: "#222222" } })); expect(e.themes.state(1).selected).toBeNull();
    e.themes.apply(1, e.handle()); e.install(e.stage(null)); expect(e.themes.state(1).selected).toBeNull(); expect(e.bundles.themes()).toEqual([]);
  });
  it("Uninstall clears only appearance and leaves no bundle journal", () => {
    const e = setup(); e.install(); e.themes.apply(1, e.handle());
    e.bundles.uninstall(e.extensions.installs()[0]!); expect(e.themes.state(1)).toMatchObject({ selected: null, active: null, themes: [] });
    expect(e.store.sql.prepare("SELECT * FROM plugin_bundle_ops").all()).toEqual([]);
  });
  it("invalid Update leaves the current valid selection untouched", () => {
    const e = setup(); e.install(); e.themes.apply(1, e.handle());
    expect(() => e.stage({ light: { text: "#ffffff" } })).toThrow("contrast"); expect(e.themes.state(1).active).toEqual(palette);
  });
  it("modified owner files fail closed and invalidate selected/preview content", () => {
    const e = setup(); e.install(); const h = e.handle(); e.themes.apply(1, h); e.themes.preview(1, h);
    writeFileSync(join(e.root, "apps", "palette", "index.html"), "Hand edited"); e.themes.reconcile();
    expect(e.themes.state(1)).toMatchObject({ selected: null, active: null, preview: null, error: expect.stringContaining("unavailable") });
    expect(() => e.themes.apply(1, h)).toThrow("unavailable");
  });
  it("corrupt preferences stay preserved and reset cannot hide a save failure", () => {
    const e = setup(); writeFileSync(e.file, "corrupt"); const restarted = e.make(); restarted.reconcile();
    expect(restarted.state(1)).toMatchObject({ selected: null, error: expect.stringContaining("file was kept") }); expect(readFileSync(e.file, "utf8")).toBe("corrupt");
  });
  it("rejects extra fields/raw palette payloads and cancels rejected proposal previews", () => {
    const e = setup(), p = e.stage();
    expect(() => e.themes.preview(1, { proposalId: p.id, colors: palette } as never)).toThrow("proposal");
    e.themes.preview(1, { proposalId: p.id }); e.extensions.setStatus(p.id, "rejected"); e.themes.reconcile(); expect(e.themes.state(1).preview).toBeNull();
  });
  it("a preference save failure cannot silently change the committed selection", () => {
    const e = setup(); e.install(); e.themes.apply(1, e.handle());
    rmSync(e.file); mkdirSync(e.file);
    expect(() => e.themes.revert(1)).toThrow(); expect(e.themes.state(1).active).toEqual(palette);
  });
  it("catalog/notification failures do not strand Revert or undo a saved Apply", () => {
    const e = setup(); e.install();
    const c = new AppThemes({ file: e.file, themes: () => e.bundles.themes(), proposal: (id) => e.extensions.get(id), changed: () => { throw new Error("Notice failed"); } });
    expect(() => c.apply(1, e.handle())).not.toThrow(); expect(c.state(1).active).toEqual(palette);
    const broken = new AppThemes({ file: e.file, themes: () => { throw new Error("Catalog failed"); }, proposal: () => null, changed: () => {} });
    broken.reconcile(); expect(broken.revert(1)).toMatchObject({ selected: null, active: null, themes: [] });
  });
});
