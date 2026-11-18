import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chatsRoot } from "../src/main/chats";
import { Store } from "../src/main/db";
import { ExtensionService } from "../src/main/extensions/install";
import { validateProposal } from "../src/main/extensions/manifest";
import { ExtensionStore } from "../src/main/extensions/store";
import { McpScopes, McpServerStore } from "../src/main/mcp/servers";
import { McpVault } from "../src/main/mcp/vault";
import type { SecretBox } from "../src/main/settings";
import { discoverSkills } from "../src/main/skills/discover";
import { SkillCatalogs } from "../src/main/skills/sources";
import type { McpServerEntry } from "../src/shared/types";

const dirs: string[] = [];
const makeTemp = () => {
  const d = mkdtempSync(join(tmpdir(), "ext-install-"));
  dirs.push(d);
  return d;
};

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const box: SecretBox = {
  available: true,
  encrypt: (s) => Buffer.from(`enc:${s}`).toString("base64"),
  decrypt: (b) => {
    const raw = Buffer.from(b, "base64").toString();
    return raw.startsWith("enc:") ? raw.slice(4) : raw;
  },
};

function setupEnv() {
  const root = makeTemp();
  const userData = join(root, "userData");
  const projectDir = join(root, "project");
  const outsideDir = join(root, "outside");
  mkdirSync(userData, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });

  const cRoot = chatsRoot(userData);
  mkdirSync(cRoot, { recursive: true });

  const store = new Store(join(userData, "app.db"));
  const extensions = new ExtensionStore(store.sql);
  const project = store.addProject(projectDir);
  const thread = store.createThread(project.id, "codex", "default-model", "ask", "chat", null, null, "creator");

  const harnessDir = join(userData, "skills");
  mkdirSync(harnessDir, { recursive: true });
  const bundledDir = resolve("resources/skills");
  const skills = new SkillCatalogs({
    legacyRoot: null,
    bundledDir,
    harnessDir,
    disabled: () => [],
  });

  const vault = new McpVault(join(userData, "mcp-vault.json"), box);
  const mcpStore = new McpServerStore(join(userData, "mcp.json"), vault);
  const mcpProjectDir = (pid: string) => join(userData, "projects", pid);
  const mcpScopes = new McpScopes(mcpStore, mcpProjectDir, vault);

  const notices: { threadId: string; text: string }[] = [];
  const saveSpy = vi.fn(async (entry: McpServerEntry, projectId: string | null) => {
    (projectId ? mcpScopes.project(projectId) : mcpStore).save(entry);
  });
  const removeSpy = vi.fn(async (name: string, projectId: string | null) => {
    (projectId ? mcpScopes.project(projectId) : mcpStore).remove(name);
  });

  const service = new ExtensionService({
    extensions,
    projectOf: (id) => {
      try {
        return store.getProject(id);
      } catch {
        return null;
      }
    },
    allProjects: () => store.listProjects(),
    threadProjectId: (tid) => {
      try {
        return store.getThread(tid).projectId;
      } catch {
        return null;
      }
    },
    chatsRoot: cRoot,
    skillDirs: (p) => skills.dirs(p),
    bundledSkillNames: () => discoverSkills({ origin: "bundled", dir: bundledDir }).map((s) => s.name),
    invalidateSkills: () => skills.invalidate(),
    listMcpNames: (pid) => (pid ? mcpScopes.project(pid) : mcpStore).list().map((s) => s.name),
    saveMcp: saveSpy,
    removeMcp: removeSpy,
    mcpFile: (pid) => (pid ? join(mcpProjectDir(pid), "mcp.json") : join(userData, "mcp.json")),
    emitNotice: (tid, text) => notices.push({ threadId: tid, text }),
  });

  return {
    root,
    userData,
    projectDir,
    outsideDir,
    harnessDir,
    store,
    extensions,
    project,
    thread,
    skills,
    mcpStore,
    mcpScopes,
    service,
    notices,
    saveSpy,
    removeSpy,
  };
}

function stageSkill(env: ReturnType<typeof setupEnv>, scope: "project" | "global", name = "tidy-prs") {
  const s = scope === "project" ? ({ kind: "project", projectId: env.project.id } as const) : ({ kind: "global" } as const);
  const check = validateProposal(
    {
      kind: "skill",
      name,
      description: "Clean PR descriptions.",
      files: [
        { path: "SKILL.md", content: `---\nname: ${name}\ndescription: Clean PR descriptions.\n---\n\n# ${name}\n\nKeep PRs crisp.\n` },
        { path: "notes/checklist.md", content: "- Check title\n" },
      ],
    },
    { scope: s },
  );
  if (!check.ok) throw new Error(check.errors.join("; "));
  return env.extensions.stage({
    threadId: env.thread.id,
    scope: check.proposal.scope,
    draft: check.proposal.draft,
    digest: check.proposal.digest,
  });
}

