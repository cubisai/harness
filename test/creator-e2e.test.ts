import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SAFE_DEFAULTS } from "../src/main/agents/capabilities";
import type { AgentDriver, HarnessTool, TurnInput } from "../src/main/agents/types";
import { chatsRoot } from "../src/main/chats";
import { CREATOR_PROPOSE_TOOL, creatorTools } from "../src/main/creator/tools";
import { Store } from "../src/main/db";
import { ExtensionService } from "../src/main/extensions/install";
import { ExtensionStore } from "../src/main/extensions/store";
import { BUILT_IN_SERVER, McpScopes, McpServerStore, viewOf } from "../src/main/mcp/servers";
import { McpVault } from "../src/main/mcp/vault";
import { Service } from "../src/main/service";
import type { SecretBox } from "../src/main/settings";
import { discoverSkills } from "../src/main/skills/discover";
import { SkillCatalogs } from "../src/main/skills/sources";
import type { McpOverview } from "../src/shared/types";
import { closeAfter, tempDir } from "./helpers";

const box: SecretBox = {
  available: true,
  encrypt: (s) => Buffer.from(`enc:${s}`).toString("base64"),
  decrypt: (b) => Buffer.from(b, "base64").toString().replace(/^enc:/, ""),
};

const SKILL_MD = "---\nname: conventional-commits\ndescription: Writes a Conventional Commits message.\n---\n\n# Conventional commits\n\nWrite `type(scope): subject` in the imperative.\n";

/**
 * The same wiring as index.ts (creatorToolsOf + ExtensionService), around a real Service and a fake driver:
 * a Creator turn proposes a skill, the user installs it, and a later ordinary chat turn can run it.
 */
function setup(turn: (input: TurnInput, tools: HarnessTool[]) => Promise<void>) {
  const root = tempDir();
  const userData = join(root, "userData");
  const projectDir = join(root, "project");
  mkdirSync(projectDir, { recursive: true });
  const cRoot = chatsRoot(userData);
  mkdirSync(cRoot, { recursive: true });
  const harnessDir = join(userData, "skills");
  mkdirSync(harnessDir, { recursive: true });
  const bundledDir = resolve("resources/skills");

  const store = new Store(join(userData, "app.db"));
  closeAfter(() => store.close());
  const extensions = new ExtensionStore(store.sql);
  const skills = new SkillCatalogs({ legacyRoot: null, bundledDir, harnessDir, disabled: () => [] });
  const vault = new McpVault(join(userData, "mcp-vault.json"), box);
  const mcpStore = new McpServerStore(join(userData, "mcp.json"), vault);
  const mcpProjectDir = (pid: string) => join(userData, "projects", pid);
  const mcpScopes = new McpScopes(mcpStore, mcpProjectDir, vault);
  const mcpOverview = (pid: string | null): McpOverview => ({
    builtIn: { name: BUILT_IN_SERVER, active: true, tools: [] },
    servers: mcpStore.list().map((e) => viewOf(e, vault, `global:${e.name}`)),
    project: pid ? { servers: mcpScopes.project(pid).list().map((e) => viewOf(e, vault, `${pid}:${e.name}`)), offGlobal: [], file: "" } : null,
    external: [],
    file: join(userData, "mcp.json"),
  });

  const prompts: string[] = [];
  let service!: Service;
  const toolsOf = (thread?: { id: string; preset?: "creator" }): HarnessTool[] =>
    thread?.preset === "creator"
      ? creatorTools(
          {
            creatorDir: resolve("resources/creator"),
            bundledSkillsDir: bundledDir,
            chatsRoot: cRoot,
            threadOf: (id) => store.getThread(id),
            projectOf: (id) => store.getProject(id),
            cwdOf: (t) => service.cwdOf(t),
            skillsForProject: (cwd) => skills.forProject(cwd),
            mcpOverview,
            extensions,
            emitProposal: (id, proposalId) => service.emitFromTool(id, { kind: "extension-proposal", proposalId }),
          },
          thread.id,
        )
      : [];
  const driver: AgentDriver = {
    id: "fake",
    label: "Fake",
    defaultModel: "fake-1",
    capabilities: SAFE_DEFAULTS,
    skillsDelivery: { mode: "none" },
    skillCallPrefix: "",
    models: () => [{ id: "fake-1", label: "Fake 1" }],
    async runTurn(input) {
      prompts.push(input.prompt);
      await turn(input, input.tools);
    },
  };
  service = new Service(store, (cwd) => skills.forProject(cwd), [driver], () => {}, (thread) => toolsOf(thread));

  const extensionService = new ExtensionService({
    extensions,
    projectOf: (id) => {
      try {
        return store.getProject(id);
      } catch {
        return null;
      }
    },
    allProjects: () => store.listProjects(),
    chatsRoot: cRoot,
    skillDirs: (p) => skills.dirs(p),
    bundledSkillNames: () => discoverSkills({ origin: "bundled", dir: bundledDir }).map((s) => s.name),
    invalidateSkills: () => skills.invalidate(),
    listMcpNames: (pid) => (pid ? mcpScopes.project(pid) : mcpStore).list().map((s) => s.name),
    saveMcp: async (entry, pid) => (pid ? mcpScopes.project(pid) : mcpStore).save(entry),
    removeMcp: async (name, pid) => (pid ? mcpScopes.project(pid) : mcpStore).remove(name),
    mcpFile: (pid) => (pid ? join(mcpProjectDir(pid), "mcp.json") : join(userData, "mcp.json")),
    emitNotice: (tid, text) => service.emitNotice(tid, text),
  });

  const project = store.addProject(projectDir);
  return { store, service, extensionService, skills, project, projectDir, prompts };
}

