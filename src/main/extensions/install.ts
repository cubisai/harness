import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isChatsRoot } from "../chats";
import { describeSpec } from "../mcp/servers";
import type { ExtensionInstallView, ExtensionProposalView, McpServerEntry, Project } from "../../shared/types";
import { computeProposalDigest, type ProposalScope, requiredVarsOf, type StoredProposal, validateProposal } from "./manifest";
import { encodeScope, type ExtensionStore, type InstalledFile } from "./store";

const CHANGED_AFTER_REVIEW = "Proposal changed after review; create a new proposal.";
const STAGING_DIR_RE = /^\..+\.staging-[0-9a-f]+$/;

export interface ExtensionInstallDeps {
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
    const projectChoice = home ? { id: home.id, name: home.name } : null;
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

      let project: Project | null = null;
      if (current.scope.kind === "project") {
        project = this.deps.projectOf(current.scope.projectId);
        if (!project || isChatsRoot(project.path, this.deps.chatsRoot) || !existsSync(project.path)) {
          const updated = this.deps.extensions.setStatus(current.id, "failed", "Target project folder no longer exists.");
          return this.toView(updated ?? current);
        }
      }

      const scopeLabel = project ? `project "${project.name}"` : "global";

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

  reject(id: string): ExtensionProposalView {
    const proposal = this.deps.extensions.get(id);
    if (!proposal) throw new Error("Extension proposal not found.");
    if (proposal.status === "rejected") return this.toView(proposal);
    if (proposal.status === "installed") throw new Error("Installed proposals cannot be rejected.");
    const updated = this.deps.extensions.setStatus(id, "rejected", null);
    this.deps.emitNotice(proposal.threadId, `Rejected ${proposal.draft.kind} proposal "${proposal.draft.name}".`);
    return this.toView(updated ?? proposal);
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
    const candidateDirs = [this.deps.skillDirs(null).harness];
    for (const p of this.deps.allProjects()) {
      if (isChatsRoot(p.path, this.deps.chatsRoot) || !existsSync(p.path)) continue;
      const projSkills = this.deps.skillDirs(p.path).projectCubiq;
      try {
        assertContained(p.path, projSkills, "skills root");
        candidateDirs.push(projSkills);
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