function stageConnector(env: ReturnType<typeof setupEnv>, scope: "project" | "global", name = "linear") {
  const s = scope === "project" ? ({ kind: "project", projectId: env.project.id } as const) : ({ kind: "global" } as const);
  const check = validateProposal(
    {
      kind: "connector",
      name,
      spec: {
        type: "http",
        url: "https://mcp.linear.app/mcp",
        headers: { Authorization: "${LINEAR_AUTH_HEADER}" },
      },
    },
    { scope: s },
  );
  if (!check.ok) throw new Error(check.errors.join("; "));
  return env.extensions.stage({
    threadId: env.thread.id,
    scope: check.proposal.scope,
    draft: check.proposal.draft,
    digest: check.proposal.digest,
  });
}

describe("Extension install / reject / uninstall (B7)", () => {
  it("installs a valid project skill atomically, records file hashes, invalidates catalog, and notifies", async () => {
    const env = setupEnv();
    const prop = stageSkill(env, "project", "tidy-prs");

    // Seed cache before install so invalidateSkills() is actually verified.
    expect(env.skills.forProject(env.projectDir).byName.has("tidy-prs")).toBe(false);

    const view = await env.service.install(prop.id);
    expect(view.status).toBe("installed");
    expect(view.installId).toBeDefined();
    expect(view.draft.kind).toBe("skill");
    if (view.draft.kind === "skill") {
      expect(view.draft.files.map((f) => f.path)).toEqual(["SKILL.md", "notes/checklist.md"]);
      expect(view.draft.skillMd).toContain("# tidy-prs");
    }

    const dest = join(env.projectDir, ".cubiq", "skills", "tidy-prs");
    expect(readFileSync(join(dest, "SKILL.md"), "utf-8")).toContain("# tidy-prs");
    expect(readFileSync(join(dest, "notes", "checklist.md"), "utf-8")).toBe("- Check title\n");
    expect(env.skills.forProject(env.projectDir).byName.has("tidy-prs")).toBe(true);

    const inst = env.extensions.getInstall(view.installId!)!;
    expect(inst.location).toBe(dest);
    expect(inst.files).toEqual([
      { path: "SKILL.md", sha256: createHash("sha256").update(readFileSync(join(dest, "SKILL.md"))).digest("hex") },
      { path: "notes/checklist.md", sha256: createHash("sha256").update("- Check title\n").digest("hex") },
    ]);
    expect(env.notices).toHaveLength(1);
    expect(env.notices[0]!.text).toContain('Installed skill "tidy-prs"');
  });

  it("installs global skills and connectors (project & global) without exposing secrets in views", async () => {
    const env = setupEnv();
    const skillProp = stageSkill(env, "global", "global-skill");
    const connProp = stageConnector(env, "global", "linear");
    const projConnProp = stageConnector(env, "project", "proj-mcp");

    const v1 = await env.service.install(skillProp.id);
    expect(v1.status).toBe("installed");
    expect(existsSync(join(env.harnessDir, "global-skill", "SKILL.md"))).toBe(true);

    const v2 = await env.service.install(connProp.id);
    expect(v2.status).toBe("installed");
    expect(v2.draft).toEqual({
      kind: "connector",
      name: "linear",
      type: "http",
      target: "https://mcp.linear.app/mcp",
      requiredVars: ["LINEAR_AUTH_HEADER"],
    });
    expect(env.mcpStore.list().map((s) => s.name)).toContain("linear");

    const v3 = await env.service.install(projConnProp.id);
    expect(v3.status).toBe("installed");
    expect(env.mcpScopes.project(env.project.id).list().map((s) => s.name)).toContain("proj-mcp");

    expect(env.service.installs().map((i) => i.name).sort()).toEqual(["global-skill", "linear", "proj-mcp"]);
    expect(env.service.installs(null).map((i) => i.name).sort()).toEqual(["global-skill", "linear"]);
  });

  it("installs where the user picks on the card: a project proposal globally, a global one into the thread's project", async () => {
    const env = setupEnv();
    const toGlobal = stageSkill(env, "project", "moved-out");
    expect(env.service.getProposalView(toGlobal.id)!.projectChoice).toEqual({ id: env.project.id, name: env.project.name });
    const v1 = await env.service.install(toGlobal.id, "global");
    expect(v1.status).toBe("installed");
    expect(v1.scope).toEqual({ kind: "global" });
    expect(existsSync(join(env.harnessDir, "moved-out", "SKILL.md"))).toBe(true);
    expect(existsSync(join(env.projectDir, ".cubiq", "skills", "moved-out"))).toBe(false);

    const toProject = stageConnector(env, "global", "moved-in");
    const v2 = await env.service.install(toProject.id, "project");
    expect(v2.status).toBe("installed");
    expect(env.mcpScopes.project(env.project.id).list().map((s) => s.name)).toContain("moved-in");
    expect(env.mcpStore.list().map((s) => s.name)).not.toContain("moved-in");
    // Same scope as proposed: nothing re-bound.
    const same = stageSkill(env, "global", "kept");
    expect((await env.service.install(same.id, "global")).status).toBe("installed");
  });

  it("a scope change still refuses a draft edited after review", async () => {
    const env = setupEnv();
    const prop = stageSkill(env, "project", "tampered");
    env.store.sql.prepare("UPDATE extension_proposals SET draft = replace(draft, 'Keep PRs crisp.', 'Do something else.') WHERE id = ?").run(prop.id);
    const view = await env.service.install(prop.id, "global");
    expect(view.status).toBe("failed");
    expect(view.error).toContain("changed after review");
    expect(existsSync(join(env.harnessDir, "tampered"))).toBe(false);
  });

  it("refuses to overwrite existing skills or connectors and allows Retry after collision clears", async () => {
    const env = setupEnv();
    const conflictSkill = join(env.projectDir, ".cubiq", "skills", "dupe-skill");
    mkdirSync(conflictSkill, { recursive: true });
    writeFileSync(join(conflictSkill, "SKILL.md"), "existing skill");

    const sProp = stageSkill(env, "project", "dupe-skill");
    const sFail = await env.service.install(sProp.id);
    expect(sFail.status).toBe("failed");
    expect(sFail.retryable).toBe(true);
    expect(sFail.error).toContain("already exists");
    expect(readFileSync(join(conflictSkill, "SKILL.md"), "utf-8")).toBe("existing skill");

    // Removing the conflict allows Retry to succeed.
    rmSync(conflictSkill, { recursive: true, force: true });
    const sRetry = await env.service.install(sProp.id);
    expect(sRetry.status).toBe("installed");

    env.mcpStore.save({ name: "dupe-mcp", enabled: true, spec: { type: "http", url: "https://existing.example.com" } });
    const cProp = stageConnector(env, "global", "dupe-mcp");
    const cFail = await env.service.install(cProp.id);
    expect(cFail.status).toBe("failed");
    expect(cFail.retryable).toBe(true);
    expect(env.mcpStore.list().find((s) => s.name === "dupe-mcp")?.spec).toMatchObject({ url: "https://existing.example.com" });
  });

  it("fails non-retryably when proposal digest changed after review", async () => {
    const env = setupEnv();
    const prop = stageConnector(env, "global", "linear");
    env.store.sql.prepare("UPDATE extension_proposals SET digest = ? WHERE id = ?").run("tampered-digest", prop.id);

    const view = await env.service.install(prop.id);
    expect(view.status).toBe("failed");
    expect(view.error).toContain("changed after review");
    expect(view.retryable).toBe(false);
    expect(env.saveSpy).not.toHaveBeenCalled();

    await expect(env.service.install(prop.id)).rejects.toThrow(/changed after review/i);
  });

  it("dedupes concurrent double-click installs for the same proposal id", async () => {
    const env = setupEnv();
    const prop = stageConnector(env, "global", "double-click");

    const [a, b] = await Promise.all([env.service.install(prop.id), env.service.install(prop.id)]);
    expect(a.status).toBe("installed");
    expect(b.status).toBe("installed");
    expect(a.installId).toBe(b.installId);
    expect(env.saveSpy).toHaveBeenCalledTimes(1);
    expect(env.service.installs()).toHaveLength(1);
  });

  it("blocks symlink escapes during install and uninstall", async () => {
    const env = setupEnv();
    mkdirSync(join(env.projectDir, ".cubiq"), { recursive: true });
    symlinkSync(env.outsideDir, join(env.projectDir, ".cubiq", "skills"));

    const prop = stageSkill(env, "project", "escape-skill");
    const fail = await env.service.install(prop.id);
    expect(fail.status).toBe("failed");
    expect(fail.error).toMatch(/escapes/i);
    expect(existsSync(join(env.outsideDir, "escape-skill"))).toBe(false);

    // Symlinked folder on disk during uninstall is refused cleanly.
    const propG = stageSkill(env, "global", "sym-skill");
    const okG = await env.service.install(propG.id);
    expect(okG.status).toBe("installed");
    const installedPath = join(env.harnessDir, "sym-skill");
    rmSync(installedPath, { recursive: true, force: true });
    symlinkSync(env.outsideDir, installedPath);
    await expect(env.service.uninstall(okG.installId!)).rejects.toThrow(/symlink/i);
  });

  it("rejects staged proposals cleanly and prevents later install", async () => {
    const env = setupEnv();
    const prop = stageSkill(env, "project", "rej-skill");
    const rejected = env.service.reject(prop.id);
    expect(rejected.status).toBe("rejected");
    expect(env.notices.at(-1)?.text).toContain('Rejected skill proposal "rej-skill"');
    expect(existsSync(join(env.projectDir, ".cubiq", "skills", "rej-skill"))).toBe(false);

    await expect(env.service.install(prop.id)).rejects.toThrow(/Rejected/);
  });

  it("uninstalls unmodified skills while preserving extra files, and refuses modified files", async () => {
    const env = setupEnv();
    const prop = stageSkill(env, "project", "uninst-skill");
    const installed = await env.service.install(prop.id);
    const dest = join(env.projectDir, ".cubiq", "skills", "uninst-skill");
    const originalSkillMd = readFileSync(join(dest, "SKILL.md"), "utf-8");

    // Modify recorded file -> uninstall refuses BEFORE deleting anything.
    writeFileSync(join(dest, "SKILL.md"), "user customized!");
    await expect(env.service.uninstall(installed.installId!)).rejects.toThrow(/modified/i);
    expect(existsSync(join(dest, "notes", "checklist.md"))).toBe(true);

    // Restore original content and add an untracked file -> only recorded files removed, extra file kept.
    writeFileSync(join(dest, "SKILL.md"), originalSkillMd);
    writeFileSync(join(dest, "USER_NOTES.txt"), "keep me");
    await env.service.uninstall(installed.installId!);
    expect(existsSync(join(dest, "SKILL.md"))).toBe(false);
    expect(existsSync(join(dest, "notes"))).toBe(false);
    expect(readFileSync(join(dest, "USER_NOTES.txt"), "utf-8")).toBe("keep me");
    expect(env.extensions.getInstall(installed.installId!)).toBeNull();
  });

  it("uninstalls connectors via removeMcp and cleans up install record", async () => {
    const env = setupEnv();
    const prop = stageConnector(env, "project", "proj-conn");
    const installed = await env.service.install(prop.id);
    expect(env.mcpScopes.project(env.project.id).list().map((s) => s.name)).toContain("proj-conn");

    await env.service.uninstall(installed.installId!);
    expect(env.removeSpy).toHaveBeenCalledWith("proj-conn", env.project.id);
    expect(env.mcpScopes.project(env.project.id).list()).toHaveLength(0);
    expect(env.extensions.getInstall(installed.installId!)).toBeNull();
  });

  it("cleans abandoned staging directories and reconciles half-committed DB state on startup", () => {
    const env = setupEnv();
    const globalLeftover = join(env.harnessDir, ".abandoned.staging-deadbeef");
    const projSkillsDir = join(env.projectDir, ".cubiq", "skills");
    const projLeftover = join(projSkillsDir, ".partial.staging-0123abcd");
    mkdirSync(globalLeftover, { recursive: true });
    mkdirSync(projLeftover, { recursive: true });
    writeFileSync(join(projLeftover, "SKILL.md"), "partial");

    // Simulate non-staging dir stays untouched.
    const realSkill = join(env.harnessDir, "keep-me");
    mkdirSync(realSkill, { recursive: true });

    // Crash window: staged proposal already has an extension_installs row.
    const prop = stageSkill(env, "global", "crashed-mid-commit");
    env.extensions.recordInstall({
      proposalId: prop.id,
      scope: prop.scope,
      kind: "skill",
      name: "crashed-mid-commit",
      location: join(env.harnessDir, "crashed-mid-commit"),
      files: [],
      digest: prop.digest,
    });

    env.service.cleanupStartup();

    expect(existsSync(globalLeftover)).toBe(false);
    expect(existsSync(projLeftover)).toBe(false);
    expect(lstatSync(realSkill).isDirectory()).toBe(true);
    expect(env.extensions.get(prop.id)?.status).toBe("installed");
  });
});