describe("Creator end to end (B9)", () => {
  it("a Creator turn proposes a skill, Install writes it, and a later chat in the project can run it", async () => {
    const results: { name: string; text: string; isError?: boolean }[] = [];
    const env = setup(async (input, tools) => {
      const propose = tools.find((t) => t.name === CREATOR_PROPOSE_TOOL);
      if (!propose) return;
      const r = await propose.run({ scope: "project", kind: "skill", name: "conventional-commits", description: "Writes a Conventional Commits message.", files: [{ path: "SKILL.md", content: SKILL_MD }] });
      results.push({ name: propose.name, text: r.text, isError: r.isError });
      input.onEvent({ kind: "assistant-text", text: "Proposed; waiting for you." });
    });
    const creator = env.service.createThread(env.project.id, undefined, "chat", null, null, "creator");
    await env.service.send({ threadId: creator.id, text: "Create a skill that writes conventional commit messages" });

    expect(results).toHaveLength(1);
    expect(results[0]!.isError).not.toBe(true);
    const proposalEvents = env.store.listEvents(creator.id).filter((e) => e.event.kind === "extension-proposal");
    expect(proposalEvents).toHaveLength(1);
    const proposalId = (proposalEvents[0]!.event as { proposalId: string }).proposalId;

    // Nothing is on disk or in the catalog until the user installs.
    expect(env.skills.forProject(env.projectDir).byName.has("conventional-commits")).toBe(false);
    expect(env.extensionService.getProposalView(proposalId)).toMatchObject({ status: "staged", draft: { kind: "skill", name: "conventional-commits" } });

    const installed = await env.extensionService.install(proposalId);
    expect(installed.status).toBe("installed");
    const notices = env.store.listEvents(creator.id).filter((e) => e.event.kind === "notice").map((e) => (e.event as { text: string }).text);
    expect(notices).toContain('Installed skill "conventional-commits" (project "project"). New turns can use it.');

    // An ordinary chat in the same project: no creator tools, and /conventional-commits resolves to the installed body.
    const chat = env.service.createThread(env.project.id);
    expect(chat.preset).toBeUndefined();
    await env.service.send({ threadId: chat.id, text: "write a commit message for: fixed login bug", skills: ["conventional-commits"] });
    expect(results).toHaveLength(1);
    expect(env.prompts.at(-1)).toContain('<skill name="conventional-commits"');
    expect(env.prompts.at(-1)).toContain("Write `type(scope): subject` in the imperative.");
  });

  it("a rejected proposal installs nothing and leaves a notice for the agent's next turn", async () => {
    const env = setup(async (_input, tools) => {
      const propose = tools.find((t) => t.name === CREATOR_PROPOSE_TOOL);
      await propose?.run({ scope: "project", kind: "skill", name: "conventional-commits", description: "Writes a Conventional Commits message.", files: [{ path: "SKILL.md", content: SKILL_MD }] });
    });
    const creator = env.service.createThread(env.project.id, undefined, "chat", null, null, "creator");
    await env.service.send({ threadId: creator.id, text: "make it" });
    const proposalId = (env.store.listEvents(creator.id).find((e) => e.event.kind === "extension-proposal")!.event as { proposalId: string }).proposalId;
    expect((await env.extensionService.reject(proposalId)).status).toBe("rejected");
    expect(env.skills.forProject(env.projectDir).byName.has("conventional-commits")).toBe(false);
    const last = env.store.listEvents(creator.id).at(-1)!.event;
    expect(last).toMatchObject({ kind: "notice", text: 'Rejected skill proposal "conventional-commits".' });
  });

  it("a connector install names the variables the user still has to set", async () => {
    const env = setup(async (_input, tools) => {
      const propose = tools.find((t) => t.name === CREATOR_PROPOSE_TOOL);
      const r = await propose?.run({
        scope: "global",
        kind: "connector",
        name: "github",
        spec: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_TOKEN}" } },
      });
      expect(r?.isError).not.toBe(true);
    });
    const creator = env.service.createThread(env.project.id, undefined, "chat", null, null, "creator");
    await env.service.send({ threadId: creator.id, text: "add github" });
    const proposalId = (env.store.listEvents(creator.id).find((e) => e.event.kind === "extension-proposal")!.event as { proposalId: string }).proposalId;
    expect(env.extensionService.getProposalView(proposalId)?.draft).toMatchObject({ kind: "connector", requiredVars: ["GITHUB_TOKEN"] });
    expect((await env.extensionService.install(proposalId)).status).toBe("installed");
    expect(env.store.listEvents(creator.id).at(-1)!.event).toMatchObject({
      kind: "notice",
      text: 'Installed connector "github" (global). New turns can use it. Set GITHUB_TOKEN in Library → Connectors before using it.',
    });
  });
});
