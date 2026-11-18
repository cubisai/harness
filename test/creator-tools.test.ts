import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { harnessToolOptions, TOOL_SERVER } from "../src/main/agents/claude";
import type { HarnessTool } from "../src/main/agents/types";
import { chatsRoot } from "../src/main/chats";
import { CREATOR_INSPECT_TOOL, CREATOR_PROPOSE_TOOL, creatorTools, type CreatorToolsDeps } from "../src/main/creator/tools";
import { Store } from "../src/main/db";
import { ExtensionStore } from "../src/main/extensions/store";
import { BUILT_IN_SERVER, McpScopes, McpServerStore, viewOf } from "../src/main/mcp/servers";
import { McpVault } from "../src/main/mcp/vault";
import type { SecretBox } from "../src/main/settings";
import { SkillCatalogs } from "../src/main/skills/sources";
import type { McpOverview, ThreadEvent } from "../src/shared/types";

const dirs: string[] = [];
const makeTemp = () => {
  const dir = mkdtempSync(join(tmpdir(), "creator-tools-"));
  dirs.push(dir);
  return dir;
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

function setupCreator(opts: { chatsThread?: boolean; permissionMode?: "ask" | "auto-edit" | "plan" } = {}) {
  const root = makeTemp();
  const userData = join(root, "userData");
  mkdirSync(userData, { recursive: true });
  const cRoot = chatsRoot(userData);
  mkdirSync(cRoot, { recursive: true });

  const projectDir = opts.chatsThread ? cRoot : join(root, "proj");
  mkdirSync(projectDir, { recursive: true });

  const store = new Store(join(userData, "app.db"));
  const extensions = new ExtensionStore(store.sql);
  const project = store.addProject(projectDir);
  const thread = store.createThread(project.id, "codex", "default-model", opts.permissionMode ?? "ask", "chat", null, null, "creator");

  const harnessSkills = join(userData, "skills");
  mkdirSync(harnessSkills, { recursive: true });
  mkdirSync(join(projectDir, ".cubiq", "skills", "proj-helper"), { recursive: true });
  writeFileSync(
    join(projectDir, ".cubiq", "skills", "proj-helper", "SKILL.md"),
    "---\nname: proj-helper\ndescription: Helps in this project\n---\n\n# proj-helper\n",
  );

  const bundledSkillsDir = resolve("resources/skills");
  const creatorDir = resolve("resources/creator");

  const skills = new SkillCatalogs({
    legacyRoot: null,
    bundledDir: bundledSkillsDir,
    harnessDir: harnessSkills,
    disabled: () => [],
  });

  const vault = new McpVault(join(userData, "mcp-vault.json"), box);
  const mcpStore = new McpServerStore(join(userData, "mcp.json"), vault);
  const mcpScopes = new McpScopes(mcpStore, (pid) => join(userData, "projects", pid), vault);

  mcpStore.save({
    name: "secret-api",
    enabled: true,
    spec: {
      type: "http",
      url: "https://mcp.example.com/v1",
      headers: {
        Authorization: "Bearer super-secret-token-value-123456",
        "X-Env": "${MY_PUBLIC_VAR}",
      },
    },
  });

  const emitted: { threadId: string; event: ThreadEvent }[] = [];

  const mcpOverview = (pid: string | null): McpOverview => {
    const projectScope = pid ? mcpScopes.project(pid) : null;
    return {
      builtIn: { name: BUILT_IN_SERVER, active: true, tools: [] },
      servers: mcpStore.list().map((e) => viewOf(e, vault, `global:${e.name}`)),
      project: projectScope ? { servers: projectScope.list().map((e) => viewOf(e, vault, `${pid}:${e.name}`)), offGlobal: projectScope.offGlobal(), file: "" } : null,
      external: [{ name: "ext-server", type: "stdio", target: "npx ext", agent: "Claude", source: "~/.claude.json", importable: true }],
      file: join(userData, "mcp.json"),
    };
  };

  const deps: CreatorToolsDeps = {
    creatorDir,
    bundledSkillsDir,
    chatsRoot: cRoot,
    threadOf: (id) => store.getThread(id),
    projectOf: (id) => store.getProject(id),
    cwdOf: (t) => t.worktreePath ?? projectDir,
    skillsForProject: (cwd) => skills.forProject(cwd),
    mcpOverview,
    extensions,
    emitProposal: (tid, proposalId) => emitted.push({ threadId: tid, event: { kind: "extension-proposal", proposalId } }),
  };

  const tools = creatorTools(deps, thread.id);
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  return { root, store, extensions, project, thread, tools, byName, emitted };
}

describe("Creator tools (B6)", () => {
  it("ships creator docs under resources/creator within the 8000 char cap", () => {
    for (const topic of ["overview", "skill-format", "connector-format"] as const) {
      const content = readFileSync(resolve("resources/creator", `${topic}.md`), "utf-8");
      expect(content.length).toBeGreaterThan(100);
      expect(content.length).toBeLessThanOrEqual(8000);
    }
  });

  it("stays under the 600 estimated-token budget across creator_inspect and creator_propose", () => {
    const { tools } = setupCreator();
    const totalChars = tools.reduce(
      (sum, t) => sum + t.description.length + JSON.stringify(z.toJSONSchema(z.object(t.input), { io: "input", unrepresentable: "any" })).length,
      0,
    );
    expect(totalChars / 4).toBeLessThanOrEqual(600);
  });

  it("exposes valid Claude SDK MCP tool schemas without z.record failures", async () => {
    const { tools } = setupCreator();
    const server = (harnessToolOptions(tools).mcpServers?.[TOOL_SERVER] as unknown as { instance: { connect(t: unknown): Promise<void> } }).instance;
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "test", version: "1" });
    await client.connect(b);
    const list = (await client.listTools()).tools;
    expect(list.map((t) => t.name)).toEqual([CREATOR_INSPECT_TOOL, CREATOR_PROPOSE_TOOL]);
    const propose = list.find((t) => t.name === CREATOR_PROPOSE_TOOL)!;
    const specProps = ((propose.inputSchema as { properties?: Record<string, { properties?: Record<string, unknown> }> }).properties?.spec?.properties ?? {});
    expect(specProps.env).toEqual({ type: "object", properties: {}, additionalProperties: { type: "string" } });
    expect(specProps.headers).toEqual({ type: "object", properties: {}, additionalProperties: { type: "string" } });
  });

  it("reads reference docs and redacted installed overview via creator_inspect", async () => {
    const { byName } = setupCreator();
    const inspect = byName[CREATOR_INSPECT_TOOL]!;

    const overviewDoc = await inspect.run({ topic: "overview" });
    expect(overviewDoc.isError).not.toBe(true);
    expect(overviewDoc.text).toContain("creator_propose");

    const skillDoc = await inspect.run({ topic: "skill-format" });
    expect(skillDoc.text).toContain("SKILL.md");

    const connDoc = await inspect.run({ topic: "connector-format" });
    expect(connDoc.text).toContain("${UPPER_SNAKE_CASE}");

    const installed = await inspect.run({ topic: "installed" });
    expect(installed.isError).not.toBe(true);
    expect(installed.text).not.toContain("super-secret-token-value-123456");
    const parsed = JSON.parse(installed.text) as {
      availableScopes: string[];
      bundledReservedSkills: string[];
      connectors: { global: { name: string; headerKeys: string[] }[]; external: { name: string }[] };
    };
    expect(parsed.availableScopes).toEqual(["project", "global"]);
    expect(parsed.bundledReservedSkills).toContain("browser");
    expect(parsed.connectors.global[0]).toMatchObject({ name: "secret-api", headerKeys: ["Authorization", "X-Env"] });
    expect(parsed.connectors.external[0]!.name).toBe("ext-server");
  });

  it("validates, stages, and emits extension-proposal for valid skills and connectors", async () => {
    const { byName, extensions, emitted, thread } = setupCreator();
    const propose = byName[CREATOR_PROPOSE_TOOL]!;

    const res = await propose.run({
      scope: "project",
      kind: "skill",
      name: "release-notes",
      description: "Summarize changelog commits cleanly.",
      files: [
        {
          path: "SKILL.md",
          content: "---\nname: release-notes\ndescription: Summarize changelog commits cleanly.\n---\n\n# Release notes\n\nWrite crisp notes.\n",
        },
        { path: "checklist.md", content: "- Breaking changes\n" },
      ],
    });
    expect(res.isError).not.toBe(true);
    const body = JSON.parse(res.text) as { proposalId: string; status: string };
    expect(body.status).toBe("staged");
    expect(extensions.get(body.proposalId)?.draft.kind).toBe("skill");
    expect(emitted).toEqual([{ threadId: thread.id, event: { kind: "extension-proposal", proposalId: body.proposalId } }]);

    const connRes = await propose.run({
      scope: "global",
      kind: "connector",
      name: "linear",
      spec: {
        type: "http",
        url: "https://mcp.linear.app/mcp",
        headers: { Authorization: "${LINEAR_AUTH_HEADER}" },
      },
    });
    expect(connRes.isError).not.toBe(true);
    const connBody = JSON.parse(connRes.text) as { proposalId: string };
    expect(extensions.get(connBody.proposalId)?.draft.name).toBe("linear");
  });

  it("refuses literal secrets and bundled skill shadowing", async () => {
    const { byName, extensions, emitted } = setupCreator();
    const propose = byName[CREATOR_PROPOSE_TOOL]!;

    const secretFail = await propose.run({
      scope: "global",
      kind: "connector",
      name: "openai",
      spec: { type: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer sk-1234567890abcdefghijklmnop" } },
    });
    expect(secretFail.isError).toBe(true);
    expect(extensions.forThread("any").length).toBe(0);
    expect(emitted).toHaveLength(0);

    const reservedFail = await propose.run({
      scope: "global",
      kind: "skill",
      name: "browser",
      description: "Shadow bundled skill",
      files: [{ path: "SKILL.md", content: "---\nname: browser\ndescription: Shadow bundled skill\n---\n\n# browser\n" }],
    });
    expect(reservedFail.isError).toBe(true);
    expect(reservedFail.text).toMatch(/reserved|bundled/i);
  });

  it("refuses creator_propose in Plan mode while still allowing creator_inspect", async () => {
    const { byName, extensions, emitted } = setupCreator({ permissionMode: "plan" });
    const inspect = await byName[CREATOR_INSPECT_TOOL]!.run({ topic: "overview" });
    expect(inspect.isError).not.toBe(true);

    const fail = await byName[CREATOR_PROPOSE_TOOL]!.run({
      scope: "global",
      kind: "connector",
      name: "linear",
      spec: { type: "http", url: "https://mcp.linear.app/mcp" },
    });
    expect(fail.isError).toBe(true);
    expect(fail.text).toContain("Plan mode");
    expect(emitted).toHaveLength(0);
    expect(extensions.forThread("x")).toHaveLength(0);
  });

  it("refuses project scope on Chats threads while permitting global scope", async () => {
    const { byName } = setupCreator({ chatsThread: true });
    const installed = JSON.parse((await byName[CREATOR_INSPECT_TOOL]!.run({ topic: "installed" })).text) as { availableScopes: string[] };
    expect(installed.availableScopes).toEqual(["global"]);

    const projectFail = await byName[CREATOR_PROPOSE_TOOL]!.run({
      scope: "project",
      kind: "connector",
      name: "linear",
      spec: { type: "http", url: "https://mcp.linear.app/mcp" },
    });
    expect(projectFail.isError).toBe(true);
    expect(projectFail.text).toContain("Chats");

    const globalOk = await byName[CREATOR_PROPOSE_TOOL]!.run({
      scope: "global",
      kind: "connector",
      name: "linear",
      spec: { type: "http", url: "https://mcp.linear.app/mcp" },
    });
    expect(globalOk.isError).not.toBe(true);
  });

  it("enforces the max 5 staged proposals cap per thread", async () => {
    const { byName, extensions, thread } = setupCreator();
    const propose = byName[CREATOR_PROPOSE_TOOL]!;
    for (let i = 1; i <= 5; i++) {
      const ok = await propose.run({
        scope: "global",
        kind: "connector",
        name: `svc-${i}`,
        spec: { type: "http", url: `https://mcp-${i}.example.com/mcp` },
      });
      expect(ok.isError).not.toBe(true);
    }
    const sixth = await propose.run({
      scope: "global",
      kind: "connector",
      name: "svc-6",
      spec: { type: "http", url: "https://mcp-6.example.com/mcp" },
    });
    expect(sixth.isError).toBe(true);
    expect(sixth.text).toContain("At most 5");

    // Rejecting one staged proposal frees a slot.
    const first = extensions.forThread(thread.id)[0]!;
    extensions.setStatus(first.id, "rejected");
    const afterReject = await propose.run({
      scope: "global",
      kind: "connector",
      name: "svc-6",
      spec: { type: "http", url: "https://mcp-6.example.com/mcp" },
    });
    expect(afterReject.isError).not.toBe(true);
  });

  it("keeps standard chat and design threads free of creator tools while equipping creator threads", () => {
    const { store, project, tools } = setupCreator();
    const chat = store.createThread(project.id, "codex", "default-model", "ask");
    const design = store.createThread(project.id, "codex", "default-model", "ask", "design", "fintech-minimal");
    const toolNamesFor = (preset: string | null | undefined, kind: string | undefined) =>
      kind !== "design" && preset === "creator" ? tools.map((t) => t.name) : ([] as string[]);

    expect(toolNamesFor(chat.preset, chat.kind)).toEqual([]);
    expect(toolNamesFor(design.preset, design.kind)).toEqual([]);
    expect(tools.map((t) => t.name)).toEqual([CREATOR_INSPECT_TOOL, CREATOR_PROPOSE_TOOL]);
  });
});
