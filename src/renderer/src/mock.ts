import type { AgentCatalogEntry, LiveUpdate, McpOverview, Project, SettingsView, SkillEntry, StoredEvent, Thread, ThreadEvent, UnskilledApi } from "../../shared/types";

/**
 * A fake backend for `npm run preview:ui`: the real renderer in a plain
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
    providerInjection: {},
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
          { id: "p1", path: "/Users/you/code/acme-web", name: "acme-web", createdAt: now },
          { id: "p2", path: "/Users/you/code/billing-service", name: "billing-service", createdAt: now },
        ];
  const t = (id: string, projectId: string, title: string, ago: number): Thread => ({
    id,
    projectId,
    agent: "claude",
    title,
    sessionId: "s-" + id,
    model: "opus",
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
            t("t2", "p1", "/domain-interview checkout redesign", 3_600_000),
            t("t3", "p1", "Why is the settings page slow?", 86_400_000),
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

  const skills: SkillEntry[] = [
    ["skilled", "Which skill fits your situation. A router over everything in the skilled set."],
    ["skilled-setup", "Configure a repo: issue tracker, triage labels, domain docs. Once per repo."],
    ["domain-interview", "A relentless interview to sharpen a plan or design, which also creates docs."],
    ["clarify-requirements", "A relentless interview to sharpen a plan or design before any code is written."],
    ["design-doc", "Research and write a pre-spec architecture doc, for work big enough to need one."],
    ["write-spec", "Turn the current conversation into a spec and publish it to the issue tracker."],
    ["write-tickets", "Break a plan, spec, or the conversation into tracer-bullet tickets."],
    ["implement", "Build the work described by a spec or tickets, test-first at agreed seams."],
    ["implement-spec", "Implement a whole spec on one branch, one PR."],
    ["triage", "Move issues through the triage state machine."],
    ["handoff", "Compact this conversation into a handoff document."],
    ["retro", "Review a finished session and propose fixes to the agent environment."],
  ].map(([name, description]) => ({
    name: name!,
    description: description!,
    invocation: "user" as const,
    calls: [],
    files: ["SKILL.md"],
    sha256: "",
  }));

  const modelSkills: SkillEntry[] = [
    ["tdd", "Test-driven development at agreed seams: one failing test, the smallest change that passes, then refactor."],
    ["review-diff", "Review a diff for bugs, missing tests, and risky changes before it ships."],
    ["verify-in-browser", "Check a UI change in a real browser, with a snapshot and a screenshot per criterion."],
    ["git-guardrails", "Blocks destructive git commands before they run."],
  ].map(([name, description]) => ({ name: name!, description: description!, invocation: "model" as const, calls: [], files: ["SKILL.md"], sha256: "" }));
  const allSkills = [...skills.map((s) => (s.name === "implement" ? { ...s, calls: ["tdd", "review-diff"], argumentHint: "[ticket or spec]", files: ["SKILL.md", "references/seams.md"] } : s)), ...modelSkills];
  const agentCatalog: AgentCatalogEntry[] = [
    { id: "claude", label: "Claude", kind: "agent-sdk", command: null, installed: true, source: "built-in", skills: "As a plugin, named skilled:<name>, loaded when the task calls for it", mcp: "Stdio and HTTP servers, the browser tools in-process, plus Claude Code's own config" },
    { id: "deepseek", label: "DeepSeek", kind: "acp", command: "dsh --profile acp", installed: true, source: "built-in", skills: "Through DSH_BUNDLED_SKILL_DIR, loaded when the task calls for it", mcp: "Stdio servers, and HTTP ones (with the browser tools) when the agent supports them" },
    { id: "codex", label: "Codex", kind: "app-server", command: "codex app-server", installed: false, source: "built-in", install: "npm install -g @openai/codex", skills: "As an extra skills folder, loaded when the task calls for it", mcp: "Stdio and HTTP servers, the browser tools, plus ~/.codex/config.toml" },
    { id: "antigravity", label: "Antigravity", kind: "acp", command: "agy-acp", installed: false, source: "built-in", install: "npm install -g agy-acp", homepage: "https://github.com/shindgew/agy-acp", skills: "Not automatic: run `python3 install.py --model-only` from skilled in the project (it reads .agents/skills)", mcp: "Stdio servers, and HTTP ones (with the browser tools) when the agent supports them" },
    { id: "opencode", label: "OpenCode", kind: "acp", command: "opencode acp", installed: false, source: "built-in", install: "npm install -g opencode-ai", skills: "Not automatic: run `python3 install.py --model-only` from skilled in the project (it reads .agents/skills)", mcp: "Stdio servers, and HTTP ones (with the browser tools) when the agent supports them" },
  ];
  let mcp: McpOverview = {
    builtIn: {
      name: "unskilled",
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
    external: [
      { name: "sentry", type: "http", target: "https://mcp.sentry.dev/mcp", agent: "Claude", source: "~/.claude.json" },
      { name: "postgres", type: "stdio", target: "uvx postgres-mcp --readonly", agent: "Claude", source: ".mcp.json" },
      { name: "fs", type: "stdio", target: "npx -y @modelcontextprotocol/server-filesystem ~/code", agent: "Codex", source: "~/.codex/config.toml" },
    ],
    file: "~/Library/Application Support/UnSkilled/mcp.json",
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
    planMode: false,
    interrupt: false,
    skillsDelivery: { mode: "none" },
    permissionGranularity: "modeOnly",
    guardEnforcement: { ask: "warnOnly", "auto-edit": "warnOnly", full: "warnOnly" },
    sandbox: "none",
  } as const;

  const api: UnskilledApi = {
    platform: params.get("platform") ?? "darwin",
    listProjects: async () => projects,
    addProject: async () => null,
    listThreads: async (pid) => threads[pid] ?? [],
    createThread: async (pid) => {
      const th = t(`t${Math.random()}`, pid, "New thread", 0);
      threads[pid] = [th, ...(threads[pid] ?? [])];
      return th;
    },
    updateThread: async (id, patch) => {
      for (const list of Object.values(threads)) {
        const i = list.findIndex((x) => x.id === id);
        if (i >= 0) return (list[i] = { ...list[i]!, ...patch, updatedAt: Date.now() });
      }
      throw new Error("no thread");
    },
    deleteThread: async () => {},
    listEvents: async (id) => events[id] ?? [],
    listSkills: async () => skills,
    listAgents: async () => [
      {
        id: "claude",
        label: "Claude",
        defaultModel: "opus",
        capabilities: mockCapabilities,
        models: [
          { id: "opus", label: "Opus 5.5" },
          { id: "sonnet", label: "Sonnet 5" },
          { id: "haiku", label: "Haiku 4.5" },
        ],
      },
      {
        id: "deepseek",
        label: "DeepSeek",
        defaultModel: "default",
        capabilities: mockCapabilities,
        models: [
          { id: "default", label: "Agent default" },
          { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
          { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
        ],
      },
    ],
    send: async () => {},
    interrupt: async () => {},
    respondPermission: async () => {},
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
      const providerCredential: SettingsView["providerCredential"] = {};
      for (const [agent, choice] of Object.entries(settings.providerCredential)) {
        providerCredential[agent] = choice.kind === "byok" && choice.providerId === id ? { kind: "subscription" } : choice;
      }
      settings = { ...settings, providers: settings.providers.filter((p) => p.id !== id), providerCredential };
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
    setCredential: async (agentId, choice) => (settings = { ...settings, providerCredential: { ...settings.providerCredential, [agentId]: choice } }),
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
        dir: `/Applications/UnSkilled.app/Contents/Resources/skilled/skills/${name}`,
        calledBy: allSkills.filter((x) => x.calls.includes(name)).map((x) => x.name),
        routes: agentCatalog
          .filter((a) => a.installed)
          .map((a) => ({ agent: a.label, how: skill.invocation === "user" ? "From the / menu: the app puts the skill's text into your message" : a.skills })),
        body: `# ${name}\n\n${skill.description}\n\n## Steps\n\n1. Read the ticket and the code it touches.\n2. Agree the seam to test at, then write **one** failing test.\n3. Make it pass with the smallest change, then refactor.\n\n\`\`\`bash\nnpm test -- --watch\n\`\`\`\n\n- Stop and ask when the spec and the code disagree.\n- Never weaken a test to make it pass.`,
      };
    },
    listAgentCatalog: async () => agentCatalog,
    getMcp: async () => mcp,
    saveMcpServer: async (entry, previous) => {
      const view = {
        name: entry.name,
        enabled: entry.enabled,
        type: entry.spec.type,
        target: entry.spec.type === "http" ? entry.spec.url : [entry.spec.command, ...(entry.spec.args ?? [])].join(" "),
        envKeys: entry.spec.type === "stdio" ? Object.keys(entry.spec.env ?? {}) : [],
        headerKeys: entry.spec.type === "http" ? Object.keys(entry.spec.headers ?? {}) : [],
      };
      mcp = { ...mcp, servers: [...mcp.servers.filter((x) => x.name !== (previous ?? entry.name)), view] };
      return mcp;
    },
    removeMcpServer: async (name) => (mcp = { ...mcp, servers: mcp.servers.filter((x) => x.name !== name) }),
    setMcpServerEnabled: async (name, enabled) => (mcp = { ...mcp, servers: mcp.servers.map((x) => (x.name === name ? { ...x, enabled } : x)) }),
    testMcpServer: async (name) => {
      await new Promise((r) => setTimeout(r, 400));
      return name === "github"
        ? { ok: true, tools: ["search_issues", "create_issue", "get_pull_request"].map((n) => ({ name: n, description: "" })) }
        : { ok: false, tools: [], error: "401 Unauthorized" };
    },
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
    installUpdate: async () => {},
    terminalResize: () => {},
    terminalClose: async () => {},
    getDiff: async () => [
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
  };
  window.unskilled = api;

  // Scenes that need live state once the app has subscribed.
  setTimeout(() => {
    if (scene === "settings") openSettingsSheet();
    if (scene.startsWith("library")) {
      const tab = scene === "library-mcp" ? "mcp" : scene === "library-agents" ? "agents" : "skills";
      void import("./store").then(({ useStore }) => useStore.setState({ libraryTab: tab, librarySkill: scene === "library" ? "implement" : null }));
    }
    if (scene === "palette") void import("./store").then(({ useStore }) => useStore.getState().setPaletteOpen(true));
    if (scene === "running" || scene === "permission") {
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
  }, 300);
}
