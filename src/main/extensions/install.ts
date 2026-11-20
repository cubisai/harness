import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isChatsRoot } from "../chats";
import { describeSpec } from "../mcp/servers";
import type { ExtensionAppSummary, ExtensionInstallView, ExtensionProposalView, McpServerEntry, Project } from "../../shared/types";
import { parseAppManifest } from "../apps/manifest";
import { type AppDraft, type AutomationDraft, computeProposalDigest, type ProposalScope, requiredVarsOf, type StoredProposal, type ThemeDraft, validateProposal } from "./manifest";
import { encodeScope, type ExtensionInstall, type ExtensionStore, type InstalledFile } from "./store";
import { projectSystemsDir } from "../design/kit-library";
import { parseTokens } from "../design/tokens";
import { stylePreviewUrl } from "../../shared/style-preview";
import type { ThemeFile } from "../creator/themes";
import type { AutomationInput, AutomationView } from "../../shared/automations";
import { automationDigest } from "../creator/automations";
import { describeSchedule } from "../automations/schedule";
import type { PluginBundles } from "../apps/bundles";
import { contributionViews } from "../apps/parts";

const CHANGED_AFTER_REVIEW = "Proposal changed after review; create a new proposal.";
const STAGING_DIR_RE = /^\..+\.staging-[0-9a-f]+$/;

export interface ExtensionInstallDeps {
  bundles?: Pick<PluginBundles, "install" | "uninstall" | "owns">;
  /** Read-only ownership gate even while the bundle installer is intentionally disconnected. */
  bundleOwned?: (key: string) => boolean;
  /** Reviewed metadata for Update diffs; does not activate the installer. */
  bundleParts?: (key: string) => import("../../shared/plugin-parts").PluginPartView[];
  extensions: ExtensionStore;
  projectOf: (projectId: string) => Project | null;
  allProjects: () => Project[];
  /** The thread's project id (Chats threads included; the Chats root is filtered out here). */
  threadProjectId: (threadId: string) => string | null;
  chatsRoot: string | null;
  skillDirs: (projectPath: string | null) => { projectCubiq: string; harness: string };
  bundledSkillNames: () => string[];
  invalidateSkills: () => void;
  listMcpNames: (projectId: string | null) => string[];
  saveMcp: (entry: McpServerEntry, projectId: string | null) => Promise<void>;
  removeMcp: (name: string, projectId: string | null) => Promise<void>;
  mcpFile: (projectId: string | null) => string;
  emitNotice: (threadId: string, text: string) => void;
  /** Where apps install: `<userData>/apps` (null) or `<project>/.cubiq/apps`. Absent: app proposals can't install. */
  appsDir?: (projectPath: string | null) => string;
  /** Whether a connector tool is read-only per its server's listing; "unknown" when it isn't listed (yet). */
  toolAccess?: (projectId: string | null, server: string, tool: string) => "read" | "write" | "unknown";
  /** An app was installed, updated or removed (`key`: its frame key, whose data an uninstall drops). */
  appsChanged?: (change: { key: string; removed: boolean }) => void;
  themeFiles?: (draft: ThemeDraft, projectId: string) => ThemeFile[];
  automation?: {
    list(projectId: string): AutomationView[];
    save(projectId: string, input: AutomationInput, id?: string): AutomationView;
    remove(id: string): void;
    active(id: string): boolean;
  };
}

