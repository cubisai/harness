import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, release, tmpdir, type as osType } from "node:os";
import { basename, delimiter, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BrowserWindow, Menu, app, dialog, ipcMain, nativeTheme, net, protocol, safeStorage, shell } from "electron";
import type { AboutInfo, AgentLimits, ContextPreview, CredentialChoice, DevicePreset, LiveUpdate, McpOverview, McpServerEntry, MemoryType, OpenResult, PermissionDecision, PlanDecision, ProviderInput, ScreenshotInfo, SendRequest, Settings, SkillOrigin, SkillsDelivery, SwitchMode, Thread } from "../shared/types";
import { spawnSync } from "node:child_process";
import { createAcpDriver } from "./agents/acp/driver";
import { warmBinaries } from "./agents/binaries";
import { createClaudeDriver, resolvePackagedClaudeBinary } from "./agents/claude";
import { createCodexDriver } from "./agents/codex";
import { acpCapabilities, CLAUDE_CAPABILITIES, CODEX_CAPABILITIES } from "./agents/capabilities";
import { LimitsTracker } from "./agents/limits";
import { LimitsRefresher } from "./limits-refresher";
import { loadAcpAgents, onPath } from "./agents/registry";
import { BrowserController, isAllowedUrl } from "./browser/controller";
import { browserTools } from "./browser/tools";
import { Store } from "./db";
import { migrateLegacyData } from "./migrate-data";
import { startToolServer, type ToolServer } from "./mcp-http";
import { TerminalManager } from "./terminal";
import { Service } from "./service";
import { catalogFor, testConnection } from "./providers";
import { injectionFor } from "./inject";
import { redactSecrets } from "./inject/redact";
import { codexInstructions, prepareCodexPlan } from "./inject/codex";
import { opencodeVariants, opencodeVersion, withOpenCodeVariant } from "./inject/opencode";
import { ensureOpenCodeGuard, withOpenCodeGuard } from "./inject/opencode-guard";
import { BUILT_IN_GUARD, findPython } from "./guard";
import { createGuide } from "./guide";
import { buildContextPreview, mcpRow, skillsOf, toolTokens } from "./context-preview";
import { createMemory, memoryOn, memoryPrompt } from "./memory";
import { createMemoryApi } from "./memory/api";
import { createExtractor } from "./memory/extractor";
import { MEMORY_READ_TOOL, memoryReadTool } from "./memory/tool";
import { SettingsStore } from "./settings";
import { agentCatalog, skillDetail } from "./library";
import { fillUserEnvironment } from "./winspawn";
import { referenceEvents } from "./canonical-events";
import { smokeCanonicalEvents, smokeHandoff, smokeMigration, smokeProviders } from "./smoke-checks";
import { Editors, realHost } from "./editors";
import { readExternalMcp } from "./mcp/external";
import { BUILT_IN_SERVER, McpScopes, McpServerStore, McpToolsCache, testServer, viewOf } from "./mcp/servers";
import { MCP_ROUTER_MIN_TOOLS, McpClientPool, routerTools } from "./mcp/router";
import { providerWarning } from "../shared/provider-rules";
import { Updater, type UpdaterBackend } from "./updater";
import { defaultSkillsCandidates, findSkillsRoot } from "./skills/catalog";
import { ensureModelSkillsDir, ensurePlugin } from "./skills/plugin";
import { SkillCatalogs, forAgent } from "./skills/sources";
import { skillTool } from "./skills/tool";

const here = fileURLToPath(new URL(".", import.meta.url));
const smoke = process.argv.includes("--smoke");

/**
 * Apps launched from the Dock get launchd's PATH, not the shell's, so
 * `npm -g` tools (codex, opencode) never resolve. Prepend the
 * usual user bin dirs before any agent detection or spawn.
 */
function augmentPath(env: NodeJS.ProcessEnv = process.env): void {
  const home = homedir();
  const extras = [
    join(home, ".local/bin"),
    join(home, ".bun/bin"),
    join(home, "Library/pnpm"),
    // fnm's stable alias for the active Node: where `npm install -g` puts bins.
    join(home, ".local/share/fnm/aliases/default/bin"),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
  ];
  const current = (env.PATH ?? env.Path ?? "").split(delimiter);
  const prefix = extras.filter((dir) => !current.includes(dir) && existsSync(dir));
  if (!prefix.length) return;
  env.PATH = [...prefix, ...current].join(delimiter);
  env.Path = env.PATH;
}

/**
 * electron-updater, where the app can update itself: packaged builds on
 * macOS and Windows, and the AppImage on Linux. Never in dev or smoke runs.
 */
async function updaterBackend(): Promise<UpdaterBackend | null> {
  if (!app.isPackaged || smoke || process.env.UNSKILLED_NO_UPDATE) return null;
  if (process.platform === "linux" && !process.env.APPIMAGE) return null;
  const { default: updater } = await import("electron-updater");
  return updater.autoUpdater;
}

/** build/icon.png, shipped next to the app's resources in a packaged build. */
function appIcon(): string {
  return app.isPackaged ? join(process.resourcesPath, "icon.png") : join(app.getAppPath(), "build", "icon.png");
}

function createWindow(): BrowserWindow {
  const isMac = process.platform === "darwin";
  const isWin = process.platform === "win32";
  // Mica needs Windows 11 (build 22000+); without it a transparent window shows through as grey.
  const mica = isWin && Number(release().split(".")[2] ?? 0) >= 22000;
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 880,
    minHeight: 560,
    show: false,
    title: "CubiQ",
    // macOS and Windows take the icon from the app bundle; Linux window managers read it from here.
    icon: process.platform === "linux" ? appIcon() : undefined,
    // A frameless-looking window on every OS: traffic lights inset on macOS,
    // native caption buttons overlaid on Windows and Linux.
    titleBarStyle: isMac ? "hiddenInset" : "hidden",
    trafficLightPosition: isMac ? { x: 16, y: 18 } : undefined,
    titleBarOverlay: isMac
      ? undefined
      : { color: "#00000000", symbolColor: nativeTheme.shouldUseDarkColors ? "#f5f5f7" : "#1d1d1f", height: 52 },
    vibrancy: isMac ? "sidebar" : undefined,
    visualEffectState: isMac ? "followWindow" : undefined,
    backgroundMaterial: mica ? "mica" : undefined,
    backgroundColor: isMac || mica ? "#00000000" : nativeTheme.shouldUseDarkColors ? "#1c1c1e" : "#f5f5f7",
    webPreferences: {
      preload: join(here, "../preload/index.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true, // the browser pane
      // No vibrancy or Mica behind the window: the renderer paints the sidebar opaque.
      additionalArguments: [...(isMac || mica ? [] : ["--opaque-sidebar"]), ...(smoke ? ["--unskilled-smoke"] : [])],
    },
  });
  // The browser pane's <webview> gets no preload, no Node, and only web URLs.
  win.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    if (params.src && !isAllowedUrl(params.src)) event.preventDefault();
  });
  win.once("ready-to-show", () => {
    if (!smoke) win.show();
  });
  // Links open in the user's browser, never inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(join(here, "../renderer/index.html"));
  }
  return win;
}

