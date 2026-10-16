import type { AgentCatalogEntry, LiveUpdate, McpOverview, MemoryNote, MemoryOverview, MemoryScope, Project, SettingsView, SkillEntry, SkillOrigin, StoredEvent, Thread, ThreadEvent, UnskilledApi } from "../../shared/types";
import type { ExpertDef } from "../../shared/experts";

/**
 * A fake backend for `bun run preview:ui`: the real renderer in a plain
 * browser, with canned data, so the UI can be looked at and screenshotted
 * without Electron or an agent. `?state=` picks a scene.
 */
/** Opens the settings sheet for the "settings" scene, once the store exists. */
function openSettingsSheet(): void {
  void import("./store").then(({ useStore }) => useStore.getState().setSettingsOpen(true));
}

export function installMock(): void {
  const params = new URLSearchParams(location.search);
  const scene = params.get("state") ?? "thread";
  const now = Date.now();
  const listeners = new Set<(u: LiveUpdate) => void>();
  const emit = (u: LiveUpdate) => listeners.forEach((l) => l(u));
  const openTerminals = new Set<string>();
  let settings: SettingsView = {
    theme: "system",
    defaultAgent: null,
    defaultPermissionMode: "ask",
    autoUpdate: true,
    editor: null,
    providers: [
      {
        id: "deepseek",
        label: "DeepSeek",
        wireProtocol: "openai-chat",
        baseURL: "https://api.deepseek.com",
        models: [],
        secretKind: "safeStorage",
        hasSecret: true,
      },
    ],
    providerCredential: {},
    migratedProviders: [],
    secretsEncrypted: true,
  };

  const projects: Project[] =
    scene === "welcome"
      ? []
      : [
          { id: "p1", path: "/Users/you/code/acme-web", name: "acme-web", createdAt: now, checkCommand: "bun run typecheck" },
          { id: "p2", path: "/Users/you/code/billing-service", name: "billing-service", createdAt: now },
        ];
  const t = (id: string, projectId: string, title: string, ago: number, agent = "claude"): Thread => ({
    id,
    projectId,
    agent,
    title,
    sessionId: "s-" + id,
    bindings: {},
    model: "opus",
    effort: null,
    permissionMode: "ask",
    createdAt: now - ago,
    updatedAt: now - ago,
  });
  const threads: Record<string, Thread[]> = {
    p1:
      scene === "project"
        ? []
        : [
            t("t1", "p1", "Add rate limiting to the login endpoint", 60_000),
            t("t2", "p1", "/domain-interview checkout redesign", 3_600_000, "opencode"),
            // Four days idle: Settled.
            t("t3", "p1", "Why is the settings page slow?", 4 * 86_400_000),
          ],
    p2: [t("t4", "p2", "/implement ticket 03: invoice PDFs", 7_200_000)],
  };

  const ev = (seq: number, event: ThreadEvent): StoredEvent => ({ seq, event, createdAt: now });
  const events: Record<string, StoredEvent[]> = {
    t1: [
      ev(1, { kind: "user", text: "Add rate limiting to the login endpoint: 5 attempts per minute per IP, then 429." }),
      ev(2, {
        kind: "assistant-text",
        text: "I'll look at how requests reach the login handler first, then add the limiter at the **highest seam**: the route middleware, so the handler itself stays untouched.",
      }),
      ev(3, { kind: "tool-use", toolUseId: "u1", name: "Grep", summary: "router.post\\(\"/login\"" }),
      ev(4, { kind: "tool-result", toolUseId: "u1", isError: false, summary: "src/routes/auth.ts:42" }),
      ev(5, { kind: "tool-use", toolUseId: "u2", name: "Read", summary: "src/routes/auth.ts" }),
      ev(6, { kind: "tool-result", toolUseId: "u2", isError: false, summary: "118 lines" }),
      ev(7, { kind: "tool-use", toolUseId: "u3", name: "Skill", summary: "skilled:tdd" }),
      ev(8, { kind: "tool-result", toolUseId: "u3", isError: false, summary: "Loaded" }),
      ev(9, { kind: "tool-use", toolUseId: "u4", name: "Write", summary: "src/middleware/rateLimit.test.ts" }),
      ev(10, { kind: "tool-result", toolUseId: "u4", isError: false, summary: "Created" }),
      ev(11, { kind: "tool-use", toolUseId: "u5", name: "Bash", summary: "npm test -- rateLimit" }),
      ev(12, { kind: "tool-result", toolUseId: "u5", isError: true, summary: "1 failing: returns 429 after 5 attempts" }),
      ev(13, { kind: "tool-use", toolUseId: "u6", name: "Edit", summary: "src/middleware/rateLimit.ts" }),
      ev(14, { kind: "tool-result", toolUseId: "u6", isError: false, summary: "Updated" }),
      ev(15, { kind: "tool-use", toolUseId: "u7", name: "Bash", summary: "npm test -- rateLimit" }),
      ev(16, { kind: "tool-result", toolUseId: "u7", isError: false, summary: "3 passed" }),
      ev(17, {
        kind: "assistant-text",
        text: [
          "Done. The limiter is a small middleware keyed by client IP, in `src/middleware/rateLimit.ts:3`:",
          "",
          "```ts",
          "export const loginLimiter = rateLimit({ windowMs: 60_000, max: 5 });",
          'router.post("/login", loginLimiter, login);',
          "```",
          "",
          "- The 6th attempt inside a minute gets `429 Too Many Requests` with a `Retry-After` header.",
          "- Tests cover the limit, the reset after the window, and separate IPs.",
          "",
          "One open question: behind your load balancer, `req.ip` is the proxy's address unless `trust proxy` is set. Want me to set it?",
        ].join("\n"),
      }),
      ev(18, { kind: "turn-end", costUsd: 0.184, inputTokens: 48_200, outputTokens: 2_150, durationMs: 41_300 }),
      ev(19, { kind: "thinking", text: "The limiter needs the real client IP, so check how the route resolves req.ip before choosing the middleware seam." }),
      ev(20, { kind: "thinking", text: "", signature: "sig", opaque: true }),
      ev(21, {
        kind: "plan",
        entries: [
          { content: "Read the auth routes", status: "completed" },
          { content: "Add the limiter", status: "in_progress" },
          { content: "Document trust proxy", status: "pending" },
        ],
      }),
      ev(22, { kind: "compaction", trigger: "auto", preTokens: 12400, postTokens: 4100 }),
    ],
  };

  // Sample skills across every origin, so the Library tab and the / menu show
  // project, harness, shared, bundled and legacy rows (and a shadowed one).
  let allSkills: SkillEntry[] = [
    { name: "browser", description: "Open pages, click, type, and read a snapshot in the browser pane.", invocation: "model", calls: [], files: ["SKILL.md"], sha256: "", origin: "bundled" },
    { name: "docx", description: "Create and edit .docx documents, with tracked changes and comments.", invocation: "model", calls: [], files: ["SKILL.md"], sha256: "", origin: "bundled" },
    { name: "release-notes", description: "Turn the merged PRs since the last tag into a changelog. Use when cutting a release.", invocation: "user", argumentHint: "<version>", calls: [], files: ["SKILL.md"], sha256: "", origin: "harness" },
    { name: "deploy-check", description: "Verify staging is green before a production deploy. Use when shipping.", invocation: "model", calls: [], files: ["SKILL.md"], sha256: "", origin: "project" },
    // Same name as the bundled docx, shadowed by it.
    { name: "docx", description: "Create and edit .docx documents, with tracked changes and comments.", invocation: "model", calls: [], files: ["SKILL.md"], sha256: "", origin: "shared", shadowedBy: "bundled" },
    { name: "pdf", description: "Read, split, merge, and fill PDF forms.", invocation: "model", calls: [], files: ["SKILL.md"], sha256: "", origin: "bundled", enabled: false },
    { name: "implement", description: "Build the work described by a spec or tickets, test-first at agreed seams.", invocation: "user", argumentHint: "[ticket or spec]", calls: ["browser"], files: ["SKILL.md"], sha256: "", origin: "legacy" },
  ];
  const agentCatalog: AgentCatalogEntry[] = [
    { id: "claude", label: "Claude", kind: "agent-sdk", command: null, installed: true, source: "built-in", skills: "As a plugin, named skilled:<name>, loaded when the task calls for it", mcp: "Stdio and HTTP servers, the browser tools in-process, plus Claude Code's own config" },
    { id: "codex", label: "Codex", kind: "app-server", command: "codex app-server", installed: false, source: "built-in", install: "npm install -g @openai/codex", skills: "As an extra skills folder, loaded when the task calls for it", mcp: "Stdio and HTTP servers, the browser tools, plus ~/.codex/config.toml" },
    { id: "antigravity", label: "Antigravity", kind: "acp", command: "agy_acp_server.par", installed: false, source: "built-in", install: "Google's ACP server (ACP registry: antigravity-acp): unzip it and put agy_acp_server.par on your PATH", homepage: "https://antigravity.google", optIn: true, skills: "", mcp: "HTTP servers only (the browser tools); it has no stdio MCP" },
    { id: "opencode", label: "OpenCode", kind: "acp", command: "opencode acp", installed: false, source: "built-in", install: "npm install -g opencode-ai", skills: "Not automatic: run `python3 install.py --model-only` from skilled in the project (it reads .agents/skills)", mcp: "Stdio servers, and HTTP ones (with the browser tools) when the agent supports them" },
  ];
  let mcp: McpOverview = {
    builtIn: {
      name: "cubiq",
      active: false,
      tools: [
        { name: "browser_open", description: "Open a URL in the browser pane", autoAllow: true },
        { name: "browser_snapshot", description: "Text snapshot with element refs", autoAllow: true },
        { name: "browser_click", description: "Click an element", autoAllow: true },
        { name: "browser_eval", description: "Run JavaScript in the page", autoAllow: false },
      ],
    },
    servers: [
      { name: "github", enabled: true, type: "stdio", target: "npx -y @modelcontextprotocol/server-github", envKeys: ["GITHUB_TOKEN"], headerKeys: [] },
      { name: "linear", enabled: false, type: "http", target: "https://mcp.linear.app/mcp", envKeys: [], headerKeys: ["Authorization"] },
    ],
    project: {
      servers: [
        { name: "postgres-local", enabled: true, type: "stdio", target: "npx -y @modelcontextprotocol/server-postgres", envKeys: ["DATABASE_URL"], headerKeys: [] },
        { name: "linear", enabled: true, type: "http", target: "https://mcp.linear.app/mcp", envKeys: [], headerKeys: ["Authorization"] },
      ],
      offGlobal: ["github"],
      file: "~/Library/Application Support/CubiQ/projects/p1/mcp.json",
    },
    external: [
      { name: "sentry", type: "http", target: "https://mcp.sentry.dev/mcp", agent: "Claude", source: "~/.claude.json" },
      { name: "postgres", type: "stdio", target: "uvx postgres-mcp --readonly", agent: "Claude", source: ".mcp.json" },
      { name: "fs", type: "stdio", target: "npx -y @modelcontextprotocol/server-filesystem ~/code", agent: "Codex", source: "~/.codex/config.toml" },
    ],
    file: "~/Library/Application Support/CubiQ/mcp.json",
  };

  // Mock agents get the declared-safe shape; the real capability matrix is main-side.
  const mockCapabilities = {
    mcpStdio: false,
    mcpHttp: false,
    preToolGuard: false,
    resume: false,
    fork: false,
    revert: false,
    compaction: false,
    perMessageModel: false,
    vision: false,
    webSearch: false,
    planMode: "emulated",
    interrupt: false,
    skillsDelivery: { mode: "none" },
    permissionGranularity: "modeOnly",
    guardEnforcement: { ask: "warnOnly", "auto-edit": "warnOnly", plan: "warnOnly", full: "warnOnly" },
    sandbox: "none",
  } as const;

  // Two sample notes, so the Memory tab has something to show in the preview.
  let memoryNotes: MemoryNote[] = [
    { file: "commit-style.md", name: "Commit Style", description: "Keep commit messages under 150 characters", type: "feedback" },
    { file: "deploy.md", name: "Deploy", description: "Run make deploy against staging before production", type: "project", updated: "2026-10-12" },
  ];
  // One global note about the user, shared by every project.
  let globalNotes: MemoryNote[] = [{ file: "terse-answers.md", name: "Terse answers", description: "Prefers short answers without preamble", type: "user", updated: "2026-10-13" }];
  const notesFor = (scope?: MemoryScope) => (scope === "global" ? globalNotes : memoryNotes);
  const setNotesFor = (scope: MemoryScope | undefined, next: MemoryNote[]) => {
    if (scope === "global") globalNotes = next;
    else memoryNotes = next;
  };
  const memoryView = (): MemoryOverview => ({
    enabled: true,
    projectOn: true,
    dir: "/Users/you/Library/Application Support/CubiQ/memory/projects/p1",
    index: { lines: memoryNotes.length + 1, tokens: 48 },
    notes: memoryNotes,
    global: globalNotes,
    block: { shown: memoryNotes.length + globalNotes.length, total: memoryNotes.length + globalNotes.length, tokens: 62 },
  });

  const api: UnskilledApi = {
    platform: params.get("platform") ?? "darwin",
    opaqueSidebar: params.has("opaque"),
    listProjects: async () => projects,
    addProject: async () => {
      const n = projects.length + 1;
      const project: Project = { id: `p${n}`, path: `/Users/you/code/new-project-${n}`, name: `new-project-${n}`, createdAt: Date.now() };
      projects.push(project);
      threads[project.id] = [];
      return project;
    },
    deleteProject: async (pid) => {
      const idx = projects.findIndex((p) => p.id === pid);
      if (idx >= 0) projects.splice(idx, 1);
      delete threads[pid];
    },
    relocateProject: async (pid) => {
      const project = projects.find((p) => p.id === pid);
      if (!project) throw new Error("no project");
      project.missing = false;
      return project;
    },
    setCheckCommand: async (pid, command, fixRounds) => {
      const project = projects.find((p) => p.id === pid);
      if (!project) throw new Error("no project");
      project.checkCommand = command;
      if (fixRounds !== undefined) project.checkFixRounds = fixRounds;
      return project;
    },
    listThreads: async (pid) => threads[pid] ?? [],
    createThread: async (pid, agent, opts) => {
      const th = t(`t${Math.random()}`, pid, "New thread", 0, agent ?? "claude");
      if (opts?.worktree) {
        th.branch = `harness/${pid}-${th.id.slice(0, 6)}`;
        th.worktreePath = `/Users/you/Library/Application Support/CubiQ/worktrees/${th.id}`;
      }
      if (opts?.kind === "design") {
        th.kind = "design";
        if (opts.designSystem) th.designSystem = opts.designSystem;
      }
      if (opts?.expertId) th.expertId = opts.expertId;
      threads[pid] = [th, ...(threads[pid] ?? [])];
      return th;
    },
    setPrototypeTier: async (id, tier) => {
      for (const list of Object.values(threads)) {
        const i = list.findIndex((x) => x.id === id);
        if (i >= 0) {
          const { prototypeTier: _old, ...rest } = list[i]!;
          return (list[i] = tier ? { ...rest, prototypeTier: tier } : rest);
        }
      }
      throw new Error("no thread");
    },
    setDesignSystem: async (id, system) => {
      for (const list of Object.values(threads)) {
        const i = list.findIndex((x) => x.id === id);
        if (i >= 0) {
          const { designSystem: _old, ...rest } = list[i]!;
          return (list[i] = system ? { ...rest, designSystem: system } : rest);
        }
      }
      throw new Error("no thread");
    },
    updateThread: async (id, patch) => {
      for (const list of Object.values(threads)) {
        const i = list.findIndex((x) => x.id === id);
        if (i >= 0) return (list[i] = { ...list[i]!, ...patch, updatedAt: Date.now() });
      }
      throw new Error("no thread");
    },
    deleteThread: async () => {},
    switchAgent: async (id, agent, mode) => {
      for (const list of Object.values(threads)) {
        const i = list.findIndex((x) => x.id === id);
        if (i >= 0) return { ok: true, mode, thread: (list[i] = { ...list[i]!, agent, updatedAt: Date.now() }) };
      }
      return { ok: false, reason: "no thread" };
    },
    browserDevice: async () => {},
    browserState: async () => ({ device: "desktop", logs: [], screenshots: [] }),
    browserTakeOver: async () => {},
    exportThread: async () => null,
    importThread: async () => null,
    exportSettings: async () => null,
    importSettings: async () => null,
    listEvents: async (id) => events[id] ?? [],
    listSkills: async () => allSkills.filter((s) => s.enabled !== false && !s.shadowedBy),
    listAgents: async () => [
      {
        id: "claude",
        label: "Claude",
        defaultModel: "opus",
        capabilities: mockCapabilities,
        models: [
          { id: "opus", label: "Opus 5.5", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high" },
          { id: "sonnet", label: "Sonnet 5", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high" },
          { id: "haiku", label: "Haiku 4.5" },
        ],
      },
    ],
    send: async () => {},
    interrupt: async () => {},
    respondPermission: async () => {},
    respondPlan: async () => {},
    respondQuestion: async () => {},
    pendingState: async () => ({ running: [], permissions: [], plans: [], questions: [] }),
    browserAttached: async () => {},
    browserPick: async () => {},
    terminalOpen: async (id) => {
      // Like the real main process, a second open of the same terminal reattaches.
      if (openTerminals.has(id)) return;
      openTerminals.add(id);
      setTimeout(() => emit({ type: "terminal-data", id, data: "\x1b[32m~/code/acme-web\x1b[0m on \x1b[35mmain\x1b[0m\r\n❯ npm test\r\n\r\n PASS  src/middleware/rateLimit.test.ts\r\n  ✓ allows 5 attempts (4 ms)\r\n  ✓ returns 429 on the 6th (2 ms)\r\n  ✓ resets after the window (1 ms)\r\n\r\nTests: 3 passed, 3 total\r\n\x1b[32m~/code/acme-web\x1b[0m on \x1b[35mmain\x1b[0m\r\n❯ " }), 50);
    },
    terminalWrite: () => {},
    getSettings: async () => settings,
    updateSettings: async (patch) => (settings = { ...settings, ...patch }),
    listProviders: async () => settings.providers,
    saveProvider: async (input, secret) => {
      const { secret: descriptor, ...fields } = input;
      const prev = settings.providers.find((p) => p.id === input.id);
      const view: SettingsView["providers"][number] = {
        ...fields,
        secretKind: typeof secret === "string" ? "safeStorage" : descriptor?.kind ?? prev?.secretKind ?? "safeStorage",
        hasSecret: secret === undefined ? prev?.hasSecret ?? false : secret !== null && secret.trim().length > 0,
      };
      settings = { ...settings, providers: [...settings.providers.filter((p) => p.id !== input.id), view] };
      return view;
    },
    removeProvider: async (id) => {
      settings = { ...settings, providers: settings.providers.filter((p) => p.id !== id) };
      return settings;
    },
    setProviderSecret: async (id, value) => {
      settings = {
        ...settings,
        providers: settings.providers.map((p) => (p.id === id ? { ...p, secretKind: value ? "safeStorage" : p.secretKind, hasSecret: value !== null && value.trim().length > 0 } : p)),
      };
      return settings;
    },
    testProvider: async () => {
      await new Promise((r) => setTimeout(r, 400));
      return { reachable: true, listsModels: true, supportsTools: true };
    },
    discoverProviderModels: async () => {
      await new Promise((r) => setTimeout(r, 400));
      const caps = { tools: true, vision: false, reasoning: true };
      return {
        ok: true,
        smallModel: "deepseek-v4-flash",
        models: [
          { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", capabilities: caps, contextWindow: 1_000_000, maxOutput: 65_536, cost: { input: 0.1, output: 0.4 }, enriched: true },
          { id: "glm-5.3", name: "GLM 5.3", capabilities: caps, contextWindow: 200_000, maxOutput: 32_768, cost: { input: 0.6, output: 2.2 }, enriched: true },
        ],
      };
    },
    searchProviderCatalog: async (query) => {
      const caps = { tools: true, vision: false, reasoning: true };
      const all = [
        { id: "minimax", name: "MiniMax (minimax.io)", wireProtocol: "anthropic-messages" as const, baseURL: "https://api.minimax.io/anthropic/v1", keyVar: "MINIMAX_API_KEY", docs: "https://platform.minimax.io/docs/guides/quickstart", models: [{ id: "MiniMax-M3", name: "MiniMax-M3", capabilities: caps, contextWindow: 1_000_000, maxOutput: 512_000, cost: { input: 0.3, output: 1.2, cacheRead: 0.06 }, enriched: true }] },
        { id: "openrouter", name: "OpenRouter", wireProtocol: "openai-chat" as const, baseURL: "https://openrouter.ai/api/v1", keyVar: "OPENROUTER_API_KEY", docs: "https://openrouter.ai/models", models: [] },
      ];
      const q = query.trim().toLowerCase();
      return all.filter((p) => !q || p.id.includes(q) || p.name.toLowerCase().includes(q));
    },
    openDataFolder: async () => {},
    listLimits: async () =>
      scene === "limits"
        ? [
            {
              agent: "claude",
              windows: [
                { id: "five_hour", label: "5-hour", usedPercent: 84, resetsAt: now + 95 * 60_000 },
                { id: "seven_day", label: "Weekly", usedPercent: 41, resetsAt: now + 3 * 86_400_000 },
              ],
              state: "warning" as const,
              plan: "max",
              updatedAt: now,
            },
          ]
        : [],
    listAllSkills: async () => allSkills,
    getSkillDetail: async (name) => {
      const skill = allSkills.find((x) => x.name === name)!;
      return {
        skill,
        dir: `/Applications/CubiQ.app/Contents/Resources/skilled/skills/${name}`,
        calledBy: allSkills.filter((x) => x.calls.includes(name)).map((x) => x.name),
        routes: agentCatalog
          .filter((a) => a.installed)
          .map((a) => ({ agent: a.label, how: skill.invocation === "user" ? "From the $ menu: the app puts the skill's text into your message" : a.skills })),
        body: `# ${name}\n\n${skill.description}\n\n## Steps\n\n1. Read the ticket and the code it touches.\n2. Agree the seam to test at, then write **one** failing test.\n3. Make it pass with the smallest change, then refactor.\n\n\`\`\`bash\nnpm test -- --watch\n\`\`\`\n\n- Stop and ask when the spec and the code disagree.\n- Never weaken a test to make it pass.`,
      };
    },
    setSkillEnabled: async (origin, name, enabled) => {
      allSkills = allSkills.map((s) => (s.origin === origin && s.name === name ? { ...s, enabled } : s));
      return allSkills;
    },
    getSkillFolders: async () => ({
      project: projects.length ? "/Users/you/code/acme-web/.agents/skills" : "",
      projectClaude: projects.length ? "/Users/you/code/acme-web/.claude/skills" : "",
      projectCubiq: projects.length ? "/Users/you/code/acme-web/.cubiq/skills" : "",
      harness: "/Users/you/Library/Application Support/CubiQ/skills",
      bundled: "/Applications/CubiQ.app/Contents/Resources/skilled/skills",
    }),
    createSkill: async (input) => {
      const origin: SkillOrigin = input.scope === "project" ? "projectCubiq" : "harness";
      allSkills.push({ name: input.name, description: input.description, invocation: "user", calls: [], files: ["SKILL.md"], sha256: "", origin });
      const dir = origin === "projectCubiq" ? "/Users/you/code/acme-web/.cubiq/skills" : "/Users/you/Library/Application Support/CubiQ/skills";
      return `${dir}/${input.name}/SKILL.md`;
    },
    listAgentCatalog: async () => agentCatalog,
    getMcp: async (projectId) => (projectId ? mcp : { ...mcp, project: null }),
    saveMcpServer: async (entry, previous, projectId) => {
      const view = {
        name: entry.name,
        enabled: entry.enabled,
        type: entry.spec.type,
        target: entry.spec.type !== "stdio" ? entry.spec.url : [entry.spec.command, ...(entry.spec.args ?? [])].join(" "),
        envKeys: entry.spec.type === "stdio" ? Object.keys(entry.spec.env ?? {}) : [],
        headerKeys: entry.spec.type !== "stdio" ? Object.keys(entry.spec.headers ?? {}) : [],
      };
      const kept = (projectId ? mcp.project?.servers ?? [] : mcp.servers).filter((x) => x.name !== (previous ?? entry.name));
      mcp = projectId
        ? { ...mcp, project: { ...mcp.project!, servers: [...kept, view] } }
        : { ...mcp, servers: [...kept, view] };
      return mcp;
    },
    removeMcpServer: async (name, projectId) => {
      mcp = projectId
        ? { ...mcp, project: { ...mcp.project!, servers: (mcp.project?.servers ?? []).filter((x) => x.name !== name) } }
        : { ...mcp, servers: mcp.servers.filter((x) => x.name !== name) };
      return mcp;
    },
    setMcpServerEnabled: async (name, enabled, projectId) => {
      const set = (x: McpOverview["servers"][number]) => (x.name === name ? { ...x, enabled } : x);
      mcp = projectId
        ? { ...mcp, project: { ...mcp.project!, servers: (mcp.project?.servers ?? []).map(set) } }
        : { ...mcp, servers: mcp.servers.map(set) };
      return mcp;
    },
    testMcpServer: async (name) => {
      await new Promise((r) => setTimeout(r, 400));
      return name === "github"
        ? { ok: true, tools: ["search_issues", "create_issue", "get_pull_request"].map((n) => ({ name: n, description: "" })) }
        : { ok: false, tools: [], error: "401 Unauthorized" };
    },
    setGlobalMcpOff: async (projectId, name, off) => {
      const offGlobal = off ? [...new Set([...(mcp.project?.offGlobal ?? []), name])] : (mcp.project?.offGlobal ?? []).filter((n) => n !== name);
      mcp = { ...mcp, project: { ...mcp.project!, offGlobal } };
      return mcp;
    },
    probeMcp: async (url) => {
      await new Promise((r) => setTimeout(r, 300));
      return url.includes("linear") ? { ok: true, transport: "http", auth: "oauth" } : { ok: true, transport: "http", auth: "none", serverName: "Mock" };
    },
    mcpStatus: async (projectId) =>
      (projectId ? (mcp.project?.servers ?? []) : mcp.servers).map((s) =>
        !s.enabled
          ? { name: s.name, state: "disabled" as const, tools: [] }
          : s.name === "github"
            ? { name: s.name, state: "connected" as const, tools: ["search_issues", "create_issue", "get_pull_request"].map((n) => ({ name: n, description: "" })) }
            : { name: s.name, state: "needs-auth" as const, tools: [], auth: { signedIn: false } },
      ),
    connectMcp: async () => {
      await new Promise((r) => setTimeout(r, 600));
      return { ok: true };
    },
    disconnectMcp: async () => mcp,
    setMcpClientSecret: async () => mcp,
    importMcp: async () => mcp,
    revealPath: async () => {},
    listEditors: async () => [
      { id: "cursor", label: "Cursor" },
      { id: "vscode", label: "VS Code" },
      { id: "zed", label: "Zed" },
      { id: "webstorm", label: "WebStorm" },
    ],
    openInEditor: async (target, editor) => {
      (window as unknown as { __opened?: unknown[] }).__opened = [...((window as unknown as { __opened?: unknown[] }).__opened ?? []), { ...target, editor }];
      return target.path.includes("missing") ? { ok: false, error: `${target.path} doesn't exist.` } : { ok: true, editor: editor ?? "cursor" };
    },
    updateStatus: async () => ({ current: "0.1.0", ready: scene === "update" ? "0.2.0" : null, supported: true }),
    aboutInfo: async () => ({
      name: "CubiQ",
      version: "0.1.2",
      commit: "abc1234",
      commitDate: "2026-09-27",
      electron: "44.4.5",
      chrome: "140.0.0.0",
      node: "22.19.0",
      os: "macOS 15.0",
      changelog: [
        { hash: "abc1234", date: "2026-09-27", subject: "Add the About sheet with a git build stamp" },
        { hash: "def5678", date: "2026-09-26", subject: "Keep the composer focused after a permission prompt" },
        { hash: "9a0b1c2", date: "2026-09-25", subject: "Show rate limits in the Message Center" },
      ],
    }),
    contextPreview: async () => ({
      guide: [{ source: "bundled", path: "CUBIQ.md", tokens: 1240 }],
      tools: [
        { name: "browser_open", tokens: 280 },
        { name: "browser_click", tokens: 190 },
      ],
      skills: { mode: "tool", count: 12, tokens: 640 },
      mcp: [{ name: "github", tools: 26, tokens: 5120, deferred: false }],
      memoryIndex: null,
    }),
    learnScores: async () => [],
    memoryOverview: async () => memoryView(),
    memoryRead: async (_projectId, file, scope) => {
      const note = notesFor(scope).find((n) => n.file === file);
      return note ? { ...note, body: `# ${note.name}\n\n${note.description}.` } : null;
    },
    memoryWrite: async (_projectId, note, scope) => {
      const slug = note.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "note";
      const file = note.file ?? `${slug}.md`;
      setNotesFor(scope, [...notesFor(scope).filter((n) => n.file !== file), { file, name: note.name, description: note.description, type: note.type, updated: "2026-10-14" }]);
      return file;
    },
    memoryDelete: async (_projectId, file, scope) => {
      const before = notesFor(scope).length;
      setNotesFor(scope, notesFor(scope).filter((n) => n.file !== file));
      return notesFor(scope).length < before;
    },
    memorySetEnabled: async (projectId, _on) => (projectId === null ? null : memoryView()),
    memoryImport: async () => 0,
    installUpdate: async () => {},
    terminalResize: () => {},
    terminalClose: async () => {},
    projectBranch: async () => (scene === "thread" ? "feat/rate-limit" : null),
    listFiles: async (_projectId, _threadId) => ({ files: ["README.md", "package.json", "src/app.ts", "src/middleware/rateLimit.ts", "src/middleware/rateLimit.test.ts", "src/routes/login.ts"], truncated: false }),
    getDiff: async (_projectId, _threadId) => [
      {
        path: "src/middleware/rateLimit.ts",
        status: "untracked",
        additions: 9,
        deletions: 0,
        hunks: [
          {
            header: "@@ new file @@",
            lines: [
              'import rateLimit from "express-rate-limit";',
              "",
              "export const loginLimiter = rateLimit({",
              "  windowMs: 60_000,",
              "  max: 5,",
              "  standardHeaders: true,",
              '  message: { error: "Too many login attempts. Try again in a minute." },',
              "});",
              "",
            ].map((text) => ({ kind: "add" as const, text })),
          },
        ],
      },
      {
        path: "src/routes/auth.ts",
        status: "modified",
        additions: 2,
        deletions: 1,
        hunks: [
          {
            header: "@@ -39,7 +39,8 @@ export function authRoutes(router: Router) {",
            lines: [
              { kind: "context", text: "  const login = makeLogin(users, sessions);" },
              { kind: "add", text: '  import { loginLimiter } from "../middleware/rateLimit";' },
              { kind: "del", text: '  router.post("/login", login);' },
              { kind: "add", text: '  router.post("/login", loginLimiter, login);' },
              { kind: "context", text: '  router.post("/logout", logout);' },
            ],
          },
        ],
      },
    ],
    onUpdate: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    search: async ({ text, projectId }) => {
      const words = text.toLowerCase().split(/\s+/).filter(Boolean);
      const all = Object.values(threads).flat().filter((t) => !projectId || t.projectId === projectId);
      const mark = (body: string): string | null => {
        const lower = body.toLowerCase();
        if (!words.length || !words.every((w) => lower.includes(w))) return null;
        const at = lower.indexOf(words[0]!);
        const start = Math.max(0, at - 40);
        const hit = body.slice(at, at + words[0]!.length);
        return (start > 0 ? "…" : "") + body.slice(start, at) + "\u0001" + hit + "\u0002" + body.slice(at + hit.length, at + 80);
      };
      const hit = (t: Thread, seq: number | null, kind: "title" | "user" | "assistant-text", snippet: string) =>
        ({ threadId: t.id, projectId: t.projectId, title: t.title, agent: t.agent, seq, kind, snippet, updatedAt: t.updatedAt });
      const found = all.flatMap((t) => {
        const title = mark(t.title);
        const messages = (events[t.id] ?? []).flatMap((e) => {
          if (e.event.kind !== "user" && e.event.kind !== "assistant-text") return [];
          const snippet = mark(e.event.text);
          return snippet ? [hit(t, e.seq, e.event.kind, snippet)] : [];
        });
        return [...(title ? [hit(t, null, "title", title)] : []), ...messages];
      });
      return { threads: found.filter((h) => h.kind === "title"), messages: found.filter((h) => h.kind !== "title") };
    },
    designEntry: async () => null,
    designPromote: async () => {},
    designKeepTweaks: async () => false,
    designSaveRef: async () => "designs/mock/refs/ref-1.png",
    designEditText: async () => {},
    designEditStyle: async () => {},
    designComments: async () => [],
    designCommentAdd: async () => [],
    designCommentUpdate: async () => [],
    designCommentDelete: async () => [],
    designWatch: async () => {},
    designUnwatch: async () => {},
    designReveal: async () => {},
    designExport: async () => null,
    listExperts: async () => mockExperts,
    getExpert: async (id) => mockExperts.find((e) => e.id === id) ?? null,
    importExperts: async () => ({ installed: [], candidates: [], skipped: [] }),
    removeExpert: async () => {},
    pickExpertSource: async () => null,
    setThreadExpert: async (id, expertId) => {
      for (const list of Object.values(threads)) {
        const i = list.findIndex((x) => x.id === id);
        if (i >= 0) {
          const { expertId: _old, ...rest } = list[i]!;
          return (list[i] = expertId ? { ...rest, expertId } : rest);
        }
      }
      throw new Error("no thread");
    },
    designSystems: async () => [
      { id: "clean", name: "Clean", description: "Neutral and calm: white surfaces, one blue accent, soft radii.", swatches: ["#ffffff", "#18181b", "#2563eb", "#0e7490"], source: "builtin" },
      { id: "dashboard", name: "Dashboard", description: "Dense and data-first.", swatches: ["#f6f7f9", "#111827", "#4f46e5", "#0e7490"], source: "builtin" },
      { id: "editorial", name: "Editorial", description: "Warm paper and a serif display face.", swatches: ["#fbf8f3", "#1f1a14", "#9a3412", "#1e3a5f"], source: "builtin" },
      { id: "mono", name: "Mono", description: "Black, white and one gray ramp.", swatches: ["#ffffff", "#0a0a0a", "#0a0a0a", "#404040"], source: "builtin" },
      { id: "playful", name: "Playful", description: "Bright and friendly, big radii.", swatches: ["#fffaf5", "#2a1b3d", "#7c3aed", "#c2410c"], source: "builtin" },
    ],
    listArtifacts: async (threadId) =>
      threadId === "t1"
        ? [
            { path: "src/middleware/rateLimit.ts", kind: "code", versions: [{ version: 1, sha256: "a1", bytes: 412, createdAt: now - 90_000, turnSeq: 18 }, { version: 2, sha256: "a2", bytes: 498, createdAt: now - 30_000, turnSeq: 18 }] },
            { path: "docs/rate-limit.md", kind: "md", versions: [{ version: 1, sha256: "b1", bytes: 300, createdAt: now - 30_000, turnSeq: 18 }] },
          ]
        : [],
    readArtifact: async (_threadId, path, version) =>
      path.endsWith(".md")
        ? { ok: true, path, kind: "md", bytes: 300, version: version ?? null, text: "# Login rate limit\n\nThe 6th attempt inside a minute gets **429**.\n\n| Setting | Value |\n|---|---|\n| window | 60 s |\n| max | 5 |\n" }
        : { ok: true, path, kind: "code", bytes: 498, version: version ?? null, text: 'import rateLimit from "express-rate-limit";\n\nexport const loginLimiter = rateLimit({ windowMs: 60_000, max: 5 });\n' },
    artifactDiff: async (_threadId, path) =>
      `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,3 +1,3 @@\n import rateLimit from "express-rate-limit";\n \n-export const loginLimiter = rateLimit({ windowMs: 60_000, max: 10 });\n+export const loginLimiter = rateLimit({ windowMs: 60_000, max: 5 });\n`,
  };
  window.unskilled = api;

  // Scenes that need live state once the app has subscribed.
  setTimeout(() => {
    if (scene === "settings") openSettingsSheet();
    if (scene.startsWith("library")) {
      const tab = scene === "library-mcp" ? "mcp" : scene === "library-agents" ? "agents" : "skills";
      void import("./store").then(({ useStore }) => useStore.setState({ libraryTab: tab, librarySkill: scene === "library" ? "implement" : null }));
    }
    if (scene === "artifact") emit({ type: "artifact-ready", threadId: "t1", path: "docs/rate-limit.md", files: ["src/middleware/rateLimit.ts", "docs/rate-limit.md"] });
    if (scene === "palette") void import("./store").then(({ useStore }) => useStore.getState().setPaletteOpen(true));
    if (scene === "running" || scene === "permission" || scene === "question") {
      emit({ type: "running", threadId: "t1", running: true });
      emit({ type: "delta", threadId: "t1", delta: { kind: "text-delta", itemId: "", text: "Setting `trust proxy` so the limiter sees the real client IP. I'll check how the app is" } });
    }
    if (scene === "permission") {
      emit({ type: "delta", threadId: "t1", delta: { kind: "text-delta", itemId: "", text: "" } });
      emit({
        type: "permission",
        request: { requestId: "r1", threadId: "t1", toolName: "Bash", summary: "npm install express-rate-limit@7", canAlwaysAllow: true },
      });
    }
    if (scene === "question") {
      emit({
        type: "question",
        request: {
          requestId: "q1",
          threadId: "t1",
          questions: [
            {
              id: "q0",
              header: "Store",
              question: "Where should the rate-limit counters live?",
              options: [
                { label: "Redis (Recommended)", description: "Shared across instances; needs REDIS_URL in every environment.", preview: "```ts\nnew RedisStore({ client })\n```" },
                { label: "In memory", description: "Zero setup, but each instance counts on its own." },
                { label: "Postgres", description: "Reuses the existing database; slower under load." },
              ],
              multiSelect: false,
              allowOther: true,
            },
            {
              id: "q1",
              header: "Routes",
              question: "Which routes get the limiter?",
              options: [
                { label: "Auth", description: "/login, /signup, /reset" },
                { label: "Public API", description: "/api/v1/*" },
                { label: "Everything", description: "Global middleware" },
              ],
              multiSelect: true,
              allowOther: true,
            },
          ],
        },
      });
    }
  }, 300);
}

/** A few experts for the UI preview (the app reads resources/experts). */
const mockExperts: ExpertDef[] = [
  { id: "data-analyst", kind: "agent", name: "Data Analyst", profession: "Senior Data Analyst", persona: "Daniel", category: "Data & AI", avatarText: "DA", description: "Turns raw data into clear analyses, SQL and dashboards that answer a specific business question.", tags: ["analytics", "sql"], quickPrompts: ["Write SQL to compute week-over-week active users by segment", "Analyze this CSV and summarize the trends that matter"], prompt: "You are Daniel.", skills: [], source: "builtin", version: "1.0.0" },
  { id: "frontend-developer", kind: "agent", name: "Frontend Developer", profession: "Senior Frontend Engineer", persona: "Fran", category: "Engineering", avatarText: "FD", description: "Builds accessible, fast interfaces in React and plain web platform code.", tags: ["react", "a11y"], quickPrompts: ["Build a responsive pricing table component with keyboard support"], prompt: "You are Fran.", skills: [], source: "builtin", version: "1.0.0" },
  { id: "copywriter", kind: "agent", name: "Copywriter", profession: "Senior Copywriter", persona: "Cleo", category: "Content & Creative", avatarText: "CW", description: "Writes clear, persuasive copy for pages, emails and ads in your brand voice.", tags: ["copy", "brand"], quickPrompts: ["Rewrite this landing page hero in three tones"], prompt: "You are Cleo.", skills: [], source: "builtin", version: "1.0.0" },
  {
    id: "software-delivery-team", kind: "team", name: "Software Delivery Team", profession: "Engineering Lead", persona: "Dana", category: "Engineering", avatarText: "SD", description: "Takes a feature from design through implementation, review and testing to a shippable change.", tags: ["engineering", "delivery"], quickPrompts: ["Design and build a rate limiter for our public API"], prompt: "You lead the team.", skills: [], source: "builtin", version: "1.0.0",
    members: [
      { id: "architect", name: "Architect", profession: "Software Architect", description: "Designs the change.", prompt: "", skills: [] },
      { id: "reviewer", name: "Reviewer", profession: "Code Reviewer", description: "Reviews it.", prompt: "", skills: [] },
    ],
  },
];
