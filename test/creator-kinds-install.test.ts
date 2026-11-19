import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Store } from "../src/main/db";
import { prepareTheme, readThemeFiles } from "../src/main/creator/themes";
import { ThemePreviews } from "../src/main/creator/theme-previews";
import { prepareAutomation } from "../src/main/creator/automations";
import { AutomationStore } from "../src/main/automations/store";
import { viewOf } from "../src/main/automations/app";
import { listDesignSystems, listKitSystems } from "../src/main/design/systems";
import { serveStylePreview } from "../src/main/design/style-preview";
import { ExtensionService } from "../src/main/extensions/install";
import { validateProposal, type ExtensionDraft } from "../src/main/extensions/manifest";
import { ExtensionStore } from "../src/main/extensions/store";
import { closeAfter, tempDir } from "./helpers";

function setup() {
  const root = tempDir();
  const projectDir = join(root, "project");
  mkdirSync(projectDir);
  const store = new Store(join(root, "app.db"));
  closeAfter(() => store.close());
  const project = store.addProject(projectDir);
  const thread = store.createThread(project.id, "codex", "default", "ask", "chat", null, null, "creator");
  const extensions = new ExtensionStore(store.sql);
  const base = listKitSystems(resolve("resources/design-kits/foundation"))[0]!;
  const lookup = (id: string) => id === base.id ? base : listDesignSystems(projectDir).find((s) => s.id === id) ?? null;
  const automations = new AutomationStore(store.sql);
  const save = vi.fn((pid, input, id) => {
    const a = id ? automations.update(id, input) : automations.create({ id: `automation-${automations.list().length}`, projectId: pid, anchor: Date.now(), ...input });
    return viewOf(a, automations, Date.now());
  });
  const service = new ExtensionService({
    extensions, projectOf: (id) => id === project.id ? project : null, allProjects: () => [project], threadProjectId: () => project.id, chatsRoot: null,
    skillDirs: () => ({ harness: join(root, "skills"), projectCubiq: join(projectDir, ".cubiq/skills") }), bundledSkillNames: () => [], invalidateSkills: () => {},
    listMcpNames: () => [], saveMcp: async () => {}, removeMcp: async () => {}, mcpFile: () => "", emitNotice: () => {},
    themeFiles: (draft) => readThemeFiles(draft, lookup),
    automation: { list: (pid) => automations.list(pid).map((a) => viewOf(a, automations, Date.now())), save, remove: (id) => automations.remove(id), active: (id) => Boolean(store.sql.prepare("SELECT 1 FROM automation_runs WHERE automation_id = ? AND status IN ('queued','running','waiting-input')").get(id)) },
  });
  const stage = (draft: ExtensionDraft) => {
    const checked = validateProposal(draft, { scope: { kind: "project", projectId: project.id } });
    if (!checked.ok) throw new Error(checked.errors.join("\n"));
    return extensions.stage({ threadId: thread.id, ...checked.proposal });
  };
  const theme = (value = "#faf8f2") => prepareTheme("paper", { title: "Paper", base: base.id, tokens: [{ name: "--color-bg", scheme: "light", value }] }, lookup);
  const automation = (prompt = "Read project status only.") => prepareAutomation("brief", { title: "Brief", prompt, schedule: { kind: "interval", everyMinutes: 30 }, budgetUsd: 0.1 }, thread, [{ id: "codex", models: [] }]);
  return { root, projectDir, store, project, thread, extensions, service, automations, save, lookup, stage, theme, automation };
}