async function main(): Promise<void> {
  // The app was renamed: adopt a pre-rename data folder (threads, settings,
  // keys, skills) before anything reads userData, and before ready, while
  // Chromium hasn't opened its own files in the new folder. Not for an
  // explicit --user-data-dir (the caller chose the folder) or a smoke run.
  if (!smoke && !app.commandLine.hasSwitch("user-data-dir")) {
    try {
      const migrated = migrateLegacyData({ appData: app.getPath("appData"), target: app.getPath("userData"), legacyNames: ["AI Harness", "UnSkilled"] });
      if (migrated) console.log(`migrated data folder from ${migrated}`);
    } catch (err) {
      console.warn("data folder migration failed", err);
    }
  }

  // Registered before ready: unskilled-shot:// serves saved screenshots to the
  // renderer's <img>. A standard scheme so the file name is the URL host.
  protocol.registerSchemesAsPrivileged([{ scheme: "unskilled-shot", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
  await app.whenReady();
  // A dev run is the stock Electron binary: give its Dock tile the app's own icon.
  if (process.platform === "darwin" && !app.isPackaged) app.dock?.setIcon(appIcon());

  const userData = app.getPath("userData");
  mkdirSync(userData, { recursive: true });
  const shotsDir = join(userData, "screenshots");
  const shotInfo = (path: string): ScreenshotInfo => ({ path, url: `unskilled-shot://${basename(path).toLowerCase()}` });
  // Only bare .png names inside the screenshots folder: nothing else is reachable.
  protocol.handle("unskilled-shot", (req) => {
    const u = new URL(req.url);
    const name = decodeURIComponent(u.hostname || u.pathname.replace(/^\/+/, "")).toLowerCase();
    if (!/^[\w.-]+\.png$/.test(name)) return new Response(null, { status: 404 });
    return net.fetch(pathToFileURL(join(shotsDir, name)).toString());
  });
  const store = new Store(join(userData, "unskilled.db"));
  const memory = createMemory({ root: join(userData, "memory", "projects"), home: homedir(), codexHome: process.env.CODEX_HOME || undefined });
  const settings = new SettingsStore(join(userData, "settings.json"), {
    // On Linux, isEncryptionAvailable() is true even with the plain-text fallback backend.
    available: safeStorage.isEncryptionAvailable() && (process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text"),
    encrypt: (s) => safeStorage.encryptString(s).toString("base64"),
    decrypt: (b) => safeStorage.decryptString(Buffer.from(b, "base64")),
  });
  // The Library's memory tab: notes, the enable switches, and a re-run of the import.
  const memoryApi = createMemoryApi({
    memory,
    settings,
    projectPath: (pid) => store.getProject(pid).path,
    home: homedir(),
    codexHome: process.env.CODEX_HOME || undefined,
  });
  // Provider keys reach an agent only through its own injection plan (src/main/inject);
  // this is the list every stored or broadcast event is scrubbed of. Cached, and
  // reset whenever a provider or credential changes.
  let secretsCache: string[] | null = null;
  const knownSecrets = () =>
    (secretsCache ??= settings
      .providers()
      .map((p) => settings.providerSecret(p.id))
      .filter((s): s is string => Boolean(s)));
  nativeTheme.themeSource = settings.get().theme;
  const root = findSkillsRoot(
    defaultSkillsCandidates({ resourcesPath: app.isPackaged ? process.resourcesPath : undefined, appPath: app.getAppPath() }),
  );
  const harnessDir = join(userData, "skills");
  mkdirSync(harnessDir, { recursive: true });
  const skills = new SkillCatalogs({
    legacyRoot: root,
    bundledDir: app.isPackaged ? join(process.resourcesPath, "skills") : join(app.getAppPath(), "resources", "skills"),
    harnessDir,
    disabled: () => settings.get().skills?.disabled ?? [],
  });
  /**
   * The skills listing one agent carries for a cwd, priced the same by the
   * Context sheet and the first-turn breakdown. Null when the agent takes no
   * skills. "tool" mode's list is built once, so the tool and the names it
   * lists can't disagree.
   */
  const skillsInputFor = (delivery: SkillsDelivery | undefined, cwd: string | null) => {
    if (!delivery) return null;
    const toolSkills = forAgent(skills.global(), { mode: "tool", reads: ["project", "shared"] });
    return {
      mode: delivery.mode,
      entries: skills.forProject(cwd).modelSkills.map(({ name, description }) => ({ name, description })),
      tool: delivery.mode === "tool" ? skillTool(() => toolSkills) : undefined,
      toolNames: toolSkills.map((s) => s.name),
    };
  };
  const windows = new Set<BrowserWindow>();
  const broadcast = (update: LiveUpdate) => {
    for (const w of windows) if (!w.isDestroyed()) w.webContents.send("unskilled:update", update);
  };
  // macOS needs its own app menu for "About CubiQ" to reach the in-app sheet;
  // elsewhere the default menu stands. Built after `broadcast`, which it uses.
  if (process.platform === "darwin") {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: "CubiQ",
          submenu: [
            { label: "About CubiQ", click: () => broadcast({ type: "open-about" }) },
            { type: "separator" },
            { role: "services" },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit" },
          ],
        },
        { role: "fileMenu" },
        { role: "editMenu" },
        { role: "viewMenu" },
        { role: "windowMenu" },
      ]),
    );
  }
  // Plan rate limits: pushed by agents during turns and read on demand by the
  // refresher (launch, window focus, and a slow interval) so they survive
  // restarts, stay fresh while idle, and clear once a window resets.
  const limits = new LimitsTracker(
    (l) => broadcast({ type: "limits", limits: l }),
    {
      load: () => {
        try {
          const raw: unknown = JSON.parse(readFileSync(join(userData, "limits.json"), "utf8"));
          return Array.isArray(raw) ? (raw as AgentLimits[]) : [];
        } catch {
          return [];
        }
      },
      save: (all) => {
        try {
          writeFileSync(join(userData, "limits.json"), JSON.stringify(all));
        } catch {
          // A missing folder or full disk isn't worth failing a turn over.
        }
      },
    },
  );
  // The skills library's Python script when there is one; otherwise the same rules built in (guard-rules.ts), so the guard is always on.
  const guardScript = root?.skillsDir ? join(root.skillsDir, "git-guardrails", "scripts", "block-dangerous-git.py") : BUILT_IN_GUARD;
  // One guide for every agent: the app's, the user's, then the project's, stable for the session.
  const guide = createGuide({
    bundled: app.isPackaged ? join(process.resourcesPath, "HARNESS.md") : join(app.getAppPath(), "resources", "HARNESS.md"),
    global: join(userData, "HARNESS.md"),
  });
  const driver = createClaudeDriver({
    guide: (cwd) => guide.forCwd(cwd),
    pluginDir: (cwd) =>
      ensurePlugin(
        forAgent(
          skills.forProject(cwd),
          CLAUDE_CAPABILITIES.skillsDelivery,
          // Claude Code loads these itself; the plugin would list them twice.
          skills.namesIn([join(homedir(), ".claude", "skills"), join(cwd, ".claude", "skills")]),
        ),
        join(userData, "harness-plugin", createHash("sha256").update(cwd).digest("hex").slice(0, 12)),
      ),
    guardScript,
    memoryDir: (projectId) => (memoryOn(settings.get(), projectId) ? memory.ensure(projectId, store.getProject(projectId).path) : null),
    onLimits: limits.for("claude"),
    injection: () => injectionFor(settings, "claude", process.env, { injector: "claude" }),
    byokModels: () => {
      const c = settings.credential("claude");
      if (c.kind !== "byok") return null;
      const p = settings.providers().find((x) => x.id === c.providerId);
      return p ? catalogFor(p).claude.models : null;
    },
  });
  const browser = new BrowserController(
    (url) => broadcast({ type: "browser-open", url }),
    shotsDir,
    (text) => broadcast({ type: "browser-picked", text }),
    {
      onLog: (entry) => broadcast({ type: "browser-log", entry }),
      onScreenshot: (path) => broadcast({ type: "browser-screenshot", shot: shotInfo(path) }),
      onDevice: (device) => broadcast({ type: "browser-device", device }),
      onAction: (action, ref, url) => broadcast({ type: "browser-action", action, ref, url }),
    },
  );
  const tools = browserTools(browser);
  const memoryTool = memoryReadTool({ store: memory.store, enabled: (pid) => memoryOn(settings.get(), pid) });
  // A stable array identity: the tool list must not change mid-conversation.
  const allTools = [...tools, memoryTool];
  // The memory block for agents without native memory, or null when it's off. Never throws: memory must not block a turn.
  const memoryPromptFor = (projectId: string): string | null => {
    try {
      if (!memoryOn(settings.get(), projectId)) return null;
      memory.ensure(projectId, store.getProject(projectId).path);
      return memoryPrompt(memory.store.index(projectId).text);
    } catch {
      return null;
    }
  };
  // Launched from an older terminal, the app would miss user variables agents read (a provider key in OpenCode's config).
  fillUserEnvironment();
  augmentPath();
  // Claude first (the default for new threads), then any installed ACP agents.
  // Opt-in agents (Antigravity) start only after Settings recorded the acknowledgement; a change applies on restart.
  const { agents: acpAgents, custom: customAgents, problems } = loadAcpAgents(join(userData, "agents.json"), undefined, {
    optedIn: settings.antigravityEnabled(),
  });
  for (const p of problems) console.warn(p);
  const modelSkillsDir = join(userData, "harness-skills");
  // Always offered: adding them when the tab opens would rewrite the prompt prefix and reload the session.
  const harnessTools = () => allTools;
  // Started on first use, for Codex and ACP agents, which take tools over MCP.
  let toolServer: Promise<ToolServer> | null = null;
  // `/mcp-skills` adds the skill tool for agents in "tool" delivery mode.
  const getToolServer = () =>
    (toolServer ??= startToolServer(harnessTools, () => [skillTool(() => forAgent(skills.global(), { mode: "tool", reads: ["project", "shared"] }))], (pid) => routedTools(pid)));
  const drivers = [
    driver,
    // Codex when it's installed: the same model-invoked skills as an extra skills root, and the browser tools over MCP.
    ...(onPath("codex")
      ? [
          createCodexDriver({
            command: "codex",
            args: ["app-server"],
            clientVersion: app.getVersion(),
            guardScript,
            guide: (cwd) => guide.forCwd(cwd),
            memory: memoryPromptFor,
            extensions: extensionsFor("codex"),
            skillsDir: () => ensureModelSkillsDir(forAgent(skills.global(), CODEX_CAPABILITIES.skillsDelivery), modelSkillsDir),
            toolServer: getToolServer,
            onLimits: limits.for("codex"),
            injection: () =>
              prepareCodexPlan(
                injectionFor(settings, "codex", process.env, {
                  injector: "codex",
                  codexCatalogDir: join(userData, "codex-catalogs"),
                  codexInstructions: () => codexInstructions("codex"),
                }),
                "codex",
              ),
            byokModels: () => {
              const c = settings.credential("codex");
              if (c.kind !== "byok") return null;
              const p = settings.providers().find((x) => x.id === c.providerId);
              return p ? catalogFor(p).codex.models.map((m) => ({ id: String(m.slug), label: String(m.display_name) })) : null;
            },
          }),
        ]
      : []),
    ...acpAgents.map((config) => {
      // OpenCode can't ask before every shell command, so its guard is a plugin
      // injected into its config; with one, the git guardrail blocks in every mode.
      // OpenCode's guard is a plugin that runs the Python script itself, so it needs a real script file.
      const python = config.guardPlugin === "opencode" && guardScript !== BUILT_IN_GUARD ? findPython() : null;
      const driverConfig =
        python && config.guardPlugin === "opencode"
          ? { ...config, capabilities: { ...config.capabilities, preToolGuard: true, guardEnforcement: { ask: "block" as const, "auto-edit": "block" as const, plan: "block" as const, full: "block" as const } } }
          : config;
      return createAcpDriver(driverConfig, {
        skillsDir: () => ensureModelSkillsDir(forAgent(skills.global(), acpCapabilities(config).skillsDelivery), modelSkillsDir),
        clientVersion: app.getVersion(),
        toolServer: getToolServer,
        guardScript,
        guide: (cwd) => guide.forCwd(cwd),
        memory: memoryPromptFor,
        extensions: extensionsFor(config.id),
        mcpRouting: (_pid, servers) => mcpRoutingFor(servers),
        ...(config.effortVia === "opencode-variants" ? { variants: () => opencodeVariants(config.command) } : {}),
        injection: (ctx) => {
          let plan = injectionFor(settings, config.id, process.env, {
            injector: config.injector ?? "acp",
            keyVar: config.keyVar,
            providerEnvOnly: config.providerEnvOnly,
            agentLabel: config.label,
            ...(config.injector === "opencode" ? { opencodeVersion: () => opencodeVersion(config.command) } : {}),
          });
          if (python && config.guardPlugin === "opencode") {
            plan = withOpenCodeGuard(plan, { pluginUrl: ensureOpenCodeGuard(join(userData, "opencode")), script: guardScript, python });
          }
          // After the guard, so both the plugin and the variant survive.
          if (ctx?.effort) plan = withOpenCodeVariant(plan, ctx.effort);
          return plan;
        },
      });
    }),
  ];
  // Resolve each installed CLI once in the background: the `--version` probes
  // are slow for some installs, so the Library's binary rows fill in without
  // blocking startup. Best-effort: a missing CLI just isn't warmed.
  const warmCommands = [
    "claude",
    "codex",
    ...acpAgents.filter((a) => !a.command.includes("/") && !a.command.includes("\\") && onPath(a.command)).map((a) => a.command),
  ];
  void warmBinaries(warmCommands)
    .then(() => broadcast({ type: "agents" }))
    .catch(() => {});
  // Read limits on demand for whichever drivers can be asked (they expose
  // readLimits; the rest are skipped). The tracker seeds from disk and the
  // first check runs shortly after launch.
  const refresher = new LimitsRefresher({
    drivers: drivers.map((d) => ({ agent: d.id, readLimits: d.readLimits?.bind(d) })),
    tracker: limits,
  });
  const limitsTimer = setInterval(() => void refresher.tick(), 60_000);
  limitsTimer.unref?.();
  const firstLimitsCheck = setTimeout(() => void refresher.tick(), 10_000);
  firstLimitsCheck.unref?.();
  app.on("browser-window-focus", () => {
    refresher.setActive(true);
    void refresher.onFocus();
  });
  app.on("browser-window-blur", () => {
    if (!BrowserWindow.getFocusedWindow()) refresher.setActive(false);
  });
  // Model lists that only appear once an agent has run: ask for them now so
  // the picker isn't empty on first open. Each driver notifies when ready.
  for (const d of drivers) {
    void (d.refreshModels?.() ?? Promise.resolve()).finally(() => broadcast({ type: "agents" }));
  }
  const mcpStore = new McpServerStore(join(userData, "mcp.json"));
  const mcpProjectDir = (projectId: string) => join(userData, "projects", projectId);
  const mcpScopes = new McpScopes(mcpStore, mcpProjectDir);
  // The enabled servers' tool schemas, for the Context sheet; listed on demand.
  const mcpTools = new McpToolsCache();
  // One connection per routed MCP server, kept warm between calls and closed on quit.
  const mcpPool = new McpClientPool();
  /** The two router tools bound to the calling project's servers; only called when a session routes. */
  const routedTools = (projectId?: string) => routerTools({ servers: (pid) => mcpScopes.effective(pid ?? null), listings: mcpTools, pool: mcpPool }, projectId);
  /** Whether a project's listed MCP tools reach the router threshold, for agents without native tool search. */
  async function mcpRoutingFor(servers: McpServerEntry[]): Promise<boolean> {
    if (settings.get().mcpRouter === "off") return false;
    await mcpTools.refresh(servers);
    const count = servers.reduce((sum, s) => sum + (mcpTools.peek(s.spec)?.ok ? (mcpTools.peek(s.spec)?.tools.length ?? 0) : 0), 0);
    return count >= MCP_ROUTER_MIN_TOOLS;
  }
  const service = new Service(
    store,
    (cwd: string | null) => skills.forProject(cwd),
    drivers,
    broadcast,
    harnessTools,
    () => {
      const s = settings.get();
      return { agent: s.defaultAgent, permissionMode: s.defaultPermissionMode };
    },
    (projectId) => mcpScopes.effective(projectId),
    knownSecrets,
    join(userData, "worktrees"),
  );
  // After a Codex/ACP turn, extract memory in the background; Claude keeps its own.
  const extractor = createExtractor({
    store: memory.store,
    enabled: (pid) => memoryOn(settings.get(), pid),
    driverFor: (id) => drivers.find((d) => d.id === id),
  });
  service.setTurnListener((d) => extractor.schedule(d));

  // The Library: skills, agents, and MCP servers, as the agents will see them.
  const catalogOfAgents = () =>
    agentCatalog({
      installed: (c) => onPath(c),
      custom: customAgents,
      liveCapabilities: (id) => service.listAgents().find((a) => a.id === id)?.capabilities,
    });
  const projectPathOf = (projectId: string | null) => {
    try {
      return projectId ? store.getProject(projectId).path : null;
    } catch {
      return null;
    }
  };
  const mcpOverview = (projectId: string | null): McpOverview => {
    const projectScope = projectId ? mcpScopes.project(projectId) : null;
    return {
      builtIn: {
        name: BUILT_IN_SERVER,
        active: browser.enabled,
        tools: tools.map((t) => ({ name: t.name, description: t.description, autoAllow: t.autoAllow })),
      },
      servers: mcpStore.list().map(viewOf),
      project: projectScope
        ? { servers: projectScope.list().map(viewOf), offGlobal: projectScope.offGlobal(), file: join(mcpProjectDir(projectId!), "mcp.json") }
        : null,
      external: readExternalMcp({ projectPath: projectPathOf(projectId) }),
      file: join(userData, "mcp.json"),
    };
  };
  ipcMain.handle("library:skills", (_e, projectId?: string) => skills.forProject(projectPathOf(projectId ?? null)).all);
  ipcMain.handle("library:skill", (_e, name: string, projectId?: string) => {
    const cwd = projectPathOf(projectId ?? null);
    // Claude Code's own skill folders, the same ones its plugin skips (see pluginDir above); plugin delivery = Claude Code.
    const claudeOwn = skills.namesIn([join(homedir(), ".claude", "skills"), ...(cwd ? [join(cwd, ".claude", "skills")] : [])]);
    return skillDetail(skills.forProject(cwd), name, catalogOfAgents(), (a) => (a.capabilities?.skillsDelivery.mode === "plugin" ? claudeOwn : new Set()));
  });
  ipcMain.handle("skills:set-enabled", (_e, origin: SkillOrigin, name: string, enabled: boolean) => {
    const key = `${origin}:${name}`;
    const current = settings.get().skills?.disabled ?? [];
    const disabled = enabled ? current.filter((k) => k !== key) : [...new Set([...current, key])];
    settings.update({ skills: { disabled } });
    skills.invalidate();
    return skills.forProject(null).all;
  });
  ipcMain.handle("skills:folders", (_e, projectId?: string) => skills.dirs(projectPathOf(projectId ?? null)));
  ipcMain.handle("skills:create", (_e, input: { scope: "harness" | "project"; projectId?: string | null; name: string; description: string }) => {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.name)) throw new Error("A skill name is lowercase letters, digits and dashes, up to 64 characters.");
    const dirs = skills.dirs(projectPathOf(input.projectId ?? null));
    const base = input.scope === "project" ? dirs.project : dirs.harness;
    if (!base) throw new Error("Pick a project before creating a project skill.");
    const folder = join(base, input.name);
    if (existsSync(folder)) throw new Error(`A skill named ${input.name} already exists.`);
    mkdirSync(folder, { recursive: true });
    const file = join(folder, "SKILL.md");
    // JSON string syntax is valid YAML, so a description with ": " or quotes can't break the frontmatter.
    const description = JSON.stringify(input.description.replace(/\s+/g, " ").trim());
    writeFileSync(file, `---\nname: ${input.name}\ndescription: ${description}\n---\n\n# ${input.name}\n\nDescribe what the agent should do.\n`);
    skills.invalidate();
    return file;
  });
  ipcMain.handle("library:agents", () => catalogOfAgents());
  ipcMain.handle("mcp:get", (_e, projectId: string | null) => mcpOverview(projectId));
  ipcMain.handle("mcp:save", (_e, entry: McpServerEntry, previousName?: string, projectId?: string | null) => {
    (projectId ? mcpScopes.project(projectId) : mcpStore).save(entry, previousName);
    return mcpOverview(projectId ?? null);
  });
  ipcMain.handle("mcp:remove", (_e, name: string, projectId?: string | null) => {
    (projectId ? mcpScopes.project(projectId) : mcpStore).remove(name);
    return mcpOverview(projectId ?? null);
  });
  ipcMain.handle("mcp:enable", (_e, name: string, enabled: boolean, projectId?: string | null) => {
    (projectId ? mcpScopes.project(projectId) : mcpStore).setEnabled(name, enabled);
    return mcpOverview(projectId ?? null);
  });
  ipcMain.handle("mcp:test", async (_e, name: string, projectId?: string | null) => {
    const store = projectId ? mcpScopes.project(projectId) : mcpStore;
    const entry = store.list().find((s) => s.name === name);
    return entry ? testServer(entry.spec) : { ok: false, tools: [], error: "No such server." };
  });
  // A project can switch off an individual global server without editing either file.
  ipcMain.handle("mcp:global-off", (_e, projectId: string, name: string, off: boolean) => {
    mcpScopes.project(projectId).setGlobalOff(name, off);
    return mcpOverview(projectId);
  });
  // Open in editor. The agents' API keys (set from Settings) stay out of the editor's environment.
  const editors = new Editors(realHost(), () => settings.secretEnvNames());
  ipcMain.handle("editors:list", () => editors.list());
  ipcMain.handle(
    "editors:open",
    async (_e, target: { projectId: string | null; path: string; line?: number; column?: number }, editorId?: string): Promise<OpenResult> => {
      const base = projectPathOf(target.projectId);
      const raw = target.path.startsWith("~/") ? join(homedir(), target.path.slice(2)) : target.path;
      const path = isAbsolute(raw) ? raw : base ? resolve(base, raw) : null;
      if (!path || !existsSync(path)) return { ok: false, error: `${target.path} doesn't exist.` };
      const line = Number.isInteger(target.line) && target.line! > 0 ? target.line : undefined;
      const column = line && Number.isInteger(target.column) && target.column! > 0 ? target.column : undefined;
      const res = await editors.open({ path, line, column }, editorId ?? settings.get().editor);
      // Picking an editor makes it the default from then on.
      if (res.ok && editorId && editorId !== settings.get().editor) {
        settings.update({ editor: editorId });
        broadcast({ type: "settings", settings: settings.view() });
      }
      return res;
    },
  );
  ipcMain.handle("app:reveal", (_e, path: string) => {
    if (typeof path === "string" && existsSync(path)) shell.showItemInFolder(path);
  });

  const updater = new Updater(
    await updaterBackend(),
    app.getVersion(),
    () => settings.get().autoUpdate,
    (status) => broadcast({ type: "app-update", status }),
    (message) => console.warn(message),
  );
  updater.start();

  ipcMain.handle("settings:get", () => settings.view());
  ipcMain.handle("settings:update", (_e, patch: Partial<Settings>) => {
    const before = settings.get().autoUpdate;
    const next = settings.update(patch);
    nativeTheme.themeSource = next.theme;
    if (next.autoUpdate !== before) updater.refresh();
    const view = settings.view();
    broadcast({ type: "settings", settings: view });
    return view;
  });
  // A changed provider changes what the next agent process inherits; running
  // processes keep the old environment, so stop them and re-broadcast settings.
  const afterProviderChange = () => {
    secretsCache = null;
    service.dispose();
    const view = settings.view();
    broadcast({ type: "settings", settings: view });
    return view;
  };
  ipcMain.handle("providers:list", () => settings.providers().map((p) => settings.providerView(p)));
  ipcMain.handle("providers:save", (_e, input: ProviderInput, secret?: string | null) => {
    const view = settings.saveProvider(input, secret);
    afterProviderChange();
    return view;
  });
  ipcMain.handle("providers:remove", (_e, id: string) => {
    settings.removeProvider(id);
    return afterProviderChange();
  });
  ipcMain.handle("providers:secret", (_e, id: string, value: string | null) => {
    settings.setProviderSecret(id, value);
    return afterProviderChange();
  });
  ipcMain.handle("providers:test", (_e, id: string, modelId: string) => {
    const provider = settings.providers().find((p) => p.id === id);
    if (!provider) throw new Error(`unknown provider ${id}`);
    return testConnection(provider, modelId, settings.providerSecret(id));
  });
  ipcMain.handle("providers:setCredential", (_e, agentId: string, choice: CredentialChoice) => {
    settings.setCredential(agentId, choice);
    return afterProviderChange();
  });
  ipcMain.handle("app:open-data-folder", () => shell.openPath(userData));
  ipcMain.handle("app:about", (): AboutInfo => {
    // Read lazily: vitest runs this module without electron-vite's define.
    const build = typeof __CUBIQ_BUILD__ !== "undefined" ? __CUBIQ_BUILD__ : { commit: null, date: null, changelog: [] };
    return {
      name: "CubiQ",
      version: app.getVersion(),
      commit: build.commit,
      commitDate: build.date,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      os: process.platform === "darwin" ? `macOS ${process.getSystemVersion()}` : `${osType()} ${release()}`,
      changelog: build.changelog,
    };
  });
  // MCP tool search defers schemas to a lookup: still on for Claude's own login
  // and a first-party key (a custom gateway drops it), Codex only on its own login.
  /** The enabled servers' listed tool count from the cache, without listing (0 when nothing is cached). */
  const listedToolCount = (servers: McpServerEntry[]): number =>
    servers.reduce((sum, s) => sum + (mcpTools.peek(s.spec)?.ok ? (mcpTools.peek(s.spec)?.tools.length ?? 0) : 0), 0);
  /** Whether this driver's session reaches the app's MCP router: capability on, setting not off, enough tools listed. */
  const mcpRouted = (driver: (typeof drivers)[number] | undefined, servers: McpServerEntry[]): boolean =>
    driver?.capabilities.mcpRouter === true && settings.get().mcpRouter !== "off" && listedToolCount(servers) >= MCP_ROUTER_MIN_TOOLS;
  const mcpDeferred = (driver: (typeof drivers)[number] | undefined, servers: McpServerEntry[]): boolean => {
    if (mcpRouted(driver, servers)) return true;
    const mode = driver?.capabilities.skillsDelivery.mode;
    if (!driver || (mode !== "plugin" && mode !== "extraRoots")) return false;
    const c = settings.credential(driver.id);
    if (c.kind === "subscription") return true;
    if (mode !== "plugin") return false;
    const p = settings.providers().find((x) => x.id === c.providerId);
    return !!p && providerWarning(p, "claude") === null;
  };
  /**
   * The skills and MCP-tool tokens a driver's fresh session carries, for the
   * estimated first-turn breakdown. Hoisted so the driver configs, built before
   * the mcp declarations below, can reference it; it only runs during a turn,
   * after setup, so those references are safe.
   */
  function extensionsFor(driverId: string): (cwd: string, projectId: string | null) => { skills: number; mcp: number } {
    return (cwd, projectId) => {
      const driver = drivers.find((d) => d.id === driverId);
      const servers = mcpScopes.effective(projectId).filter((s) => s.enabled === true);
      void mcpTools.refresh(servers); // warm the cache; never awaited here
      // A routed session pays only for the two router tools, not every server's schemas.
      const mcp = mcpRouted(driver, servers)
        ? routedTools(projectId ?? undefined).reduce((sum, t) => sum + toolTokens(t), 0)
        : mcpDeferred(driver, servers)
          ? 0
          : servers.reduce((sum, s) => sum + (mcpRow(s.name, mcpTools.peek(s.spec), false).tokens ?? 0), 0);
      const delivery = driver?.capabilities.skillsDelivery;
      const skills = delivery ? skillsOf(skillsInputFor(delivery, cwd))?.tokens ?? 0 : 0;
      return { skills, mcp };
    };
  }
  ipcMain.handle("context:preview", async (_e, threadId: string | null, projectId: string | null): Promise<ContextPreview> => {
    const thread = threadId ? store.getThread(threadId) : null;
    const pid = thread?.projectId ?? projectId;
    const cwd = thread ? service.cwdOf(thread) : pid ? store.getProject(pid).path : null;
    const servers = mcpScopes.effective(pid).filter((s) => s.enabled === true);
    await mcpTools.refresh(servers);
    const driver = thread ? drivers.find((d) => d.id === thread.agent) : undefined;
    const delivery = driver?.capabilities.skillsDelivery;
    const deferred = thread ? mcpDeferred(driver, servers) : false;
    return buildContextPreview({
      guideParts: cwd ? guide.partsForCwd(cwd) : [],
      // An agent that keeps the shared memory itself doesn't need the read tool.
      tools: harnessTools().filter((t) => !(thread && drivers.find((d) => d.id === thread.agent)?.capabilities.nativeMemory && t.name === MEMORY_READ_TOOL)),
      skills: thread && delivery ? skillsInputFor(delivery, cwd) : null,
      mcp: servers.map((s) => ({ name: s.name, listed: mcpTools.peek(s.spec), deferred })),
      memoryIndex: pid && memoryOn(settings.get(), pid) ? (({ lines, tokens }) => ({ lines, tokens }))(memory.store.index(pid)) : null,
    });
  });
  ipcMain.handle("memory:overview", (_e, projectId: string) => memoryApi.overview(projectId));
  ipcMain.handle("memory:read", (_e, projectId: string, file: string) => memoryApi.read(projectId, file));
  ipcMain.handle(
    "memory:write",
    (_e, projectId: string, note: { file?: string; name: string; description: string; type: MemoryType; body: string }) => memoryApi.write(projectId, note),
  );
  ipcMain.handle("memory:delete", (_e, projectId: string, file: string) => memoryApi.remove(projectId, file));
  ipcMain.handle("memory:set-enabled", (_e, projectId: string | null, on: boolean) => memoryApi.setEnabled(projectId, on));
  ipcMain.handle("memory:import", (_e, projectId: string) => memoryApi.reimport(projectId));
  ipcMain.handle("app:update-status", () => updater.status());
  ipcMain.handle("limits:list", () => limits.all());
  ipcMain.handle("app:install-update", () => updater.install());

  ipcMain.handle("projects:list", () => store.listProjects());
  ipcMain.handle("projects:add", async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.OpenDialogOptions = {
      title: "Open a project folder",
      properties: ["openDirectory", "createDirectory"],
    };
    const res = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    const path = res.filePaths[0];
    return res.canceled || !path ? null : store.addProject(path);
  });
  ipcMain.handle("projects:delete", (_e, id: string) => service.deleteProject(id));
  ipcMain.handle("threads:list", (_e, projectId: string) => store.listThreads(projectId));
  ipcMain.handle("threads:create", (_e, projectId: string, agent?: string, opts?: { worktree?: boolean }) =>
    opts?.worktree ? service.createWorktreeThread(projectId, agent) : service.createThread(projectId, agent),
  );
  ipcMain.handle("threads:update", (_e, id: string, patch: Partial<Pick<Thread, "title" | "model" | "effort" | "permissionMode" | "agent" | "pinned" | "archived">>) =>
    service.updateThread(id, pick(patch, ["title", "model", "effort", "permissionMode", "agent", "pinned", "archived"])),
  );
  ipcMain.handle("threads:delete", (_e, id: string) => service.deleteThread(id));
  ipcMain.handle("threads:switch", (_e, id: string, agent: string, mode: SwitchMode) => service.switchAgent(id, agent, mode));
  ipcMain.handle("threads:export", async (event, id: string) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const title = store.getThread(id).title.replace(/[\\/:*?"<>|]+/g, " ").trim() || "thread";
    const options: Electron.SaveDialogOptions = {
      title: "Export thread",
      defaultPath: `${title}.thread.json`,
      filters: [{ name: "Thread export", extensions: ["json"] }],
    };
    const res = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
    if (res.canceled || !res.filePath) return null;
    writeFileSync(res.filePath, JSON.stringify(service.exportThread(id), null, 2), "utf8");
    return res.filePath;
  });
  ipcMain.handle("settings:export", async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.SaveDialogOptions = {
      title: "Export settings",
      defaultPath: "cubiq-settings.json",
      filters: [{ name: "Settings export", extensions: ["json"] }],
    };
    const res = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
    if (res.canceled || !res.filePath) return null;
    writeFileSync(res.filePath, JSON.stringify(settings.exportData(), null, 2), { encoding: "utf8", mode: 0o600 });
    return res.filePath;
  });
  ipcMain.handle("settings:import", async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.OpenDialogOptions = {
      title: "Import settings",
      properties: ["openFile"],
      filters: [{ name: "Settings export", extensions: ["json"] }],
    };
    const res = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    const path = res.filePaths[0];
    if (res.canceled || !path) return null;
    const view = settings.importData(JSON.parse(readFileSync(path, "utf8")));
    broadcast({ type: "settings", settings: view });
    return view;
  });
  ipcMain.handle("threads:import", async (event, projectId: string) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.OpenDialogOptions = {
      title: "Import thread",
      properties: ["openFile"],
      filters: [{ name: "Thread export", extensions: ["json"] }],
    };
    const res = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    const path = res.filePaths[0];
    if (res.canceled || !path) return null;
    return service.importThread(projectId, JSON.parse(readFileSync(path, "utf8")));
  });
  ipcMain.handle("events:list", (_e, threadId: string) => store.listEvents(threadId));
  ipcMain.handle("skills:list", (_e, projectId?: string) => service.listSkills(projectId));
  ipcMain.handle("agents:list", () => service.listAgents());
  ipcMain.handle("turn:send", (_e, req: SendRequest) => {
    // Resolve once the turn has started; progress arrives as updates.
    service.send(req).catch((err: unknown) => {
      broadcast({ type: "running", threadId: req.threadId, running: false });
      console.error(redactSecrets(err instanceof Error ? (err.stack ?? err.message) : String(err), knownSecrets()));
    });
  });
  ipcMain.handle("turn:interrupt", (_e, threadId: string) => service.interrupt(threadId));
  ipcMain.handle("permission:respond", (_e, requestId: string, decision: PermissionDecision) =>
    service.respondPermission(requestId, decision),
  );
  ipcMain.handle("plan:respond", (_e, requestId: string, decision: PlanDecision) => service.respondPlan(requestId, decision));
  ipcMain.handle("diff:get", (_e, projectId: string, threadId?: string | null) => service.getDiff(projectId, threadId));
  ipcMain.handle("files:list", (_e, projectId: string, threadId?: string | null) => service.listFiles(projectId, threadId));
  ipcMain.handle("project:branch", (_e, projectId: string) => service.projectBranch(projectId));
  ipcMain.handle("browser:attached", (_e, webContentsId: number) => browser.attach(webContentsId));
  ipcMain.handle("browser:pick", () => browser.startPick());
  ipcMain.handle("browser:takeover", (_e, paused: boolean) => browser.setPaused(paused === true));
  ipcMain.handle("browser:device", (_e, preset: DevicePreset) =>
    browser.setDevice(["mobile", "tablet", "desktop"].includes(preset) ? preset : "desktop"),
  );
  ipcMain.handle("browser:state", () => ({
    device: browser.device,
    logs: browser.logsView(),
    screenshots: browser.listScreenshots().map(shotInfo),
  }));
  const terminals = new TerminalManager({
    data: (id, data) => broadcast({ type: "terminal-data", id, data }),
    exit: (id, code) => broadcast({ type: "terminal-exit", id, code }),
  });
  ipcMain.handle("terminal:open", (_e, id: string, cwd: string | null, cols: number, rows: number) => terminals.open(id, cwd, cols, rows));
  ipcMain.on("terminal:write", (_e, id: string, data: string) => terminals.write(id, data));
  ipcMain.on("terminal:resize", (_e, id: string, cols: number, rows: number) => terminals.resize(id, cols, rows));
  ipcMain.handle("terminal:close", (_e, id: string) => terminals.close(id));

  // Coming back to the window (after `codex login`, say) re-checks the model lists,
  // which follow the account's plan; at most once every 10 seconds.
  let lastRefresh = 0;
  const refreshAgents = () => {
    if (Date.now() - lastRefresh < 10_000) return;
    lastRefresh = Date.now();
    for (const d of drivers) void (d.refreshModels?.() ?? Promise.resolve()).finally(() => broadcast({ type: "agents" }));
  };
  const open = () => {
    const win = createWindow();
    windows.add(win);
    win.on("closed", () => windows.delete(win));
    win.on("focus", refreshAgents);
    return win;
  };
  const first = open();

  const smokeBrowser = () => smokeBrowserWith(tools, browser);
  // A real shell through node-pty: proves the native module loads (packaged too) on every OS.
  const smokeTerminal = () =>
    new Promise<boolean>((resolve) => {
      let out = "";
      let settled = false;
      let exited: () => void = () => {};
      const probe = new TerminalManager({
        data: (_id, d) => {
          out += d;
          if (!settled && out.includes("unskilled-term-ok")) {
            settled = true;
            clearTimeout(timer);
            console.log("smoke: terminal ok");
            // Let the shell exit by itself: killing a Windows pty forks node-pty's
            // console-list helper, which crashes if the app exits under it.
            const fallback = setTimeout(() => {
              probe.dispose();
              resolve(true);
            }, 5_000);
            exited = () => {
              clearTimeout(fallback);
              resolve(true);
            };
            probe.write("smoke", "exit\r");
          }
        },
        exit: () => exited(),
      });
      const timer = setTimeout(() => {
        probe.dispose();
        console.log(`smoke: terminal failed\n${out.slice(-500)}`);
        resolve(false);
      }, 20_000);
      probe
        .open("smoke", null, 80, 24)
        // On POSIX the typed line itself doesn't contain the marker; only the command's output does.
        .then(() => setTimeout(() => probe.write("smoke", process.platform === "win32" ? "echo unskilled-term-ok\r" : "echo unskilled-term-$(echo ok)\r"), 500))
        .catch((err: unknown) => {
          clearTimeout(timer);
          console.error("smoke: terminal failed", err);
          resolve(false);
        });
    });
  if (smoke) {
    // Renderer errors show up in the CI log.
    first.webContents.on("console-message", (details) => {
      if (details.level === "error" || details.level === "warning") console.log(`renderer ${details.level}: ${details.message}`);
    });
    first.webContents.on("did-attach-webview", () => console.log("smoke: webview attached"));
    // CI smoke test: the window loads, the preload bridge is there, and the
    // skills catalog, settings, and Library answer. Exit 0 only if everything holds.
    first.webContents.once("did-finish-load", async () => {
      try {
        const ok = await first.webContents.executeJavaScript(
          "typeof window.unskilled === 'object' && Promise.all([window.unskilled.listSkills(), window.unskilled.getSettings(), window.unskilled.listAllSkills(), window.unskilled.getMcp(null), window.unskilled.listAgentCatalog()]).then(([s, st, all, mcp, agents]) => Array.isArray(s) && typeof st.theme === 'string' && Array.isArray(all) && mcp.builtIn.tools.length > 0 && agents.some((a) => a.kind === 'agent-sdk'))",
        );
        // A packaged build must be able to launch the Claude Code binary the
        // Agent SDK ships, from outside the asar archive.
        let binaryOk = true;
        if (app.isPackaged) {
          const bin = resolvePackagedClaudeBinary();
          const run = bin ? spawnSync(bin, ["--version"], { encoding: "utf-8", timeout: 30_000 }) : null;
          binaryOk = Boolean(run && run.status === 0);
          console.log(`smoke: claude binary ${bin ?? "(not found)"} -> ${run?.stdout.trim() || run?.error?.message || "no output"}`);
        }
        const browserOk = await smokeBrowser();
        const terminalOk = await smokeTerminal();
        const releaseOk = await smokeRelease(first.webContents);
        const shot = process.env.UNSKILLED_SMOKE_SCREENSHOT;
        if (shot) {
          first.showInactive();
          await new Promise((r) => setTimeout(r, 800));
          writeFileSync(shot, (await first.webContents.capturePage()).toPNG());
          console.log(`smoke: screenshot ${shot}`);
        }
        const all = ok && binaryOk && browserOk && terminalOk && releaseOk;
        console.log(`smoke: ${all ? "ok" : "failed"}`);
        app.exit(all ? 0 : 1);
      } catch (err) {
        console.error("smoke: failed", err);
        app.exit(1);
      }
    });
    first.webContents.once("did-fail-load", () => app.exit(1));
  }

  app.on("activate", () => {
    if (windows.size === 0) open();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("before-quit", () => {
    updater.stop();
    extractor.dispose();
    service.dispose();
    terminals.dispose();
    void toolServer?.then((s) => s.close());
    void mcpPool.closeAll();
    store.close();
  });
}

/**
 * The release checks (Phase 9 T9.10), each in a scratch folder: provider
 * registry, legacy migration, handoff invariants, and render parity (Claude's
 * adapter output renders exactly like the canonical reference rows).
 */
async function smokeRelease(web: Electron.WebContents): Promise<boolean> {
  const dir = mkdtempSync(join(tmpdir(), "unskilled-smoke-"));
  const report = (name: string, r: { ok: boolean; detail?: string }) => {
    console.log(`smoke: ${name} ${r.ok ? "ok" : `failed ${r.detail ?? ""}`}`);
    return r.ok;
  };
  try {
    const providersOk = report("providers", smokeProviders(join(dir, "providers")));
    const migrationOk = report("migration", smokeMigration(join(dir, "migration")));
    const handoffOk = report("handoff", await smokeHandoff(join(dir, "handoff")));
    const canon = smokeCanonicalEvents();
    const render = (events: unknown) =>
      web.executeJavaScript(
        `(async () => { for (let i = 0; i < 100 && !window.__unskilledSmokeRender; i++) await new Promise((r) => setTimeout(r, 50)); return window.__unskilledSmokeRender(${JSON.stringify(events)}); })()`,
      ) as Promise<string>;
    const [got, want] = [await render(canon.events), await render(referenceEvents())];
    const parity = canon.ok && got === want && got.includes("npm test") && got.includes("+1 −1");
    const renderOk = report("render-parity", parity ? { ok: true } : { ok: false, detail: canon.detail ?? `\n${got}\n${want}` });
    return providersOk && migrationOk && handoffOk && renderOk;
  } catch (err) {
    console.error("smoke: release checks failed", err);
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
}

/**
 * Smoke-test the browser pane through the agent's own tools: open a page,
 * snapshot it, type, click, and read the console. Proves the <webview>, the
 * DevTools bridge, and the snapshot script on every OS CI runs.
 */
async function smokeBrowserWith(tools: ReturnType<typeof browserTools>, browser: BrowserController): Promise<boolean> {
  const byName = (n: string) => tools.find((t) => t.name === n)!;
  const page =
    "data:text/html," +
    encodeURIComponent(`<!doctype html><title>Smoke</title><h1>Sign in</h1>
      <label for=u>Email</label><input id=u>
      <button onclick="document.querySelector('p').textContent = 'Hello ' + document.getElementById('u').value; console.error('smoke-console-check')">Go</button>
      <p>waiting</p>`);
  // The tools refuse until the user opens the pane; the smoke stands in for that user.
  browser.enabled = true;
  try {
    const opened = await byName("browser_open").run({ url: page });
    const ref = (label: string) => new RegExp(`\\[(e\\d+)\\] ${label}`).exec(opened.text)?.[1];
    const input = ref('input "Email"');
    const button = ref('button "Go"');
    if (!input || !button) throw new Error(`unexpected snapshot:\n${opened.text}`);
    await byName("browser_type").run({ ref: input, text: "ada@example.com" });
    await byName("browser_click").run({ ref: button });
    const after = await byName("browser_snapshot").run({});
    const logs = await byName("browser_logs").run({});
    // The element picker: start it, click the heading, get a description back.
    // browser_click re-resolves the ref, so take a fresh snapshot first.
    await browser.snapshot();
    const picked = browser.nextPick();
    await browser.startPick();
    await byName("browser_click").run({ ref: button });
    const pick = await Promise.race([picked, new Promise<null>((r) => setTimeout(() => r(null), 10_000))]);
    const pickOk = Boolean(pick?.includes("<button") && pick.includes("Element `"));
    // Device emulation round-trips; the console buffer survives a logsView read.
    await browser.setDevice("mobile");
    await browser.setDevice("desktop");
    const deviceOk = browser.logsView().some((l) => l.text.includes("smoke-console-check"));
    // The pane's sandbox posture, checked on the live page rather than trusted from will-attach-webview.
    // Present at runtime; missing from this Electron version's type declarations.
    const pane = (await browser.page()) as unknown as { getLastWebPreferences(): Electron.WebPreferences | null };
    const prefs = pane.getLastWebPreferences();
    const sandboxOk =
      prefs?.sandbox === true && prefs.nodeIntegration !== true && prefs.contextIsolation === true && !prefs.preload && !isAllowedUrl("javascript:alert(1)");
    console.log(`smoke: browser sandbox ${sandboxOk ? "ok" : `failed ${JSON.stringify({ sandbox: prefs?.sandbox, node: prefs?.nodeIntegration, iso: prefs?.contextIsolation, preload: prefs?.preload })}`}`);
    const ok = after.text.includes("Hello ada@example.com") && logs.text.includes("smoke-console-check") && pickOk && deviceOk && sandboxOk;
    console.log(`smoke: browser ${ok ? "ok" : `failed\n${after.text}\n${logs.text}\npick: ${pick}`}`);
    return ok;
  } catch (err) {
    console.error("smoke: browser failed", err);
    return false;
  }
}

function pick<T extends object, K extends keyof T>(obj: T, keys: K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

main().catch((err: unknown) => {
  console.error(err);
  dialog.showErrorBox("CubiQ could not start", err instanceof Error ? err.message : String(err));
  app.exit(1);
});
