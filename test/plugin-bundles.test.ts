import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../src/main/db";
import { PluginBundles, type BundleDeps } from "../src/main/apps/bundles";
import { AppRegistry } from "../src/main/apps/registry";
import { ExtensionStore } from "../src/main/extensions/store";
import { validateProposal, type AppDraft } from "../src/main/extensions/manifest";
import { AutomationStore } from "../src/main/automations/store";
import { skillTool } from "../src/main/skills/tool";
import { SkillCatalogs } from "../src/main/skills/sources";
import { ExtensionService } from "../src/main/extensions/install";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
function setup(cleanupConnectorCredentials?: BundleDeps["cleanupConnectorCredentials"]) {
  const root = mkdtempSync(join(tmpdir(), "plugin-bundle-"));
  const store = new Store(join(root, "app.db")), extensions = new ExtensionStore(store.sql);
  cleanups.push(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const dir = join(root, "apps"), registry = new AppRegistry({ globalDir: dir, stateFile: join(root, "state.json"), projectPath: () => null });
  const changed = vi.fn(), interrupt = vi.fn();
  const bundles = new PluginBundles({ db: store.sql, extensions, registry, dir, projectExists: (id) => id === "project", authoringProject: () => "project", checkAgent: () => {}, changed, interrupt, cleanupConnectorCredentials });
  bundles.recover();
  const draft = (prompt = "Review.", automations = false, skills = false, connectors = false): AppDraft => {
    const check = validateProposal({ kind: "app", name: "reviewer", ...(automations ? { bundleProjectId: "project" } : {}), files: [
      { path: "app.json", content: JSON.stringify({ name: "reviewer", title: "Reviewer", description: "Review", contributes: { commands: [{ name: "review", description: "Review", prompt }], ...(skills ? { skills: [{ name: "review", description: "Review", path: "skills/review" }] } : {}), ...(connectors ? { connectors: [{ name: "shop", spec: { type: "http", url: "https://fixture.invalid/mcp", headers: { Authorization: "Bearer ${TOKEN}" } } }] } : {}), ...(automations ? { automations: [{ name: "review", config: { title: "Review", prompt, agent: "codex", model: null, schedule: { kind: "interval", everyMinutes: 60 } } }] } : {}) } }) },
      { path: "index.html", content: "<h1>Review</h1>" },
      ...(skills ? [{ path: "skills/review/SKILL.md", content: `---\nname: review\ndescription: Review\nuser-invocable: false\nargument-hint: "[file]"\n---\n${prompt}\n` }] : []),
    ] }, { scope: { kind: "global" } });
    if (!check.ok || check.proposal.draft.kind !== "app") throw new Error("invalid fixture");
    return check.proposal.draft;
  };
  const install = (d = draft()) => {
    const check = validateProposal(d, { scope: { kind: "global" } }); if (!check.ok) throw new Error("invalid fixture");
    const proposal = extensions.stage({ threadId: "thread", scope: check.proposal.scope, draft: check.proposal.draft, digest: check.proposal.digest });
    bundles.install(proposal, d, proposal.digest);
    return extensions.installs()[0]!;
  };
  return { root, store, extensions, dir, registry, bundles, draft, install, changed, interrupt };
}
describe("reviewed plugin bundle ownership", () => {
  it("requires reviewed ownership even when an app is enabled", () => {
    expect(setup().bundles.available("g~unowned")).toBe(false);
  });
  it("pins connector snapshots and keeps credentials on Off; cleanup belongs to committed Update/Uninstall", () => {
    const cleanup = vi.fn(), e = setup(cleanup), installed = e.install(e.draft("Review.", false, false, true));
    const part = e.bundles.connectors()[0]!;
    expect(() => e.bundles.assertConnector(part)).not.toThrow();
    expect(cleanup).toHaveBeenLastCalledWith("g~reviewer", [expect.objectContaining({ name: "shop" })]);
    cleanup.mockClear(); e.bundles.setEnabled("g~reviewer", false);
    expect(e.bundles.connectors()).toEqual([]); expect(e.bundles.connectors(true)[0]?.owner.enabled).toBe(false);
    expect(cleanup).not.toHaveBeenCalled(); expect(() => e.bundles.assertConnector(part)).toThrow("Off");
    e.bundles.setEnabled("g~reviewer", true); expect(() => e.bundles.assertConnector(part)).toThrow("changed");
    expect(() => e.bundles.assertConnector({ ...e.bundles.connectors()[0]!, spec: { type: "stdio", command: "unreviewed" } })).toThrow("changed");
    e.bundles.uninstall(installed); expect(cleanup).toHaveBeenLastCalledWith("g~reviewer", []);
  });
  it("retains and retries a committed credential-cleanup failure without resurrecting an uninstalled bundle", () => {
    const cleanup = vi.fn(), e = setup(cleanup), installed = e.install(e.draft("Review.", false, false, true));
    cleanup.mockImplementationOnce(() => { throw new Error("vault write failed"); });
    e.bundles.uninstall(installed);
    expect(e.extensions.installs()).toEqual([]); expect(e.bundles.owns("g~reviewer")).toBe(false);
    expect(e.store.sql.prepare("SELECT error FROM plugin_bundle_ops").get()).toMatchObject({ error: "vault write failed" });
    e.bundles.recover(); expect(cleanup).toHaveBeenLastCalledWith("g~reviewer", []);
    expect(e.store.sql.prepare("SELECT * FROM plugin_bundle_ops").all()).toEqual([]);
  });
  it("the disabled installer cannot strip ownership by a contribution-free Update or standalone Uninstall", async () => {
    const e = setup(), installed = e.install(e.draft("Review.", true, false, true));
    const service = new ExtensionService({
      extensions: e.extensions, bundleOwned: (key) => e.bundles.owns(key),
      projectOf: () => null, allProjects: () => [], threadProjectId: () => null, chatsRoot: null,
      skillDirs: () => ({ projectCubiq: "", harness: "" }), bundledSkillNames: () => [], invalidateSkills: () => {},
      listMcpNames: () => [], saveMcp: async () => {}, removeMcp: async () => {}, mcpFile: () => "", emitNotice: () => {}, appsDir: () => e.dir,
    });
    const check = validateProposal({ kind: "app", name: "reviewer", files: [
      { path: "app.json", content: '{"name":"reviewer","title":"Replacement","description":"No contributions"}' },
      { path: "index.html", content: "<h1>Replacement</h1>" },
    ] }, { scope: { kind: "global" } });
    if (!check.ok) throw new Error("Invalid replacement fixture");
    const proposal = e.extensions.stage({ threadId: "thread", ...check.proposal });
    expect(await service.install(proposal.id)).toMatchObject({ status: "failed", error: expect.stringContaining("not supported") });
    await expect(service.uninstall(installed.id)).rejects.toThrow("owned parts were kept");
    expect(e.extensions.installs()).toHaveLength(1); expect(e.bundles.owns("g~reviewer")).toBe(true);
    expect(new AutomationStore(e.store.sql).list()).toHaveLength(1); expect(e.bundles.connectors()).toHaveLength(1);
    expect(readFileSync(join(e.dir, "reviewer", "index.html"), "utf8")).toBe("<h1>Review</h1>");
  });
  it("recovers ownership but gates every delivery while a build's permission/review seams are incomplete", () => {
    const e = setup(); e.install(e.draft("Review.", true, true));
    const guarded = new PluginBundles({ db: e.store.sql, extensions: e.extensions, registry: e.registry, dir: e.dir, projectExists: () => true, authoringProject: () => "project", checkAgent: () => {}, changed: e.changed, interrupt: e.interrupt, deliveryReady: () => false });
    guarded.recover();
    expect(guarded.owns("g~reviewer")).toBe(true);
    expect(guarded.commands()).toEqual([]); expect(guarded.skills()).toEqual([]); expect(guarded.connectors()).toEqual([]);
    expect(guarded.skills(true)[0]?.owner?.enabled).toBe(false);
    const id = new AutomationStore(e.store.sql).list()[0]!.id;
    expect(guarded.automationOwner(id)?.enabled).toBe(false);
    expect(guarded.automationAllowed(id)).toBe(false);
    expect(guarded.rules({ kind: "tool", name: "skill" }, true)).toBeNull();
    const registry = new AppRegistry({ globalDir: e.dir, projectPath: () => null, installedError: (key) => guarded.runtimeError(key), installedParts: (key) => guarded.parts(key) });
    expect(registry.info("g~reviewer")).toMatchObject({ error: expect.stringContaining("permission and review"), parts: expect.arrayContaining([expect.objectContaining({ kind: "command" })]) });
    expect(registry.root("g~reviewer")).toBeNull(); expect(registry.manifest("g~reviewer")).toBeNull();
  });
  it("delivers owner-labelled skill flags, revokes snapshot loads and preserves standalone precedence", async () => {
    const e = setup(); e.install(e.draft("Frozen instructions.", false, true));
    const entry = e.bundles.skills()[0]!;
    expect(entry).toMatchObject({ origin: "plugin", userInvocable: false, argumentHint: "[file]", owner: { key: "g~reviewer", enabled: true } });
    const source = new SkillCatalogs({ legacyRoot: null, bundledDir: join(e.root, "bundled"), harnessDir: join(e.root, "skills"), disabled: () => [], pluginSkills: () => e.bundles.skills(true) });
    expect(source.global().modelSkills[0]?.name).toBe(entry.name);
    const tool = skillTool(() => e.bundles.skills(), (s) => e.bundles.assertSkill(s));
    expect((await tool.run({ name: entry.name })).text).toContain("Frozen instructions.");
    e.bundles.setEnabled("g~reviewer", false);
    expect(e.bundles.skills(true)[0]).toMatchObject({ userInvocable: false, argumentHint: "[file]", owner: { enabled: false } });
    expect(source.global().skills).toEqual([]);
    expect(source.global().all[0]?.owner?.enabled).toBe(false);
    expect((await tool.run({ name: entry.name })).isError).toBe(true);
    e.bundles.setEnabled("g~reviewer", true);
    expect(() => e.bundles.assertSkill(entry)).toThrow("changed");
    expect((await tool.run({ name: entry.name })).isError).toBe(true);
    const live = e.bundles.skills()[0]!;
    mkdirSync(join(e.root, "skills", live.name), { recursive: true });
    writeFileSync(join(e.root, "skills", live.name, "SKILL.md"), `---\nname: ${live.name}\ndescription: Standalone\n---\nUser-owned skill.\n`);
    expect(source.global().byName.get(live.name)?.origin).toBe("harness");
    expect(source.global().all.find((s) => s.origin === "plugin")?.shadowedBy).toBe("harness");
    // No owner validator means bundle skill delivery fails closed.
    expect((await skillTool(() => [live]).run({ name: live.name })).isError).toBe(true);
  });
  it("installs all metadata atomically and rejects stale/Off command invocations", () => {
    const e = setup(); const installed = e.install();
    expect(e.extensions.get(installed.proposalId)?.status).toBe("installed");
    const command = e.bundles.commands()[0]!;
    expect(command.command).toBe("reviewer.review");
    expect(e.bundles.command(command).prompt).toBe("Review.");
    e.bundles.setEnabled("g~reviewer", false);
    expect(e.bundles.commands()).toEqual([]);
    expect(() => e.bundles.command(command)).toThrow("Off");
    e.bundles.setEnabled("g~reviewer", true);
    expect(() => e.bundles.command(command)).toThrow("changed");
    expect(e.store.sql.prepare("SELECT * FROM plugin_bundle_ops").all()).toEqual([]);
  });
  it("keeps updates Off and refuses added/modified owned files before changing anything", () => {
    const e = setup(); e.install(); e.bundles.setEnabled("g~reviewer", false);
    writeFileSync(join(e.dir, "reviewer", "extra.txt"), "user work");
    expect(() => e.install(e.draft("New"))).toThrow("added");
    expect(readFileSync(join(e.dir, "reviewer", "extra.txt"), "utf8")).toBe("user work");
    rmSync(join(e.dir, "reviewer", "extra.txt"));
    e.install(e.draft("New"));
    expect(e.registry.isEnabled("g~reviewer")).toBe(false);
    expect(e.extensions.installs()).toHaveLength(1);
  });
  it("rolls back files and database rows if the related transaction fails", () => {
    const e = setup(); const previous = e.install();
    const record = vi.spyOn(e.extensions, "recordInstall").mockImplementationOnce(() => { throw new Error("disk full"); });
    expect(() => e.install(e.draft("New"))).toThrow("disk full");
    record.mockRestore();
    expect(e.extensions.installs()[0]?.id).toBe(previous.id);
    expect(e.bundles.command(e.bundles.commands()[0]!).prompt).toBe("Review.");
    expect(e.store.sql.prepare("SELECT * FROM plugin_bundle_ops").all()).toEqual([]);
  });
  it("never activates parts from an unowned folder", () => {
    const e = setup(); mkdirSync(join(e.dir, "unowned"), { recursive: true });
    writeFileSync(join(e.dir, "unowned", "app.json"), '{"name":"unowned","title":"Unowned","description":"Test","contributes":{"commands":[{"name":"run","description":"Run","prompt":"Run."}]}}');
    writeFileSync(join(e.dir, "unowned", "index.html"), "<h1>Test</h1>");
    expect(e.bundles.commands()).toEqual([]);
  });
  it("uninstalls only verified owned files and removes owned parts", () => {
    const e = setup(); const install = e.install();
    writeFileSync(join(e.dir, "reviewer", "index.html"), "user work");
    expect(() => e.bundles.uninstall(install)).toThrow("modified");
    expect(e.extensions.installs()).toHaveLength(1);
    writeFileSync(join(e.dir, "reviewer", "index.html"), "<h1>Review</h1>");
    e.bundles.uninstall(install);
    expect(e.bundles.commands()).toEqual([]);
    expect(e.extensions.installs()).toEqual([]);
    expect(existsSync(join(e.dir, "reviewer"))).toBe(false);
  });
  it("keeps a committed Uninstall committed when journal cleanup cannot finish", () => {
    const e = setup(); const install = e.install();
    const original = e.extensions.removeInstall.bind(e.extensions);
    let retained = "";
    vi.spyOn(e.extensions, "removeInstall").mockImplementationOnce((id) => {
      original(id);
      const op = e.store.sql.prepare("SELECT operation FROM plugin_bundle_ops WHERE key = ?").get("g~reviewer") as { operation: string };
      retained = join((JSON.parse(op.operation) as { folder: string }).folder, "user.txt");
      writeFileSync(retained, "user work");
    });
    expect(() => e.bundles.uninstall(install)).not.toThrow();
    expect(e.extensions.installs()).toEqual([]);
    expect(e.bundles.owns("g~reviewer")).toBe(false);
    expect(readFileSync(retained, "utf8")).toBe("user work");
    expect(e.bundles.error("g~reviewer")).toContain("recovery");
    e.bundles.recover();
    expect(readFileSync(retained, "utf8")).toBe("user work");
  });
  it("installs schedules Off/Ask, never queues them, and gates manual work with the owner", () => {
    const e = setup(); e.install(e.draft("Review.", true));
    const automations = new AutomationStore(e.store.sql), a = automations.list()[0]!;
    expect(a).toMatchObject({ enabled: false, permissions: "ask", projectId: "project" });
    expect(automations.runs(a.id)).toEqual([]);
    expect(e.bundles.automationAllowed(a.id)).toBe(true);
    const run = automations.claimRun(a.id, "manual", Date.now())!;
    e.bundles.setEnabled("g~reviewer", false);
    expect(e.bundles.automationAllowed(a.id)).toBe(false);
    expect(automations.run(run.id)?.status).toBe("cancelled");
    e.bundles.setEnabled("g~reviewer", true);
    expect(automations.get(a.id)?.enabled).toBe(false);
  });
  it("protects automation editor changes and project identity on Update", () => {
    const e = setup(); const install = e.install(e.draft("Review.", true));
    const automations = new AutomationStore(e.store.sql), a = automations.list()[0]!;
    automations.update(a.id, { prompt: "user work" });
    expect(() => e.bundles.uninstall(install)).toThrow("modified");
    expect(automations.get(a.id)?.prompt).toBe("user work");
  });
  it.each(["prepared", "old-moved", "promoted"])("recovers an interrupted %s update to its old reviewed files", (stage) => {
    const e = setup(); const previous = e.install();
    const folder = join(e.dir, ".bundle-recovery", "crash"), next = e.draft("New");
    mkdirSync(join(folder, "new"), { recursive: true });
    const files = next.files.map((f) => { writeFileSync(join(folder, "new", f.path), f.content); return { path: f.path, sha256: createHash("sha256").update(f.content).digest("hex") }; });
    e.store.sql.prepare("INSERT INTO plugin_bundle_ops (key, operation) VALUES (?, ?)").run("g~reviewer", JSON.stringify({ folder, previous, files, remove: false }));
    if (stage !== "prepared") renameSync(join(e.dir, "reviewer"), join(folder, "old"));
    if (stage === "promoted") renameSync(join(folder, "new"), join(e.dir, "reviewer"));
    expect(e.bundles.commands()).toEqual([]);
    e.bundles.recover();
    expect(e.bundles.command(e.bundles.commands()[0]!).prompt).toBe("Review.");
    expect(existsSync(folder)).toBe(false);
  });
  it("retains unexpected recovery content and fails closed without deleting user work", () => {
    const e = setup(); const previous = e.install();
    const folder = join(e.dir, ".bundle-recovery", "crash");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "user.txt"), "user work");
    e.store.sql.prepare("INSERT INTO plugin_bundle_ops (key, operation) VALUES (?, ?)").run("g~reviewer", JSON.stringify({ folder, previous, files: previous.files, remove: false }));
    // The old app never moved; there is no new copy. An inconsistent journal must not erase it.
    e.bundles.recover();
    expect(readFileSync(join(folder, "user.txt"), "utf8")).toBe("user work");
    expect(readFileSync(join(e.dir, "reviewer", "index.html"), "utf8")).toBe("<h1>Review</h1>");
    expect(e.bundles.commands()).toEqual([]);
    expect(e.bundles.error("g~reviewer")).toContain("recovery");
    const registry = new AppRegistry({ globalDir: e.dir, projectPath: () => null, installedError: (key) => e.bundles.runtimeError(key) });
    expect(registry.info("g~reviewer")?.error).toContain("recovery");
    expect(registry.root("g~reviewer")).toBeNull(); expect(registry.manifest("g~reviewer")).toBeNull();
  });
});