describe("Creator theme install and preview", () => {
  it("keeps interrupted staging/backup folders out of the Style picker without deleting them", () => {
    const s = setup();
    const folder = join(s.projectDir, ".agents/design-systems/.paper.staging-abcdef");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "index.md"), "---\ntype: design-system\nname: Interrupted copy\n---\n");
    writeFileSync(join(folder, "DESIGN.md"), "# Copy\n");
    writeFileSync(join(folder, "tokens.css"), ":root {\n --color-bg: white;\n}\n");
    expect(listDesignSystems(s.projectDir)).toHaveLength(0);
    expect(existsSync(folder)).toBe(true);
  });

  it("previews sandboxed, installs once, discovers in the existing picker, updates and uninstalls owned files", async () => {
    const s = setup();
    const p = s.stage(s.theme());
    const previews = new ThemePreviews({ dir: join(s.root, "previews"), proposal: (id) => s.extensions.get(id), resolve: (_pid, id) => s.lookup(id) });
    const view = s.service.getProposalView(p.id)!;
    if (view.draft.kind !== "theme") throw new Error("Not a theme");
    const response = serveStylePreview(view.draft.previewUrl, { specimen: resolve("resources/design-preview/specimen.html"), system: (pid, id) => previews.system(pid, id) });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Security-Policy")).toContain("script-src 'none'");
    expect(response.headers.get("Content-Security-Policy")).toContain("connect-src 'none'");
    expect(previews.system("another-project", `creator:${p.id}`)).toBeNull();
    expect(existsSync(join(s.projectDir, ".agents/design-systems/paper"))).toBe(false);
    const results = await Promise.all([s.service.install(p.id), s.service.install(p.id)]);
    expect(results.map((v) => v.status)).toEqual(["installed", "installed"]);
    expect(s.extensions.installs()).toHaveLength(1);
    expect(listDesignSystems(s.projectDir).find((x) => x.id === "project:paper")?.name).toBe("Paper");
    const next = s.stage(s.theme("#f1eee4"));
    expect(s.service.getProposalView(next.id)!.draft).toMatchObject({ update: true });
    expect((await s.service.install(next.id)).status).toBe("installed");
    expect(readFileSync(join(s.projectDir, ".agents/design-systems/paper/tokens.css"), "utf8")).toContain("#f1eee4");
    await s.service.uninstall(s.extensions.installs()[0]!.id);
    expect(s.extensions.installs()).toHaveLength(0);
    expect(listDesignSystems(s.projectDir)).toHaveLength(0);
  });

  it.each(["changed", "added", "removed"])("refuses update/uninstall after a file is %s, preserving user work", async (change) => {
    const s = setup();
    await s.service.install(s.stage(s.theme()).id);
    const dir = join(s.projectDir, ".agents/design-systems/paper");
    if (change === "changed") writeFileSync(join(dir, "tokens.css"), "user work");
    if (change === "added") writeFileSync(join(dir, "notes.md"), "user work");
    if (change === "removed") unlinkSync(join(dir, "DESIGN.md"));
    expect((await s.service.install(s.stage(s.theme()).id)).status).toBe("failed");
    await expect(s.service.uninstall(s.extensions.installs()[0]!.id)).rejects.toThrow();
    expect(existsSync(dir)).toBe(true);
    expect(s.extensions.installs()).toHaveLength(1);
  });

  it("refuses unowned collision, digest tampering and global scope; rejected previews are inaccessible", async () => {
    const s = setup();
    const dir = join(s.projectDir, ".agents/design-systems/paper");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "mine.md"), "keep me");
    const p = s.stage(s.theme());
    await expect(s.service.install(p.id, "global")).rejects.toThrow(/project/);
    expect((await s.service.install(p.id)).status).toBe("failed");
    expect(readFileSync(join(dir, "mine.md"), "utf8")).toBe("keep me");
    const tampered = s.stage(s.theme());
    s.store.sql.prepare("UPDATE extension_proposals SET digest = 'wrong' WHERE id = ?").run(tampered.id);
    expect((await s.service.install(tampered.id)).retryable).toBe(false);
    const rejected = s.stage(s.theme());
    s.service.reject(rejected.id);
    const previews = new ThemePreviews({ dir: join(s.root, "previews"), proposal: (id) => s.extensions.get(id), resolve: (_p, id) => s.lookup(id) });
    expect(previews.system(s.project.id, `creator:${rejected.id}`)).toBeNull();
  });
});

describe("Creator automation installation", () => {
  it("stages without side effects, installs Off/Ask once, updates with history intact and safely uninstalls", async () => {
    const s = setup();
    const p = s.stage(s.automation());
    expect(s.automations.list()).toHaveLength(0);
    expect(s.store.listThreads(s.project.id)).toHaveLength(1);
    await Promise.all([s.service.install(p.id), s.service.install(p.id)]);
    expect(s.save).toHaveBeenCalledTimes(1);
    const a = s.automations.list()[0]!;
    expect(a).toMatchObject({ enabled: false, permissions: "ask" });
    expect(s.automations.runs(a.id)).toHaveLength(0);
    const run = s.automations.claimRun(a.id, "old-run", 100)!;
    s.automations.finishRun(run.id, { status: "succeeded", result: "Old brief" });
    const update = s.stage(s.automation("New read-only brief."));
    expect(s.service.getProposalView(update.id)!.draft).toMatchObject({ update: true });
    expect((await s.service.install(update.id)).status).toBe("installed");
    expect(s.automations.get(a.id)).toMatchObject({ enabled: false, prompt: "New read-only brief.", configVersion: 2 });
    expect(s.automations.runs(a.id)[0]!.result).toBe("Old brief");
    await s.service.uninstall(s.extensions.installs()[0]!.id);
    expect(s.automations.list()).toHaveLength(0);
  });

  it("preserves manual collisions, changed settings and active runs", async () => {
    const s = setup();
    const manual = s.automations.create({ id: "manual", projectId: s.project.id, anchor: 0, ...s.automation().input });
    expect((await s.service.install(s.stage(s.automation()).id)).status).toBe("failed");
    expect(s.automations.get(manual.id)).not.toBeNull();
    const ownedDraft = { ...s.automation(), name: "other", input: { ...s.automation().input, name: "Other" } };
    await s.service.install(s.stage(ownedDraft).id);
    const record = s.extensions.installs()[0]!;
    const id = record.location.slice(11);
    const original = s.automations.get(id)!;
    s.automations.update(id, { prompt: "My edit" });
    expect((await s.service.install(s.stage(ownedDraft).id)).status).toBe("failed");
    await expect(s.service.uninstall(record.id)).rejects.toThrow(/modified/);
    s.automations.update(id, { prompt: original.prompt });
    const run = s.automations.claimRun(id, "queued", 100)!;
    await expect(s.service.uninstall(record.id)).rejects.toThrow(/active run/);
    s.automations.finishRun(run.id, { status: "cancelled" });
    await s.service.uninstall(record.id);
    expect(s.automations.get(manual.id)).not.toBeNull();
  });

  it("rolls back the automation and ownership record together if recording fails", async () => {
    const s = setup();
    const p = s.stage(s.automation());
    vi.spyOn(s.extensions, "recordInstall").mockImplementationOnce(() => { throw new Error("database failure"); });
    expect((await s.service.install(p.id)).status).toBe("failed");
    expect(s.automations.list()).toHaveLength(0);
    expect(s.extensions.installs()).toHaveLength(0);
  });
});