function sha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function normCase(p: string): string {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

function pathExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve `target` through realpathSync on its deepest existing ancestor, throwing if any
 * existing segment is a broken symlink. Prevents symlink escapes even before directories are created.
 */
function realpathWithMissing(target: string): string {
  const abs = resolve(target);
  const missing: string[] = [];
  let cur = abs;
  while (!pathExists(cur)) {
    const parent = dirname(cur);
    if (parent === cur) return abs;
    missing.unshift(cur.slice(parent.length).replace(/^[/\\]+/, ""));
    cur = parent;
  }
  const realBase = realpathSync(cur);
  return missing.length ? join(realBase, ...missing) : realBase;
}

/** Verify `target` stays strictly inside `base` after symlink resolution; returns resolved target. */
export function assertContained(base: string, target: string, label = "path"): string {
  const realBase = realpathWithMissing(base);
  const realTarget = realpathWithMissing(target);
  const rel = relative(normCase(realBase), normCase(realTarget));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Extension ${label} escapes destination directory.`);
  }
  return realTarget;
}

export class ExtensionService {
  private inflightInstalls = new Map<string, Promise<ExtensionProposalView>>();
  private scopeQueues = new Map<string, Promise<unknown>>();

  constructor(private deps: ExtensionInstallDeps) {}

  getProposalView(id: string): ExtensionProposalView | null {
    const proposal = this.deps.extensions.get(id);
    if (!proposal) return null;
    return this.toView(proposal);
  }

  /** The thread's own project folder, if it has a real one (not the Chats root, not gone). */
  private threadProject(threadId: string): Project | null {
    const id = this.deps.threadProjectId(threadId);
    const project = id ? this.deps.projectOf(id) : null;
    return project && !isChatsRoot(project.path, this.deps.chatsRoot) ? project : null;
  }

  private toView(proposal: StoredProposal): ExtensionProposalView {
    const project = proposal.scope.kind === "project" ? this.deps.projectOf(proposal.scope.projectId) : null;
    const home = this.threadProject(proposal.threadId);
    // Apps always install globally, so their card offers no project.
    const projectChoice = home && (proposal.draft.kind === "skill" || proposal.draft.kind === "connector") ? { id: home.id, name: home.name } : null;
    const install = this.deps.extensions.installs(proposal.scope).find((i) => i.proposalId === proposal.id);
    const retryable = proposal.status === "failed" && !(proposal.error ?? "").includes("changed after review");

    if (proposal.draft.kind === "skill") {
      const sorted = [...proposal.draft.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      const skillMd = sorted.find((f) => f.path === "SKILL.md")?.content ?? "";
      return {
        id: proposal.id,
        threadId: proposal.threadId,
        scope: proposal.scope,
        projectName: project?.name ?? null,
        projectChoice,
        status: proposal.status,
        ...(proposal.error ? { error: proposal.error } : {}),
        createdAt: proposal.createdAt,
        updatedAt: proposal.updatedAt,
        ...(install ? { installId: install.id } : {}),
        retryable,
        draft: {
          kind: "skill",
          name: proposal.draft.name,
          description: proposal.draft.description,
          files: sorted.map((f) => ({ path: f.path, bytes: Buffer.byteLength(f.content, "utf-8") })),
          skillMd,
        },
      };
    }

    if (proposal.draft.kind === "app") {
      // Apps install globally; an app staged for a project (before that rule) still shows and installs as global.
      return {
        id: proposal.id,
        threadId: proposal.threadId,
        scope: proposal.status === "installed" ? proposal.scope : { kind: "global" },
        projectName: proposal.status === "installed" ? (project?.name ?? null) : null,
        projectChoice,
        status: proposal.status,
        ...(proposal.error ? { error: proposal.error } : {}),
        createdAt: proposal.createdAt,
        updatedAt: proposal.updatedAt,
        ...(install ? { installId: install.id } : {}),
        retryable,
        draft: this.appSummary(proposal, proposal.draft),
      };
    }

    if (proposal.draft.kind === "theme") {
      const draft = proposal.draft;
      const tokens = new Map(parseTokens(draft.baseCss).flatMap((g) => g.tokens.map((t) => [t.name, t] as const)));
      return {
        id: proposal.id, threadId: proposal.threadId, scope: proposal.scope, projectName: project?.name ?? null,
        projectChoice: null, status: proposal.status, ...(proposal.error ? { error: proposal.error } : {}),
        createdAt: proposal.createdAt, updatedAt: proposal.updatedAt, ...(install ? { installId: install.id } : {}), retryable,
        draft: {
          kind: "theme", name: draft.name, title: draft.title, description: draft.description, baseName: draft.baseName,
          tokens: draft.tokens.map((t) => ({ ...t, before: t.scheme === "dark" ? tokens.get(t.name)?.dark ?? tokens.get(t.name)?.light ?? "" : tokens.get(t.name)?.light ?? "" })),
          previewUrl: stylePreviewUrl(proposal.scope.kind === "project" ? proposal.scope.projectId : null, `creator:${proposal.id}`, "light"),
          update: proposal.status !== "installed" && this.deps.extensions.installs(proposal.scope).some((i) => i.kind === "theme" && i.name === draft.name),
        },
      };
    }

    if (proposal.draft.kind === "automation") {
      const draft = proposal.draft;
      return {
        id: proposal.id, threadId: proposal.threadId, scope: proposal.scope, projectName: project?.name ?? null, projectChoice: null,
        status: proposal.status, ...(proposal.error ? { error: proposal.error } : {}), createdAt: proposal.createdAt, updatedAt: proposal.updatedAt,
        ...(install ? { installId: install.id } : {}), retryable,
        draft: { kind: "automation", name: draft.name, input: draft.input, scheduleText: describeSchedule(draft.input.schedule), update: proposal.status !== "installed" && this.deps.extensions.installs(proposal.scope).some((i) => i.kind === "automation" && i.name === draft.name) },
      };
    }

    return {
      id: proposal.id,
      threadId: proposal.threadId,
      scope: proposal.scope,
      projectName: project?.name ?? null,
      projectChoice,
      status: proposal.status,
      ...(proposal.error ? { error: proposal.error } : {}),
      createdAt: proposal.createdAt,
      updatedAt: proposal.updatedAt,
      ...(install ? { installId: install.id } : {}),
      retryable,
      draft: {
        kind: "connector",
        name: proposal.draft.name,
        type: proposal.draft.spec.type,
        target: describeSpec(proposal.draft.spec),
        requiredVars: requiredVarsOf(proposal.draft.spec),
      },
    };
  }

  /** The card's view of an app: its grants with their access, and, when it replaces an installed app, what changes per file. */
  private appSummary(proposal: StoredProposal, draft: AppDraft): ExtensionAppSummary {
    const manifestFile = draft.files.find((f) => f.path === "app.json");
    const manifest = manifestFile ? parseAppManifest(manifestFile.content, new Set(draft.files.map((f) => f.path)), draft.name).manifest : null;
    const pid = proposal.scope.kind === "project" ? proposal.scope.projectId : null;
    const grants = (manifest?.grants ?? []).flatMap((g) =>
      g.tools.map((tool) => ({ server: g.server, tool, access: this.deps.toolAccess?.(pid, g.server, tool) ?? ("unknown" as const) })),
    );
    // Against the app this would replace (not after it is installed: then the card shows what it installed).
    const previous = proposal.status === "installed" ? undefined : this.installedApp(proposal.scope, draft.name, proposal.id);
    const files: ExtensionAppSummary["files"] = draft.files.map((f) => {
      const bytes = Buffer.byteLength(f.content, "utf-8");
      if (!previous) return { path: f.path, bytes };
      const old = previous.files.find((o) => o.path === f.path);
      return { path: f.path, bytes, ...(old ? (old.sha256 === sha256(f.content) ? {} : { change: "changed" as const }) : { change: "added" as const }) };
    });
    if (previous) for (const o of previous.files) if (!draft.files.some((f) => f.path === o.path)) files.push({ path: o.path, bytes: 0, change: "removed" });
    const parts = contributionViews(draft.name, manifest?.contributes, draft.bundleProjectId).map((part) => ({ ...part, ...(part.projectId ? { projectName: this.deps.projectOf(part.projectId)?.name } : {}) }));
    const oldParts = previous ? this.deps.bundleParts?.(`g~${draft.name}`) ?? [] : [];
    const partKey = (p: import("../../shared/plugin-parts").PluginPartView) => `${p.kind}\0${p.name}`;
    const partConfig = ({ projectName: _label, change: _change, ...part }: import("../../shared/plugin-parts").PluginPartView) => JSON.stringify(part);
    const reviewedParts = parts.map((part) => {
      if (!previous) return part;
      const old = oldParts.find((p) => partKey(p) === partKey(part));
      const skillFilesChanged = part.kind === "skill" && files.some((f) => f.change && f.path.startsWith(`${part.detail}/`));
      return { ...part, ...(!old ? { change: "added" as const } : partConfig(old) !== partConfig(part) || skillFilesChanged ? { change: "changed" as const } : {}) };
    });
    for (const old of oldParts) if (!parts.some((p) => partKey(p) === partKey(old))) reviewedParts.push({ ...old, change: "removed" });
    return {
      kind: "app",
      name: draft.name,
      title: manifest?.title ?? draft.name,
      description: manifest?.description ?? "",
      ...(manifest?.icon ? { icon: manifest.icon } : {}),
      files: files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
      grants,
      ...(manifest?.tools?.length ? { tools: manifest.tools.map(({ name, description }) => ({ name, description })) } : {}),
      ...(manifest?.cards?.length ? { cards: manifest.cards.map((c) => c.name) } : {}),
      ...(reviewedParts.length ? { parts: reviewedParts } : {}),
      update: Boolean(previous),
      draftKey: `d~${proposal.threadId}~${draft.name}`,
    };
  }

  /** The install record of an app at this scope, other than one this proposal made. */
  private installedApp(scope: ProposalScope, name: string, proposalId?: string): ExtensionInstall | undefined {
    return this.deps.extensions.installs(scope).find((i) => i.kind === "app" && i.name === name && i.proposalId !== proposalId);
  }

  private serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.scopeQueues.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.scopeQueues.set(key, settled);
    void settled.then(() => {
      if (this.scopeQueues.get(key) === settled) this.scopeQueues.delete(key);
    });
    return next;
  }

  install(id: string, scope?: "project" | "global"): Promise<ExtensionProposalView> {
    const existing = this.inflightInstalls.get(id);
    if (existing) return existing;
    // Apps always install globally, whatever the proposal or the caller asked for.
    if (this.deps.extensions.get(id)?.draft.kind === "app") scope = "global";
    const kind = this.deps.extensions.get(id)?.draft.kind;
    if ((kind === "theme" || kind === "automation") && scope === "global") return Promise.reject(new Error("Page themes and scheduled prompts require this project's folder."));
    const promise = (scope ? this.rescope(id, scope) : Promise.resolve()).then(() => this.runInstall(id)).finally(() => {
      if (this.inflightInstalls.get(id) === promise) this.inflightInstalls.delete(id);
    });
    this.inflightInstalls.set(id, promise);
    return promise;
  }

  /**
   * The user picked another scope on the card. Only a proposal still waiting (staged, or failed but retryable)
   * moves, and only after its draft still matches the digest it was reviewed under; the digest is then re-bound to
   * the new scope, so the reviewed content and where it lands are both what the user approved.
   */
  private async rescope(id: string, kind: "project" | "global"): Promise<void> {
    const p = this.deps.extensions.get(id);
    if (!p || p.scope.kind === kind) return;
    if (p.status !== "staged" && p.status !== "failed") return;
    let scope: ProposalScope = { kind: "global" };
    if (kind === "project") {
      const home = this.threadProject(p.threadId);
      if (!home) throw new Error("This thread has no project folder; install it globally.");
      scope = { kind: "project", projectId: home.id };
    }
    const reserved = p.draft.kind === "skill" ? this.deps.bundledSkillNames() : [];
    const before = validateProposal(p.draft, { scope: p.scope, reservedNames: reserved });
    // Left in place: runInstall's own digest check fails it the usual way.
    if (!before.ok || computeProposalDigest(p.scope, before.proposal.draft) !== p.digest) return;
    const after = validateProposal(p.draft, { scope, reservedNames: reserved });
    if (!after.ok) throw new Error(after.errors.join("\n"));
    this.deps.extensions.rescope(id, scope, computeProposalDigest(scope, after.proposal.draft));
  }

  private async runInstall(id: string): Promise<ExtensionProposalView> {
    const initial = this.deps.extensions.get(id);
    if (!initial) throw new Error("Extension proposal not found.");
    if (initial.status === "installed") return this.toView(initial);
    if (initial.status === "rejected") throw new Error("Rejected proposals cannot be installed.");
    if (initial.status === "failed" && (initial.error ?? "").includes("changed after review")) {
      throw new Error(initial.error);
    }

    const check = validateProposal(initial.draft, {
      scope: initial.scope,
      reservedNames: initial.draft.kind === "skill" ? this.deps.bundledSkillNames() : [],
    });
    const digest = check.ok ? computeProposalDigest(initial.scope, check.proposal.draft) : "";
    if (!check.ok || digest !== initial.digest) {
      const updated = this.deps.extensions.setStatus(initial.id, "failed", CHANGED_AFTER_REVIEW);
      return this.toView(updated ?? initial);
    }

    const lockKey = `${check.proposal.draft.kind}:${encodeScope(initial.scope)}`;
    return this.serialize(lockKey, async () => {
      const current = this.deps.extensions.get(id);
      if (!current) throw new Error("Extension proposal not found.");
      if (current.status === "installed") return this.toView(current);
      if (current.status === "rejected") throw new Error("Rejected proposals cannot be installed.");

      let project: Project | null = null;
      if (current.scope.kind === "project") {
        project = this.deps.projectOf(current.scope.projectId);
        if (!project || isChatsRoot(project.path, this.deps.chatsRoot) || !existsSync(project.path)) {
          const updated = this.deps.extensions.setStatus(current.id, "failed", "Target project folder no longer exists.");
          return this.toView(updated ?? current);
        }
      }

      const scopeLabel = project ? `project "${project.name}"` : "global";

      if (check.proposal.draft.kind === "app") return this.installApp(current, check.proposal.draft, digest, project, scopeLabel);
      if (check.proposal.draft.kind === "theme") {
        if (!project || this.threadProject(current.threadId)?.id !== project.id) throw new Error("Theme destination must be this Creator thread's project.");
        return this.installTheme(current, check.proposal.draft, digest, project);
      }
      if (check.proposal.draft.kind === "automation") {
        if (!project || this.threadProject(current.threadId)?.id !== project.id) throw new Error("Automation destination must be this Creator thread's project.");
        return this.installAutomation(current, check.proposal.draft, digest, project);
      }

      if (check.proposal.draft.kind === "skill") {
        const draft = check.proposal.draft;
        const dirs = this.deps.skillDirs(project ? project.path : null);
        const baseDir = current.scope.kind === "project" ? dirs.projectCubiq : dirs.harness;

        let stagingDir: string | null = null;
        let promoted = false;
        const writtenRels: string[] = [];

        try {
          if (project) assertContained(project.path, baseDir, "skills root");
          mkdirSync(baseDir, { recursive: true });
          const destDir = join(baseDir, draft.name);
          assertContained(baseDir, destDir, "skill destination");

          if (pathExists(destDir)) {
            const updated = this.deps.extensions.setStatus(current.id, "failed", `A skill named "${draft.name}" already exists in ${scopeLabel}.`);
            return this.toView(updated ?? current);
          }

          stagingDir = join(baseDir, `.${draft.name}.staging-${randomBytes(6).toString("hex")}`);
          mkdirSync(stagingDir, { recursive: true });
          assertContained(baseDir, stagingDir, "staging folder");

          const installedFiles: InstalledFile[] = [];
          for (const file of draft.files) {
            const targetFile = join(stagingDir, ...file.path.split("/"));
            assertContained(stagingDir, targetFile, file.path);
            mkdirSync(dirname(targetFile), { recursive: true });
            writeFileSync(targetFile, file.content, "utf-8");
            writtenRels.push(file.path);
            installedFiles.push({ path: file.path, sha256: sha256(file.content) });
          }

          if (pathExists(destDir)) {
            const updated = this.deps.extensions.setStatus(current.id, "failed", `A skill named "${draft.name}" already exists in ${scopeLabel}.`);
            return this.toView(updated ?? current);
          }

          renameSync(stagingDir, destDir);
          promoted = true;

          this.deps.extensions.recordInstall({
            proposalId: current.id,
            scope: current.scope,
            kind: "skill",
            name: draft.name,
            location: destDir,
            files: installedFiles,
            digest,
          });
          this.deps.extensions.setStatus(current.id, "installed", null);
          this.deps.invalidateSkills();
          this.deps.emitNotice(current.threadId, `Installed skill "${draft.name}" (${scopeLabel}). New turns can use it.`);
          return this.getProposalView(current.id)!;
        } catch (err) {
          if (promoted) {
            const destDir = join(baseDir, draft.name);
            cleanupWrittenFiles(destDir, writtenRels);
          }
          const msg = err instanceof Error ? err.message : String(err);
          const updated = this.deps.extensions.setStatus(current.id, "failed", msg);
          return this.toView(updated ?? current);
        } finally {
          if (!promoted && stagingDir && existsSync(stagingDir)) {
            rmSync(stagingDir, { recursive: true, force: true });
          }
        }
      } else {
        const draft = check.proposal.draft;
        const pid = current.scope.kind === "project" ? current.scope.projectId : null;
        if (this.deps.listMcpNames(pid).includes(draft.name)) {
          const updated = this.deps.extensions.setStatus(current.id, "failed", `A connector named "${draft.name}" already exists in ${scopeLabel}.`);
          return this.toView(updated ?? current);
        }

        try {
          await this.deps.saveMcp({ name: draft.name, enabled: true, spec: draft.spec }, pid);
          this.deps.extensions.recordInstall({
            proposalId: current.id,
            scope: current.scope,
            kind: "connector",
            name: draft.name,
            location: this.deps.mcpFile(pid),
            files: [],
            digest,
          });
          this.deps.extensions.setStatus(current.id, "installed", null);
          const vars = requiredVarsOf(draft.spec);
          const setVars = vars.length ? ` Set ${vars.join(", ")} in Library → Connectors before using it.` : "";
          this.deps.emitNotice(current.threadId, `Installed connector "${draft.name}" (${scopeLabel}). New turns can use it.${setVars}`);
          return this.getProposalView(current.id)!;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const updated = this.deps.extensions.setStatus(current.id, "failed", msg);
          return this.toView(updated ?? current);
        }
      }
    });
  }

  /**
   * Install an app, or update one this service installed at the same scope: the new files are written to a staging
   * folder first, the old folder is moved aside only after each of its recorded files still matches its hash (a
   * hand-edited app is never overwritten), then swapped in and the old copy removed.
   */
  private installApp(current: StoredProposal, draft: AppDraft, digest: string, project: Project | null, scopeLabel: string): ExtensionProposalView {
    const manifest = parseAppManifest(draft.files.find((f) => f.path === "app.json")!.content, new Set(draft.files.map((f) => f.path)), draft.name).manifest;
    if (manifest?.contributes || this.deps.bundles?.owns(`g~${draft.name}`) || this.deps.bundleOwned?.(`g~${draft.name}`)) {
      try {
        if (!this.deps.bundles) throw new Error("Plugin bundles are not supported in this build.");
        this.deps.bundles.install(current, draft, digest);
        try { this.deps.emitNotice(current.threadId, `Installed plugin bundle "${draft.name}". Scheduled prompts remain Off/Ask; no run was started.`); } catch { /* Committed state. */ }
        return this.getProposalView(current.id)!;
      } catch (e) { return this.toView(this.deps.extensions.setStatus(current.id, "failed", (e as Error).message) ?? current); }
    }
    if (!this.deps.appsDir) {
      const updated = this.deps.extensions.setStatus(current.id, "failed", "Apps can't be installed in this build.");
      return this.toView(updated ?? current);
    }
    const baseDir = this.deps.appsDir(project ? project.path : null);
    const previous = this.installedApp(current.scope, draft.name, current.id);
    let stagingDir: string | null = null;
    let asideDir: string | null = null;
    let promoted = false;
    try {
      if (project) assertContained(project.path, baseDir, "apps folder");
      mkdirSync(baseDir, { recursive: true });
      const destDir = join(baseDir, draft.name);
      assertContained(baseDir, destDir, "app destination");
      if (pathExists(destDir)) {
        if (!previous) {
          const updated = this.deps.extensions.setStatus(current.id, "failed", `An app named "${draft.name}" already exists in ${scopeLabel}.`);
          return this.toView(updated ?? current);
        }
        verifyInstalledFiles(destDir, previous.files, draft.name, true);
      }

      stagingDir = join(baseDir, `.${draft.name}.staging-${randomBytes(6).toString("hex")}`);
      mkdirSync(stagingDir, { recursive: true });
      const installedFiles: InstalledFile[] = [];
      for (const file of draft.files) {
        const targetFile = join(stagingDir, ...file.path.split("/"));
        assertContained(stagingDir, targetFile, file.path);
        mkdirSync(dirname(targetFile), { recursive: true });
        writeFileSync(targetFile, file.content, "utf-8");
        installedFiles.push({ path: file.path, sha256: sha256(file.content) });
      }

      if (pathExists(destDir)) {
        asideDir = join(baseDir, `.${draft.name}.staging-${randomBytes(6).toString("hex")}`);
        renameSync(destDir, asideDir);
      }
      renameSync(stagingDir, destDir);
      promoted = true;

      if (previous) this.deps.extensions.removeInstall(previous.id);
      this.deps.extensions.recordInstall({ proposalId: current.id, scope: current.scope, kind: "app", name: draft.name, location: destDir, files: installedFiles, digest });
      this.deps.extensions.setStatus(current.id, "installed", null);
      const key = current.scope.kind === "project" ? `p~${current.scope.projectId}~${draft.name}` : `g~${draft.name}`;
      this.deps.appsChanged?.({ key, removed: false });
      this.deps.emitNotice(current.threadId, `${previous ? "Updated" : "Installed"} app "${draft.name}" (${scopeLabel}). It is in the sidebar under Apps.`);
      return this.getProposalView(current.id)!;
    } catch (err) {
      // Put the old app back if the new one never landed.
      if (!promoted && asideDir && pathExists(asideDir)) {
        try {
          renameSync(asideDir, join(baseDir, draft.name));
          asideDir = null;
        } catch {
          // Startup cleanup can't restore it either; the error below says what failed.
        }
      }
      const msg = err instanceof Error ? err.message : String(err);
      const updated = this.deps.extensions.setStatus(current.id, "failed", msg);
      return this.toView(updated ?? current);
    } finally {
      if (!promoted && stagingDir && existsSync(stagingDir)) rmSync(stagingDir, { recursive: true, force: true });
      if (promoted && asideDir && existsSync(asideDir)) rmSync(asideDir, { recursive: true, force: true });
    }
  }

  reject(id: string): ExtensionProposalView {
    const proposal = this.deps.extensions.get(id);
    if (!proposal) throw new Error("Extension proposal not found.");
    if (proposal.status === "rejected") return this.toView(proposal);
    if (proposal.status === "installed") throw new Error("Installed proposals cannot be rejected.");
    const updated = this.deps.extensions.setStatus(id, "rejected", null);
    this.deps.emitNotice(proposal.threadId, `Rejected ${proposal.draft.kind} proposal "${proposal.draft.name}".`);
    return this.toView(updated ?? proposal);
  }

  /** A page theme inherits only resolved local assets; never overwrite an unowned or hand-edited folder. */
  private installTheme(current: StoredProposal, draft: ThemeDraft, digest: string, project: Project): ExtensionProposalView {
    const base = projectSystemsDir(project.path);
    const dest = join(base, draft.name);
    const previous = this.deps.extensions.installs(current.scope).find((i) => i.kind === "theme" && i.name === draft.name);
    let staging: string | null = null;
    let aside: string | null = null;
    let promoted = false;
    try {
      if (!this.deps.themeFiles) throw new Error("Themes are not supported in this build.");
      const files = this.deps.themeFiles(draft, project.id);
      assertContained(project.path, base, "themes root");
      if (pathExists(base) && lstatSync(base).isSymbolicLink()) throw new Error("Theme root is a symlink.");
      mkdirSync(base, { recursive: true });
      assertContained(base, dest, "theme destination");
      if (pathExists(dest)) {
        if (!previous) throw new Error(`A theme named "${draft.name}" already exists in this project.`);
        verifyInstalledFiles(dest, previous.files, draft.name, true);
      } else if (previous) throw new Error("Installed theme was removed; create a new proposal with a fresh name.");
      staging = join(base, `.${draft.name}.staging-${randomBytes(6).toString("hex")}`);
      mkdirSync(staging);
      const hashes: InstalledFile[] = [];
      for (const f of files) {
        const file = join(staging, ...f.path.split("/"));
        assertContained(staging, file, f.path);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, f.content);
        hashes.push({ path: f.path, sha256: sha256(f.content) });
      }
      if (pathExists(dest)) {
        if (!previous) throw new Error("Theme destination appeared during installation.");
        verifyInstalledFiles(dest, previous.files, draft.name, true);
        aside = join(base, `.${draft.name}.staging-${randomBytes(6).toString("hex")}`);
        renameSync(dest, aside);
      }
      renameSync(staging, dest);
      promoted = true;
      this.deps.extensions.transaction(() => {
        this.deps.extensions.recordInstall({ proposalId: current.id, scope: current.scope, kind: "theme", name: draft.name, location: dest, files: hashes, digest });
        this.deps.extensions.setStatus(current.id, "installed");
      });
      try { this.deps.emitNotice(current.threadId, `${previous ? "Updated" : "Installed"} page theme "${draft.title}". Choose it in Design → Style; no page was changed.`); } catch { /* The install is committed; a notification failure must not delete it. */ }
      return this.getProposalView(current.id)!;
    } catch (err) {
      if (promoted) { rmSync(dest, { recursive: true, force: true }); promoted = false; }
      if (aside && pathExists(aside)) { renameSync(aside, dest); aside = null; }
      const failed = this.deps.extensions.setStatus(current.id, "failed", err instanceof Error ? err.message : String(err));
      return this.toView(failed ?? current);
    } finally {
      if (staging && pathExists(staging)) rmSync(staging, { recursive: true, force: true });
      if (promoted && aside && pathExists(aside)) rmSync(aside, { recursive: true, force: true });
    }
  }

  private installedAutomation(record: ExtensionInstall, projectId: string): AutomationView {
    if (!this.deps.automation || !record.location.startsWith("automation:")) throw new Error("Invalid automation ownership record.");
    const id = record.location.slice(11);
    const current = this.deps.automation.list(projectId).find((a) => a.id === id);
    if (!current) throw new Error("Installed automation was removed; use a fresh proposal name.");
    if (this.deps.automation.active(id)) throw new Error("Automation has an active run. Wait for it to finish before changing it.");
    if (record.files.length !== 1 || record.files[0]?.path !== "automation.json" || record.files[0].sha256 !== automationDigest(current)) throw new Error("Automation was modified after installation; its settings were kept.");
    return current;
  }

  /** Off/Ask only. The existing save service writes settings; it never queues a run here. */
  private installAutomation(current: StoredProposal, draft: AutomationDraft, digest: string, project: Project): ExtensionProposalView {
    try {
      const api = this.deps.automation;
      if (!api) throw new Error("Scheduled prompts are not supported in this build.");
      const previous = this.deps.extensions.installs(current.scope).find((i) => i.kind === "automation" && i.name === draft.name);
      const owned = previous ? this.installedAutomation(previous, project.id) : null;
      if (api.list(project.id).some((a) => a.id !== owned?.id && a.name.trim().toLowerCase() === draft.input.name.toLowerCase())) throw new Error("An automation with this title already exists in this project.");
      this.deps.extensions.transaction(() => {
        const saved = api.save(project.id, draft.input, owned?.id);
        this.deps.extensions.recordInstall({ proposalId: current.id, scope: current.scope, kind: "automation", name: draft.name, location: `automation:${saved.id}`, files: [{ path: "automation.json", sha256: automationDigest(saved) }], digest });
        this.deps.extensions.setStatus(current.id, "installed");
      });
      try { this.deps.emitNotice(current.threadId, `${owned ? "Updated" : "Installed"} automation "${draft.input.name}" Off/Ask. Enable it or Run now in Library → Automations; no run was started.`); } catch { /* Committed settings are independent of the notice. */ }
      return this.getProposalView(current.id)!;
    } catch (err) {
      const failed = this.deps.extensions.setStatus(current.id, "failed", err instanceof Error ? err.message : String(err));
      return this.toView(failed ?? current);
    }
  }

  installs(projectId?: string | null): ExtensionInstallView[] {
    const rows =
      projectId === undefined
        ? this.deps.extensions.installs()
        : projectId === null
          ? this.deps.extensions.installs({ kind: "global" })
          : this.deps.extensions.installs().filter((i) => i.scope.kind === "global" || (i.scope.kind === "project" && i.scope.projectId === projectId));
    return rows.map((i) => ({
      id: i.id,
      proposalId: i.proposalId,
      scope: i.scope,
      kind: i.kind,
      name: i.name,
      targetPath: i.location,
      installedAt: i.installedAt,
    }));
  }

  async uninstall(installId: string): Promise<void> {
    const inst = this.deps.extensions.getInstall(installId);
    if (!inst) throw new Error("Extension install record not found.");

    const lockKey = `${inst.kind}:${encodeScope(inst.scope)}`;
    await this.serialize(lockKey, async () => {
      const current = this.deps.extensions.getInstall(installId);
      if (!current) return;

      if (current.kind === "automation") {
        const pid = current.scope.kind === "project" ? current.scope.projectId : null;
        if (!pid) throw new Error("Automation has no project.");
        const a = this.installedAutomation(current, pid);
        this.deps.automation!.remove(a.id);
        this.deps.extensions.removeInstall(installId);
        return;
      }

      if (current.kind === "theme") {
        const project = current.scope.kind === "project" ? this.deps.projectOf(current.scope.projectId) : null;
        if (!project || !existsSync(project.path)) throw new Error("Theme project is no longer available.");
        const base = projectSystemsDir(project.path);
        assertContained(project.path, base, "themes root");
        const dest = join(base, current.name);
        assertContained(base, dest, "theme destination");
        if (pathExists(dest)) {
          const verified = verifyInstalledFiles(dest, current.files, current.name, true);
          for (const f of verified) unlinkSync(f.abs);
          pruneEmptyDirs(dest, verified.map((f) => f.rel));
        }
        this.deps.extensions.removeInstall(installId);
        return;
      }

      if (current.kind === "app") {
        if (current.scope.kind === "global" && (this.deps.bundles?.owns(`g~${current.name}`) || this.deps.bundleOwned?.(`g~${current.name}`))) {
          if (!this.deps.bundles) throw new Error("Plugin bundles are not supported in this build; their owned parts were kept.");
          this.deps.bundles.uninstall(current); return;
        }
        let baseDir: string | null = null;
        if (current.scope.kind === "global") baseDir = this.deps.appsDir?.(null) ?? null;
        else {
          const project = this.deps.projectOf(current.scope.projectId);
          if (project && existsSync(project.path) && !isChatsRoot(project.path, this.deps.chatsRoot) && this.deps.appsDir) {
            baseDir = this.deps.appsDir(project.path);
            assertContained(project.path, baseDir, "apps folder");
          }
        }
        if (baseDir && existsSync(baseDir)) {
          const destDir = join(baseDir, current.name);
          if (pathExists(destDir)) {
            assertContained(baseDir, destDir, "app destination");
            const verified = verifyInstalledFiles(destDir, current.files ?? [], current.name);
            for (const f of verified) unlinkSync(f.abs);
            pruneEmptyDirs(destDir, verified.map((f) => f.rel));
          }
        }
        this.deps.extensions.removeInstall(installId);
        const key = current.scope.kind === "project" ? `p~${current.scope.projectId}~${current.name}` : `g~${current.name}`;
        this.deps.appsChanged?.({ key, removed: true });
        return;
      }

      if (current.kind === "skill") {
        let baseDir: string | null = null;
        if (current.scope.kind === "global") {
          baseDir = this.deps.skillDirs(null).harness;
        } else {
          const project = this.deps.projectOf(current.scope.projectId);
          if (project && existsSync(project.path) && !isChatsRoot(project.path, this.deps.chatsRoot)) {
            baseDir = this.deps.skillDirs(project.path).projectCubiq;
            assertContained(project.path, baseDir, "skills root");
          }
        }

        if (baseDir && existsSync(baseDir)) {
          const destDir = join(baseDir, current.name);
          if (pathExists(destDir)) {
            if (lstatSync(destDir).isSymbolicLink()) {
              throw new Error(`Refusing to uninstall "${current.name}": destination is a symlink.`);
            }
            assertContained(baseDir, destDir, "skill destination");

            const files = current.files ?? [];
            const toDelete: { abs: string; rel: string }[] = [];
            // Phase A: verify every existing file matches its recorded hash before deleting anything.
            for (const entry of files) {
              const segs = entry.path.split("/");
              if (segs.some((s) => !s || s === "." || s === "..")) {
                throw new Error(`Invalid recorded file path "${entry.path}".`);
              }
              const fileAbs = join(destDir, ...segs);
              if (!pathExists(fileAbs)) continue;
              const st = lstatSync(fileAbs);
              if (st.isSymbolicLink() || !st.isFile()) {
                throw new Error(`Cannot uninstall "${current.name}": "${entry.path}" is not a regular file.`);
              }
              assertContained(destDir, fileAbs, entry.path);
              const curHash = sha256(readFileSync(fileAbs));
              if (curHash !== entry.sha256) {
                throw new Error(`Cannot uninstall "${current.name}": "${entry.path}" was modified after installation.`);
              }
              toDelete.push({ abs: fileAbs, rel: entry.path });
            }

            // Phase B: unlink only verified files, then prune empty parent folders bottom-up.
            for (const f of toDelete) unlinkSync(f.abs);
            pruneEmptyDirs(destDir, toDelete.map((f) => f.rel));
            this.deps.invalidateSkills();
          }
        }
        this.deps.extensions.removeInstall(installId);
        return;
      }

      const pid = current.scope.kind === "project" ? current.scope.projectId : null;
      await this.deps.removeMcp(current.name, pid);
      this.deps.extensions.removeInstall(installId);
    });
  }

  /** Remove abandoned staging folders left by crashes and reconcile partially committed installs. */
  cleanupStartup(): void {
    const candidateDirs = [this.deps.skillDirs(null).harness, ...(this.deps.appsDir ? [this.deps.appsDir(null)] : [])];
    for (const p of this.deps.allProjects()) {
      if (isChatsRoot(p.path, this.deps.chatsRoot) || !existsSync(p.path)) continue;
      const projSkills = this.deps.skillDirs(p.path).projectCubiq;
      try {
        assertContained(p.path, projSkills, "skills root");
        candidateDirs.push(projSkills);
        if (this.deps.appsDir) {
          const projApps = this.deps.appsDir(p.path);
          assertContained(p.path, projApps, "apps folder");
          candidateDirs.push(projApps);
        }
      } catch {
        // Ignore projects whose .cubiq/skills points outside the project.
      }
    }

    for (const dir of candidateDirs) {
      if (!existsSync(dir)) continue;
      try {
        if (lstatSync(dir).isSymbolicLink()) continue;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.isSymbolicLink() || !STAGING_DIR_RE.test(entry.name)) continue;
          const full = join(dir, entry.name);
          assertContained(dir, full, "staging folder");
          rmSync(full, { recursive: true, force: true });
        }
      } catch {
        // Best-effort cleanup at startup.
      }
    }

    // Crash window: install row committed just before proposal status switched to "installed".
    for (const inst of this.deps.extensions.installs()) {
      const prop = this.deps.extensions.get(inst.proposalId);
      if (prop && prop.status === "staged") {
        this.deps.extensions.setStatus(prop.id, "installed", null);
      }
    }
  }
}

/**
 * Every recorded file of an installed folder that still exists, after checking each is a regular file inside the
 * folder with its recorded hash. Throws before anything is changed when one was edited or replaced.
 */
export function verifyInstalledFiles(destDir: string, files: InstalledFile[], name: string, complete = false): { abs: string; rel: string }[] {
  if (lstatSync(destDir).isSymbolicLink()) throw new Error(`Refusing to change "${name}": its folder is a symlink.`);
  if (complete) {
    const recorded = new Set(files.map((f) => f.path));
    const scan = (rel: string): void => {
      for (const entry of readdirSync(join(destDir, rel), { withFileTypes: true })) {
        const p = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory() && files.some((f) => f.path.startsWith(`${p}/`))) scan(p);
        else if (!entry.isFile() || !recorded.has(p)) throw new Error(`Cannot change "${name}": "${p}" was added after installation.`);
      }
    };
    scan("");
  }
  const out: { abs: string; rel: string }[] = [];
  for (const entry of files) {
    const segs = entry.path.split("/");
    if (segs.some((s) => !s || s === "." || s === "..")) throw new Error(`Invalid recorded file path "${entry.path}".`);
    const fileAbs = join(destDir, ...segs);
    if (!pathExists(fileAbs)) {
      if (complete) throw new Error(`Cannot change "${name}": "${entry.path}" was removed after installation.`);
      continue;
    }
    const st = lstatSync(fileAbs);
    if (st.isSymbolicLink() || !st.isFile()) throw new Error(`Cannot change "${name}": "${entry.path}" is not a regular file.`);
    assertContained(destDir, fileAbs, entry.path);
    if (sha256(readFileSync(fileAbs)) !== entry.sha256) throw new Error(`Cannot change "${name}": "${entry.path}" was modified after installation.`);
    out.push({ abs: fileAbs, rel: entry.path });
  }
  return out;
}

function pruneEmptyDirs(root: string, relFiles: string[]): void {
  const dirs = new Set<string>([root]);
  for (const rel of relFiles) {
    let cur = dirname(join(root, ...rel.split("/")));
    while (cur !== root && cur.length >= root.length) {
      dirs.add(cur);
      cur = dirname(cur);
    }
  }
  const ordered = [...dirs].sort((a, b) => b.length - a.length);
  for (const dir of ordered) {
    try {
      if (readdirSync(dir).length === 0) rmdirSync(dir);
    } catch {
      // Ignore non-empty or already removed directories.
    }
  }
}

function cleanupWrittenFiles(root: string, relFiles: string[]): void {
  for (const rel of relFiles) {
    try {
      const p = join(root, ...rel.split("/"));
      if (pathExists(p)) unlinkSync(p);
    } catch {
      // Best-effort rollback.
    }
  }
  pruneEmptyDirs(root, relFiles);
}
