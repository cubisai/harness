import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, release, tmpdir, type as osType } from "node:os";
import { basename, delimiter, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BrowserWindow, Menu, app, dialog, ipcMain, nativeTheme, net, powerMonitor, protocol, safeStorage, shell, utilityProcess } from "electron";
import type { AboutInfo, AgentLimits, ContextPreview, CatalogProvider, DesignDevice, DesignExportFormat, DesignSystemEdit, DesignSystemOption, DevicePreset, LinkMeta, LiveUpdate, McpOverview, ModelDiscovery, McpServerEntry, McpServerSpec, McpServerStatus, MemoryScope, MemoryType, OpenResult, PermissionDecision, PlanDecision, ProviderInput, Question, ScreenshotInfo, SearchQuery, SendRequest, Settings, SkillOrigin, SkillsDelivery, SwitchMode, Thread, ThreadKind } from "../shared/types";
import type { HarnessTool } from "./agents/types";
import { stepZoom, trafficLightPosition, zoomKey } from "../shared/zoom";
import type { AutomationInput } from "../shared/automations";
import { DESIGN_SCHEME, designDirName, designUrl, entryFile, serveDesign } from "./design/serve";
import { DesignWatcher } from "./design/watch";
import { listDesignFiles, listDesignPages, pageDevice } from "./design/pages";
import { readTier } from "../shared/tiers";
import { readTarget } from "../shared/comments";
import { bridgeScript } from "./design/bridge";
import { buildDesignExport, exportFileName, pageTitleSource, type DesignExportDeps } from "./design/export";
import { lintScript } from "./design/lint";
import { electronShotWindow } from "./design/shot-window";
import { Shooter } from "./design/shooter";
import { designTools } from "./design/tools";
import { selectorFor } from "./browser/picker";
import { spawnSync } from "node:child_process";
import { createAcpDriver } from "./agents/acp/driver";
import { setBinaryPins, warmBinaries } from "./agents/binaries";
import { createDoctor, pinsByCommand } from "./doctor";
import type { GatherDeps } from "./doctor/gather";
import { claudeOneShot, createClaudeDriver, resolvePackagedClaudeBinary } from "./agents/claude";
import { createCodexDriver } from "./agents/codex";
import { acpCapabilities, CLAUDE_CAPABILITIES, CODEX_CAPABILITIES } from "./agents/capabilities";
import { LimitsTracker } from "./agents/limits";
import { LimitsRefresher } from "./limits-refresher";
import { loadAcpAgents, onPath } from "./agents/registry";
import { BrowserController, isAllowedUrl } from "./browser/controller";
import { browserTools } from "./browser/tools";
import { DevServers } from "./devserver/registry";
import { devServerTools } from "./devserver/tools";
import { Store } from "./db";
import { artifactKind, resolveInside } from "./artifacts";
import { createLinkPreviews, localImage } from "./link-preview";
import { headContent } from "./git";
import { PreviewHost, utilityFork } from "./preview/host";
import { migrateLegacyData } from "./migrate-data";
import { startToolServer, type ToolServer } from "./mcp-http";
import { TerminalManager } from "./terminal";
import { Service } from "./service";
import { startAutomations } from "./automations/app";
import { testConnection } from "./providers";
import { discoverModels, ModelsDev, pickSmallModel } from "./models-catalog";
import { injectionFor } from "./inject";
import { redactSecrets } from "./inject/redact";
import { opencodeVariants, withOpenCodeReadDirs, withOpenCodeTeam, withOpenCodeVariant } from "./inject/opencode";
import { ensureOpenCodeGuard, withOpenCodeGuard } from "./inject/opencode-guard";
import { BUILT_IN_GUARD, findPython } from "./guard";
import { PROVIDER_AGENT_PREFIX } from "./harness/driver";
import { ProviderAgents } from "./harness/register";
import { SessionStore } from "./harness/session";
import { pruneOutputDir } from "./harness/tools/bound";
import { createGuide, userGuidePath } from "./guide";
import { createExpertCatalog } from "./experts/catalog";
import { importExperts, removeImportedExpert } from "./experts/importer";
import { latestFileBy, readTeamFile, teamTools } from "./experts/team";
import { makeTranslate } from "./experts/translate";
import { EXPERT_ID_RE, teamAgents } from "../shared/experts";
import { buildContextPreview, mcpRow, skillsOf, toolTokens } from "./context-preview";
import { createMemory, memoryOn, memoryPrompt } from "./memory";
import { createMemoryApi } from "./memory/api";
import { createExtractor } from "./memory/extractor";
import { createLearner, type Learner, today } from "./learn";
import { LearnDb } from "./learn/db";
import { createVerifier } from "./learn/verify-app";
import type { LessonAction } from "../shared/learn";
import { MemorySnapshots, PENDING_SESSION } from "./memory/snapshot";
import { MEMORY_READ_TOOL, MEMORY_WRITE_TOOL, memoryReadTool, memoryWriteTool } from "./memory/tool";
import { askUserTool, questionAnswerOf } from "./questions";
import { SettingsStore, type SecretBox } from "./settings";
import { agentCatalog, skillDetail } from "./library";
import { execCommandSync, fillUserEnvironment } from "./winspawn";
import { referenceEvents } from "./canonical-events";
import { smokeCanonicalEvents, smokeHandoff, smokeMigration, smokeProviders } from "./smoke-checks";
import { Editors, realHost } from "./editors";
import { readExternalMcp, readExternalSpec } from "./mcp/external";
import { gatewayPath, McpGateway } from "./mcp/gateway";
import { McpAuth } from "./mcp/oauth";
import { probeMcpUrl } from "./mcp/probe";
import { BUILT_IN_SERVER, isRemote, McpScopes, McpServerStore, McpToolsCache, migrateMcpSecrets, resolveSpec, testServer, viewOf } from "./mcp/servers";
import { cleanName } from "../shared/mcp-add";
import { expandEnvRefs } from "./mcp/vault";
import { McpVault } from "./mcp/vault";
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
    // 14px lights centred on the 46px header, so they line up with its icons (DESIGN.md §2).
    trafficLightPosition: isMac ? { x: 16, y: 16 } : undefined,
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

/**
 * What the shared skill tool (`/mcp-skills`) leaves out: folders tool-mode agents
 * read themselves (OpenCode reads .agents and .claude). .cubiq is always served.
 */
const TOOL_SKILL_READS: SkillOrigin[] = ["project", "projectClaude", "shared"];

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
  // cubiq-file:// serves a thread's pdf and image files to the artifact panel.
  protocol.registerSchemesAsPrivileged([
    { scheme: "unskilled-shot", privileges: { standard: true, secure: true, supportFetchAPI: true } },
    { scheme: "cubiq-file", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
    // cubiq-design:// serves a design thread's folder to the canvas's sandboxed frame (scripts on, no network).
    { scheme: DESIGN_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  ]);
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
  // Content left behind by threads deleted before blobs were pruned on delete, off the startup path.
  setImmediate(() => store.pruneBlobs());
  // Saved tool output from old turns, likewise off the startup path.
  setImmediate(() => pruneOutputDir(join(userData, "harness-output")));
  const memory = createMemory({ root: join(userData, "memory", "projects"), home: homedir(), codexHome: process.env.CODEX_HOME || undefined });
  const secretBox: SecretBox = {
    // On Linux, isEncryptionAvailable() is true even with the plain-text fallback backend.
    available: safeStorage.isEncryptionAvailable() && (process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text"),
    encrypt: (s) => safeStorage.encryptString(s).toString("base64"),
    decrypt: (b) => safeStorage.decryptString(Buffer.from(b, "base64")),
  };
  const settings = new SettingsStore(join(userData, "settings.json"), secretBox);
  // MCP header and env secrets, encrypted the same way, one entry per server.
  const mcpVault = new McpVault(join(userData, "mcp-secrets.json"), secretBox);
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
  const knownSecrets = () => [
    ...(secretsCache ??= settings
      .providers()
      .flatMap((p) => [settings.providerSecret(p.id), ...Object.values(settings.providerSecretHeaders(p.id))])
      .filter((s): s is string => Boolean(s))),
    // The vault caches what it decrypts, so this stays cheap per call.
    ...mcpVault.values(),
  ];
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
  const skillsInputFor = (delivery: SkillsDelivery | undefined, cwd: string | null, design = false) => {
    if (!delivery) return null;
    const catalog = skillsFor(cwd);
    const toolSkills = forAgent(catalog, { mode: "tool", reads: TOOL_SKILL_READS }, new Set(), { design });
    return {
      mode: delivery.mode,
      entries: catalog.modelSkills.filter((s) => design || s.mode !== "design")
        .map(({ name, description }) => ({ name, description })),
      tool: delivery.mode === "tool" ? skillTool(() => toolSkills) : undefined,
      toolNames: toolSkills.map((s) => s.name),
    };
  };
  const windows = new Set<BrowserWindow>();
  const broadcast = (update: LiveUpdate) => {
    for (const w of windows) if (!w.isDestroyed()) w.webContents.send("unskilled:update", update);
  };
  // The app owns zoom (Settings › Text size): Chromium's own zoom would drift from the setting and from the
  // traffic lights, which macOS draws unzoomed, so they move to stay centred on the zoomed header.
  const applyZoom = (w: BrowserWindow) => {
    if (w.isDestroyed()) return;
    const zoom = settings.get().zoom ?? 1;
    w.webContents.setZoomFactor(zoom);
    if (process.platform === "darwin") w.setWindowButtonPosition(trafficLightPosition(zoom));
    // Windows and Linux: the caption buttons keep their share of the zoomed header (52px at 100%, see createWindow).
    else w.setTitleBarOverlay({ height: Math.round(52 * zoom) });
  };
  const stepAppZoom = (dir: -1 | 0 | 1) => {
    settings.update({ zoom: stepZoom(settings.get().zoom ?? 1, dir) });
    for (const w of windows) applyZoom(w);
    broadcast({ type: "settings", settings: settings.view() });
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
        {
          label: "View",
          submenu: [
            { role: "reload" },
            { role: "forceReload" },
            { role: "toggleDevTools" },
            { type: "separator" },
            // Shown for discovery; the keys themselves are caught in before-input-event (open()), on every OS.
            { label: "Actual Size", accelerator: "CmdOrCtrl+0", registerAccelerator: false, click: () => stepAppZoom(0) },
            { label: "Zoom In", accelerator: "CmdOrCtrl+=", registerAccelerator: false, click: () => stepAppZoom(1) },
            { label: "Zoom Out", accelerator: "CmdOrCtrl+-", registerAccelerator: false, click: () => stepAppZoom(-1) },
            { type: "separator" },
            { role: "togglefullscreen" },
          ],
        },
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
    bundled: app.isPackaged ? join(process.resourcesPath, "CUBIQ.md") : join(app.getAppPath(), "resources", "CUBIQ.md"),
    global: userGuidePath(userData),
    designMode: app.isPackaged ? join(process.resourcesPath, "DESIGN-MODE.md") : join(app.getAppPath(), "resources", "DESIGN-MODE.md"),
    uiBlocks: () => settings.get().uiBlocks === true,
  });
  // The expert catalogue: bundled personas shipped with the app, plus the user's imported ones.
  const experts = createExpertCatalog({
    bundledDir: app.isPackaged ? join(process.resourcesPath, "experts") : join(app.getAppPath(), "resources", "experts"),
    userDir: join(userData, "experts"),
  });
  /** The skill catalog for a cwd. An expert's package skills are never in it: they reach its agents as private prompt indexes. */
  function skillsFor(cwd: string | null) {
    return skills.forProject(cwd);
  }
  /** A generated skills folder's key: cwd and design. */
  const skillsKey = (cwd: string, design: boolean | undefined) =>
    createHash("sha256")
      .update([cwd, ...(design ? ["design"] : [])].join("\0"))
      .digest("hex")
      .slice(0, 12);
  const driver = createClaudeDriver({
    guide: (cwd, design) => guide.forCwd(cwd, design),
    pluginDir: (cwd, design) =>
      ensurePlugin(
        forAgent(
          skillsFor(cwd),
          CLAUDE_CAPABILITIES.skillsDelivery,
          // Claude Code loads these itself; the plugin would list them twice.
          skills.namesIn([join(homedir(), ".claude", "skills"), join(cwd, ".claude", "skills")]),
          { design },
        ),
        // Design threads get their own plugin (with the design-only skills), so a chat thread's never changes.
        join(userData, "harness-plugin", skillsKey(cwd, design)),
      ),
    skillDirs: () => [skills.dirs(null).bundled, skills.dirs(null).harness],
    guardScript,
    // Deferred: memoryPromptFor is declared after this driver is created.
    memory: (projectId, threadId, sessionKey) => memoryPromptFor(projectId, threadId, sessionKey),
    onLimits: limits.for("claude"),
    injection: () => injectionFor(settings, "claude", process.env),
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
  // The pane is one target: a thread whose turn is running owns it until the turn ends (service is set up below).
  const tools = browserTools(browser, { busy: (threadId) => service.isRunning(threadId) });
  const memoryEnabled = (pid: string) => memoryOn(settings.get(), pid);
  const memoryTools = [memoryReadTool({ store: memory.store, enabled: memoryEnabled }), memoryWriteTool({ store: memory.store, enabled: memoryEnabled })];
  // Dev servers the app starts for the agent (P5.5); only these are ever stopped, all of them on quit.
  const devServers = new DevServers();
  const devTools = devServerTools(devServers, (pid) => {
    try {
      return store.getProject(pid).path;
    } catch {
      return null;
    }
  });
  // A stable array identity: the tool list must not change mid-conversation.
  const allTools = [...tools, ...devTools, ...memoryTools];
  const memorySnapshots = new MemorySnapshots(join(userData, "memory", "projects"));
  // Snapshots of deleted threads (and stale ones), off the startup path.
  setImmediate(() => {
    try {
      memorySnapshots.prune(new Set(store.listProjects().flatMap((p) => store.listThreads(p.id).map((t) => t.id))));
    } catch {
      // Best-effort housekeeping.
    }
  });
  /** The memory block for a project, with notes that name only missing files flagged; every caller uses this, so frozen blocks and their update diffs agree. */
  const memoryBlockFor = (projectId: string) => {
    const root = store.getProject(projectId).path;
    return memory.store.blockIndex(projectId, (rel) => existsSync(join(root, rel)));
  };
  // The learner is created below, after memoryPromptFor needs it: a late-bound reference.
  let learnerRef: Learner | null = null;
  /**
   * The memory block every agent gets, plus the project's active lessons, or
   * null when both are empty. With a thread it's frozen per agent session (null
   * sessionKey = a new session), so a note written mid-session never changes the
   * prompt the cache was built on. Never throws: memory must not block a turn.
   */
  const memoryPromptFor = (projectId: string, threadId?: string, sessionKey?: string | null): string | null => {
    try {
      const compute = (): string => {
        const parts: string[] = [];
        if (memoryOn(settings.get(), projectId)) {
          memory.ensure(projectId, store.getProject(projectId).path);
          const block = memoryPrompt(memoryBlockFor(projectId).text);
          if (block) parts.push(block);
        }
        const lessons = learnerRef?.lessonsBlockFor(projectId, threadId);
        if (lessons) parts.push(lessons);
        return parts.join("\n\n");
      };
      const out = threadId ? memorySnapshots.get(threadId, sessionKey ?? PENDING_SESSION, compute) : compute();
      return out || null;
    } catch {
      return null;
    }
  };
  /**
   * What a live session's frozen memory block is missing, or null when nothing
   * changed. Diffed as raw block lines so it lines up with what get() stored.
   * Never throws: memory must not block a turn.
   */
  const memoryUpdateFor = (projectId: string, threadId: string): string | null => {
    try {
      if (!memoryOn(settings.get(), projectId)) return null;
      memory.ensure(projectId, store.getProject(projectId).path);
      return memorySnapshots.updates(threadId, memoryBlockFor(projectId).text);
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
  // Renders design pages off screen for the design tools and Export; its window exists only while used.
  const shooter = new Shooter(electronShotWindow);
  const designLintJs = lintScript(selectorFor);
  // Each design thread's own tools (bound to it), made once so its list keeps the same identity.
  const designToolLists = new Map<string, HarnessTool[]>();
  const designToolsOf = (threadId: string): HarnessTool[] => {
    let list = designToolLists.get(threadId);
    if (!list) {
      list = designTools(
        {
          root: (id) => service.designRoot(id),
          folder: (id) => designDirName(id),
          url: (id, rel) => designUrl(id, rel),
          screenshot: (url, opts) => shooter.screenshot(url, opts),
          evaluate: (url, width, height, script) => shooter.evaluate(url, width, height, script),
          lintScript: designLintJs,
          saveCritique: (id, markdown) => service.saveCritique(id, markdown),
        },
        threadId,
      );
      designToolLists.set(threadId, list);
    }
    return list;
  };
  const designThreadTools = new Map<string, HarnessTool[]>();
  /** Where a team thread's members leave results and notes: the app's data folder, never the project. */
  const teamRunDir = (threadId: string) => join(userData, "team-runs", threadId);
  const teamToolLists = new Map<string, { expertId: string; tools: HarnessTool[] }>();
  /** A thread's team channel (team_write/read/post/board) when its expert is a team; none for every other thread. */
  const teamToolsOf = (threadId: string | undefined): HarnessTool[] => {
    if (!threadId) return [];
    let expertId: string | null;
    try {
      expertId = store.getThread(threadId).expertId ?? null;
    } catch {
      return [];
    }
    const members = expertId ? teamAgents(experts.get(expertId) ?? { kind: "agent" }).map((m) => m.id) : [];
    if (!expertId || !members.length) return [];
    const hit = teamToolLists.get(threadId);
    if (hit?.expertId === expertId) return hit.tools;
    const list = teamTools({ dir: teamRunDir(threadId), members, onNote: (note) => service.teamNote(threadId, note) });
    teamToolLists.set(threadId, { expertId, tools: list });
    return list;
  };
  // Always offered: adding them when the tab opens would rewrite the prompt prefix and reload the session.
  // A design thread also gets the design tools (its kind never changes, so its list is stable too); a chat thread's is untouched.
  // A team thread also gets its team channel.
  const harnessTools = (thread?: Thread): HarnessTool[] => {
    const team = teamToolsOf(thread?.id);
    if (thread?.kind !== "design") return team.length ? [...allTools, ...team] : allTools;
    let list = designThreadTools.get(thread.id);
    if (!list) designThreadTools.set(thread.id, (list = [...allTools, ...designToolsOf(thread.id)]));
    return team.length ? [...list, ...team] : list;
  };
  // Started on first use, for Codex and ACP agents, which take tools over MCP.
  let toolServer: Promise<ToolServer> | null = null;
  // `/mcp-skills` adds the skill tool for agents in "tool" delivery mode.
  const getToolServer = () =>
    (toolServer ??= startToolServer(
      harnessTools,
      // The project's skills too (.cubiq, .claude), which tool-mode agents don't read themselves.
      // A design thread's (named by `?t=`) list adds the design-only skills.
      (pid, tid) => [
        skillTool(() => forAgent(skillsFor(projectPathOf(pid ?? null)), { mode: "tool", reads: TOOL_SKILL_READS }, new Set(), { design: isDesignThread(tid) })),
      ],
      (pid) => routedTools(pid),
      () => threadTools,
      undefined,
      (req, res, scope, name) => mcpGateway.handle(req, res, scope, name),
      // `?d=` (Codex) or `?t=` (ACP) naming a design thread adds its design tools; a team thread's adds its team channel.
      (tid) => [...(isDesignThread(tid) ? designToolsOf(tid) : []), ...teamToolsOf(tid)],
    ));
  // Served only on a thread's own URL (`?t=`): ACP agents' question tool, answered in the app's card.
  const threadTools: HarnessTool[] = [askUserTool((threadId: string, questions: Question[], signal?: AbortSignal) => service.askFromTool(threadId, questions, signal))];
  const drivers = [
    driver,
    // Codex when it's installed: the same model-invoked skills as an extra skills root, and the browser tools over MCP.
    ...(onPath("codex")
      ? [
          createCodexDriver({
            command: "codex",
            args: ["app-server"],
            clientVersion: app.getVersion(),
            catalogDir: () => userData,
            rolesDir: join(userData, "codex-roles"),
            guardScript,
            guide: (cwd, design) => guide.forCwd(cwd, design),
            memory: memoryPromptFor,
            extensions: extensionsFor("codex"),
            // Per project: Codex reads .agents/skills itself, but not .cubiq or .claude.
            // A design thread's set adds the design-only skills, in a folder of its own.
            skillsDir: (cwd, design) =>
              cwd
                ? ensureModelSkillsDir(
                    forAgent(skillsFor(cwd), CODEX_CAPABILITIES.skillsDelivery, new Set(), { design }),
                    join(`${modelSkillsDir}-projects`, skillsKey(cwd, design)),
                  )
                : ensureModelSkillsDir(forAgent(skills.global(), CODEX_CAPABILITIES.skillsDelivery), modelSkillsDir),
            toolServer: getToolServer,
            onLimits: limits.for("codex"),
            injection: () => injectionFor(settings, "codex", process.env),
          }),
        ]
      : []),
    ...acpAgents.map((config) => {
      // OpenCode can't ask before every shell command, so its guard is a plugin
      // injected into its config. The plugin puts every command to the app, which runs
      // the git guardrail (script or built-in rules), so it blocks in every mode.
      // The plugin also runs the Python script itself when there is a real script file.
      const python = config.guardPlugin === "opencode" && guardScript !== BUILT_IN_GUARD ? findPython() : null;
      const driverConfig =
        config.guardPlugin === "opencode"
          ? { ...config, capabilities: { ...config.capabilities, preToolGuard: true, guardEnforcement: { ask: "block" as const, "auto-edit": "block" as const, plan: "block" as const, full: "block" as const } } }
          : config;
      return createAcpDriver(driverConfig, {
        skillsDir: () => ensureModelSkillsDir(forAgent(skills.global(), acpCapabilities(config).skillsDelivery), modelSkillsDir),
        clientVersion: app.getVersion(),
        toolServer: getToolServer,
        guardScript,
        guide: (cwd, design) => guide.forCwd(cwd, design),
        memory: memoryPromptFor,
        extensions: extensionsFor(config.id),
        mcpRouting: (_pid, servers) => mcpRoutingFor(servers),
        ...(config.effortVia === "opencode-variants" ? { variants: () => opencodeVariants(config.command) } : {}),
        injection: (ctx) => {
          let plan = injectionFor(settings, config.id, process.env);
          // Always loaded: it asks CubiQ before edits and commands; the git guard inside needs Python.
          if (config.guardPlugin === "opencode") {
            plan = withOpenCodeGuard(plan, { pluginUrl: ensureOpenCodeGuard(join(userData, "opencode")), ...(python ? { script: guardScript, python } : {}) });
          }
          // After the guard, so both the plugin and the variant survive.
          if (ctx?.effort) plan = withOpenCodeVariant(plan, ctx.effort);
          // An expert team's members, as this thread's subagents (OpenCode only; other ACP agents run the team as one agent).
          if (ctx?.team?.length && config.injector === "opencode") plan = withOpenCodeTeam(plan, ctx.team, [ctx.teamLead ?? "build", "build"]);
          // The expert's private package skills sit outside the project: let its agents read them without a prompt.
          if (ctx?.expertRoot && config.injector === "opencode") plan = withOpenCodeReadDirs(plan, [ctx.expertRoot]);
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
  const mcpStore = new McpServerStore(join(userData, "mcp.json"), mcpVault);
  const mcpProjectDir = (projectId: string) => join(userData, "projects", projectId);
  const mcpScopes = new McpScopes(mcpStore, mcpProjectDir, mcpVault);
  // Move any plain-text secrets left in mcp.json files from before the vault into it now, off the startup path.
  setImmediate(() => migrateMcpSecrets(mcpStore, mcpScopes, join(userData, "projects")));
  // The enabled servers' tool schemas, for the Context sheet; listed on demand.
  // Ok listings are also persisted by spec hash, so the next launch's index has them.
  const mcpTools = new McpToolsCache(undefined, undefined, { file: join(userData, "mcp-tools-cache.json") });
  /** A server announced new tools: drop its listing, and the window asks again (debounced there). */
  const mcpToolsChanged = (spec: McpServerSpec | null) => {
    if (spec) mcpTools.invalidate(spec);
    broadcast({ type: "mcp-status" });
  };
  // One connection per routed MCP server, kept warm between calls and closed on quit.
  const mcpPool = new McpClientPool({ onToolsChanged: mcpToolsChanged });
  /** "global" or "project:<id>": the scope part of a server's vault key and gateway path. */
  const mcpScope = (projectId: string | null | undefined) => (projectId ? `project:${projectId}` : "global");
  // Sign-in for URL servers (OAuth). Tokens live in the vault and never leave main.
  const mcpAuth = new McpAuth({ vault: mcpVault, openExternal: (url) => shell.openExternal(url) });
  // URL servers reach agents through the tool server's /mcp-up route, which adds their credentials here.
  const mcpGateway = new McpGateway({
    target: (scope, name) => {
      const entry = mcpScopes.store(scope)?.list().find((s) => s.name === name && s.enabled);
      const spec = entry && isRemote(entry.spec) ? resolveSpec(entry.spec) : null;
      return spec && isRemote(spec) ? { key: `${scope}:${name}`, spec } : null;
    },
    auth: mcpAuth,
    onState: () => broadcast({ type: "mcp-status" }),
    onToolsChanged: (key) => {
      // The key is "<scope>:<name>", and a project scope has a colon of its own.
      const at = key.indexOf(":", key.startsWith("project:") ? "project:".length : 0);
      mcpToolsChanged(gatewaySpec(key.slice(0, at), key.slice(at + 1)));
    },
  });
  let toolServerUp: ToolServer | null = null;
  /** The spec agents (and main's own listing) get for a URL server: its gateway route; null until the tool server listens. */
  const gatewaySpec = (scope: string, name: string): McpServerSpec | null =>
    toolServerUp ? { type: "http", url: new URL(gatewayPath(scope, name), toolServerUp.url).toString(), headers: { Authorization: `Bearer ${toolServerUp.token}` } } : null;
  mcpScopes.setRemote(gatewaySpec);
  // Started now rather than on first use, so URL servers have their route before the first turn.
  void getToolServer().then((s) => {
    toolServerUp = s;
  });
  /** A server was signed in or out, edited or removed: drop what the gateway and the listing cache hold for it, and tell the window. */
  const mcpChanged = async (scope: string, name: string) => {
    await mcpGateway.reset(`${scope}:${name}`);
    const spec = gatewaySpec(scope, name);
    if (spec) mcpTools.invalidate(spec);
    broadcast({ type: "mcp-status" });
  };
  /** The scope's own server by name, or an error the window can show. */
  const mcpEntry = (name: string, projectId: string | null | undefined) => {
    const entry = mcpScopes.store(mcpScope(projectId))?.list().find((s) => s.name === name);
    if (!entry) throw new Error(`There's no server named "${name}".`);
    return entry;
  };
  const remoteSpecOf = (name: string, projectId: string | null | undefined) => {
    const spec = resolveSpec(mcpEntry(name, projectId).spec);
    if (!isRemote(spec)) throw new Error(`"${name}" isn't a URL server, so it has no sign-in.`);
    return spec;
  };
  /** Live state of the scope's own servers; URL servers are listed through the gateway, like agents see them. */
  async function mcpStatusOf(projectId: string | null, refresh: boolean): Promise<McpServerStatus[]> {
    const scope = mcpScope(projectId);
    const list = mcpScopes.store(scope)?.list() ?? [];
    const listingSpec = (e: McpServerEntry) => (isRemote(e.spec) ? gatewaySpec(scope, e.name) : resolveSpec(e.spec));
    const live = list.flatMap((e) => {
      const spec = e.enabled && !e.locked ? listingSpec(e) : null;
      return spec ? [{ ...e, spec }] : [];
    });
    if (refresh) for (const e of live) mcpTools.invalidate(e.spec);
    await mcpTools.refresh(live, 15_000);
    return list.map((e): McpServerStatus => {
      const key = `${scope}:${e.name}`;
      const auth = isRemote(e.spec) && (e.spec.oauth || mcpAuth.hasTokens(key)) ? mcpAuth.status(key) : undefined;
      const base = { name: e.name, tools: [], ...(auth && { auth }) };
      if (!e.enabled) return { ...base, state: "disabled" };
      if (e.locked) return { ...base, state: "failed", error: "Its saved secrets can't be opened on this computer. Enter them again." };
      const spec = listingSpec(e);
      const got = spec ? mcpTools.peek(spec) : null;
      if (got?.ok) return { ...base, state: "connected", tools: got.tools.map(({ name, description }) => ({ name, description })) };
      const gw = isRemote(e.spec) ? mcpGateway.state(key) : undefined;
      if (gw?.state === "needs-auth") return { ...base, state: "needs-auth", error: gw.error };
      if (!got) return { ...base, state: "checking" };
      return { ...base, state: "failed", error: got.error ?? "The server didn't answer." };
    });
  }
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
    (cwd: string | null) => skillsFor(cwd),
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
    experts,
  );
  // Each saved provider is its own agent on CubiQ's own harness, kept in step with Settings.
  const providerAgents = new ProviderAgents({
    providers: () => settings.providers(),
    secret: (id) => settings.providerSecret(id),
    secretHeaders: (id) => settings.providerSecretHeaders(id),
    sessions: new SessionStore(join(userData, "harness-sessions")),
    outputDir: join(userData, "harness-output"),
    guardScript,
    guide: (cwd, design) => guide.forCwd(cwd, design),
    memory: memoryPromptFor,
    // The project's MCP servers through the app's router (search_tools / call_mcp_tool).
    mcpTools: (projectId) => (mcpScopes.effective(projectId ?? null).length ? routedTools(projectId) : []),
    // The project's model-invoked skills as a `skill` tool, when it has any.
    skills: (cwd, design) => {
      const list = forAgent(skillsFor(cwd), { mode: "tool", reads: [] }, new Set(), { design });
      return list.length ? skillTool(() => list) : null;
    },
    codeMode: () => settings.get().codeMode === "on",
  });
  const syncProviderAgents = () => service.syncDrivers(PROVIDER_AGENT_PREFIX, providerAgents.list());
  syncProviderAgents();
  service.setDesignSystemsDir(app.isPackaged ? join(process.resourcesPath, "design-systems") : join(app.getAppPath(), "resources", "design-systems"));
  // The artifact panel: versions in the store's blobs, office files parsed in a utility process.
  const previews = new PreviewHost(utilityFork(utilityProcess, join(here, "preview-worker.js")));
  const fileUrl = (threadId: string, rel: string) => `cubiq-file://f/${encodeURIComponent(threadId)}/${rel.split("/").map(encodeURIComponent).join("/")}`;
  service.setArtifacts({
    addVersion: (threadId, path, sha, bytes, turnSeq) => store.addArtifactVersion(threadId, path, sha, bytes, turnSeq),
    listVersions: (threadId) => store.listArtifactVersions(threadId),
    writeBlob: (sha, content) => store.writeBlobBytes(sha, content),
    readBlob: (sha) => store.readBlobBytes(sha),
    gitHead: headContent,
    preview: (path) => previews.preview(path),
    fileUrl,
  });
  // Only a thread's own pdf and image files, resolved inside its folder: nothing else is reachable.
  protocol.handle("cubiq-file", (req) => {
    try {
      const [threadId, ...rest] = new URL(req.url).pathname.replace(/^\/+/, "").split("/").map(decodeURIComponent);
      if (!threadId || !rest.length) return new Response(null, { status: 404 });
      const root = service.threadFolder(threadId);
      const rel = resolveInside(root, rest.join("/"));
      const kind = rel ? artifactKind(rel) : null;
      if (!rel || (kind !== "pdf" && kind !== "image")) return new Response(null, { status: 404 });
      return net.fetch(pathToFileURL(join(realpathSync(root), rel)).toString());
    } catch {
      return new Response(null, { status: 404 });
    }
  });
  // Design threads: their folder only, with the canvas bridge injected into pages and a no-network CSP on every response.
  const designBridgeJs = bridgeScript(selectorFor);
  protocol.handle(DESIGN_SCHEME, (req) =>
    serveDesign(req.url, {
      designRoot: (threadId) => service.designRoot(threadId),
      readVersion: (threadId, rel, version) => service.readDesignVersion(threadId, rel, version),
      bridge: designBridgeJs,
    }),
  );
  // Scheduled automations: reconcile a crash's leftovers, then run what's due every minute and on wake.
  const automations = startAutomations({ store, service, broadcast });
  powerMonitor.on("resume", automations.tick);
  const designWatcher = new DesignWatcher({ onChange: (threadId, paths) => broadcast({ type: "design-changed", threadId, ...(paths ? { paths } : {}) }) });
  // Each window's watches, so a window that closes (or reloads) without unmounting its canvas releases them.
  const designWatches = new Map<number, Map<string, number>>();
  const designHooked = new Set<number>();
  const releaseDesignWatches = (senderId: number) => {
    for (const [threadId, n] of designWatches.get(senderId) ?? []) for (let i = 0; i < n; i++) designWatcher.unwatch(threadId);
    designWatches.delete(senderId);
  };
  ipcMain.handle("design:entry", (_e, threadId: string, want?: string | null) => {
    const root = service.designRoot(threadId);
    if (!root) return null;
    const pages = listDesignPages(root);
    const rel = typeof want === "string" && pages.includes(want) ? want : entryFile(root);
    if (!rel) return null;
    const inPages = new Set(pages);
    const links: { from: string; to: string }[] = [];
    const seen = new Set<string>();
    const devices = new Map<string, DesignDevice>();
    for (const from of pages) {
      let html: string;
      try {
        const file = join(root, from);
        if (statSync(file).size > 2 * 1024 * 1024) continue;
        html = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const device = pageDevice(html);
      if (device) devices.set(from, device);
      if (links.length >= 200) continue;
      for (const m of html.matchAll(/(?:href|data-goto)\s*=\s*(["'])(.*?)\1/gi)) {
        const raw = m[2] ?? "";
        if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("//")) continue;
        const to = raw.replace(/[#?].*$/, "").replace(/^\.\//, "");
        if (!to || to.startsWith("../") || !inPages.has(to) || to === from) continue;
        const key = `${from}\n${to}`;
        if (seen.has(key)) continue;
        seen.add(key);
        links.push({ from, to });
        if (links.length >= 200) break;
      }
    }
    return {
      dir: designDirName(threadId),
      rel,
      url: designUrl(threadId, rel),
      pages: pages.map((p) => {
        const device = devices.get(p);
        return { rel: p, url: designUrl(threadId, p), ...(device ? { device } : {}) };
      }),
      links,
      handoff: existsSync(join(root, "handoff.md")),
    };
  });
  ipcMain.handle("design:files", (_e, threadId: string) => {
    const root = service.designRoot(threadId);
    return root ? listDesignFiles(root) : [];
  });
  ipcMain.handle("design:promote", (_e, threadId: string, rel: string) => {
    if (typeof rel !== "string") throw new Error("Not a variant.");
    service.promoteDesignVariant(threadId, rel);
  });
  ipcMain.handle("design:comments", (_e, threadId: string) => service.designComments(threadId));
  ipcMain.handle("design:comment-add", (_e, threadId: string, input: { page?: unknown; target?: unknown; label?: unknown; text?: unknown }) => {
    const target = readTarget(input?.target);
    if (!target || typeof input.page !== "string" || typeof input.label !== "string" || typeof input.text !== "string") throw new Error("Bad comment.");
    return service.addDesignComment(threadId, { page: input.page, target, label: input.label.slice(0, 80), text: input.text });
  });
  ipcMain.handle("design:comment-update", (_e, threadId: string, id: unknown, patch: { resolved?: unknown; sent?: unknown }) => {
    if (typeof id !== "string") throw new Error("No such comment.");
    return service.updateDesignComment(threadId, id, {
      ...(typeof patch?.resolved === "boolean" ? { resolved: patch.resolved } : {}),
      ...(patch?.sent === true ? { sent: true } : {}),
    });
  });
  ipcMain.handle("design:comment-delete", (_e, threadId: string, id: unknown) => {
    if (typeof id !== "string") throw new Error("No such comment.");
    return service.deleteDesignComment(threadId, id);
  });
  ipcMain.handle("design:edit-text", (_e, threadId: string, rel: string, edit: { id?: unknown; before?: unknown; after?: unknown }) => {
    if (typeof rel !== "string" || !edit || typeof edit.id !== "string" || typeof edit.before !== "string" || typeof edit.after !== "string")
      throw new Error("Bad text edit.");
    service.editDesignText(threadId, rel, { id: edit.id, before: edit.before, after: edit.after });
  });
  ipcMain.handle("design:edit-style", (_e, threadId: string, rel: string, edit: { id?: unknown; changes?: unknown }) => {
    const changes = Array.isArray(edit?.changes) ? (edit.changes as unknown[]) : null;
    if (typeof rel !== "string" || typeof edit?.id !== "string" || !changes || changes.length > 32) throw new Error("Bad style edit.");
    const list = changes.map((c) => {
      const o = (c ?? {}) as { prop?: unknown; value?: unknown };
      if (typeof o.prop !== "string" || typeof o.value !== "string") throw new Error("Bad style edit.");
      return { prop: o.prop, value: o.value };
    });
    service.editDesignStyle(threadId, rel, { id: edit.id, changes: list });
  });
  ipcMain.handle("design:save-ref", (_e, threadId: string, bytes: Uint8Array) => {
    if (!(bytes instanceof Uint8Array)) throw new Error("Not an image (png, jpg, webp or gif).");
    return service.saveDesignRef(threadId, bytes);
  });
  ipcMain.handle("design:capture", async (e, threadId: string, rect: { x?: unknown; y?: unknown; width?: unknown; height?: unknown }) => {
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : NaN);
    const box = { x: n(rect?.x), y: n(rect?.y), width: n(rect?.width), height: n(rect?.height) };
    if (Object.values(box).some(Number.isNaN) || box.x < 0 || box.y < 0 || box.width < 8 || box.height < 8 || box.width > 8000 || box.height > 8000) throw new Error("Bad capture area.");
    // The rect is in CSS px; capturePage takes window DIPs, which differ by the page's zoom factor.
    const zoom = e.sender.getZoomFactor() || 1;
    const image = await e.sender.capturePage({ x: Math.round(box.x * zoom), y: Math.round(box.y * zoom), width: Math.round(box.width * zoom), height: Math.round(box.height * zoom) });
    const path = service.saveDesignRef(threadId, image.toPNG());
    return { path, thumb: image.resize({ height: 96 }).toDataURL() };
  });
  ipcMain.handle("design:restore-version", (_e, threadId: string, rel: string, version: number) => {
    if (typeof rel !== "string" || !Number.isInteger(version) || version < 1) throw new Error("Bad version.");
    return service.restoreDesignVersion(threadId, rel, version);
  });
  ipcMain.handle("design:keep-tweaks", (_e, threadId: string, rel: string, values: Record<string, string>) => {
    if (typeof rel !== "string" || !values || typeof values !== "object" || Array.isArray(values)) throw new Error("Bad tweak values.");
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(values).slice(0, 32)) if (typeof v === "string" && v.length <= 64) clean[k] = v;
    return service.keepDesignTweaks(threadId, rel, clean);
  });
  ipcMain.handle("design:watch", (e, threadId: string) => {
    const root = service.designRoot(threadId);
    if (!root) return;
    const id = e.sender.id;
    if (!designHooked.has(id)) {
      designHooked.add(id);
      e.sender.once("destroyed", () => {
        releaseDesignWatches(id);
        designHooked.delete(id);
      });
      e.sender.on("did-start-navigation", (_ev, _url, isInPlace, isMainFrame) => {
        if (isMainFrame && !isInPlace) releaseDesignWatches(id);
      });
    }
    let mine = designWatches.get(id);
    if (!mine) {
      mine = new Map();
      designWatches.set(id, mine);
    }
    mine.set(threadId, (mine.get(threadId) ?? 0) + 1);
    designWatcher.watch(threadId, root);
  });
  ipcMain.handle("design:unwatch", (e, threadId: string) => {
    const mine = designWatches.get(e.sender.id);
    const n = mine?.get(threadId) ?? 0;
    if (!mine || n === 0) return;
    if (n === 1) mine.delete(threadId);
    else mine.set(threadId, n - 1);
    designWatcher.unwatch(threadId);
  });
  const designExportDeps: DesignExportDeps = {
    root: (threadId) => service.designRoot(threadId),
    readVersion: (threadId, rel, version) => service.readDesignVersion(threadId, rel, version),
    url: (threadId, rel, version) => designUrl(threadId, rel, version),
    screenshot: (url, opts) => shooter.screenshot(url, opts),
    pdf: (url, width) => shooter.pdf(url, width),
  };
  // Export the page on the canvas (the version on screen) as one html file, a full-page PNG or a PDF.
  ipcMain.handle("design:export", async (event, threadId: string, format: DesignExportFormat, opts: { rel: string; version: number | null; width: number }) => {
    if (format !== "html" && format !== "png" && format !== "pdf") throw new Error("Unknown export format.");
    if (typeof opts?.rel !== "string" || !service.designRoot(threadId)) throw new Error("Not a design thread.");
    const input = { threadId, format, rel: opts.rel, version: typeof opts.version === "number" && opts.version > 0 ? opts.version : null, width: Number(opts.width) || 1440 };
    const owner = BrowserWindow.fromWebContents(event.sender);
    const names: Record<DesignExportFormat, string> = { html: "HTML page", png: "PNG image", pdf: "PDF document" };
    const options: Electron.SaveDialogOptions = {
      title: "Export design",
      defaultPath: join(app.getPath("downloads"), exportFileName(pageTitleSource(designExportDeps, input), threadId, format, input.version)),
      filters: [{ name: names[format], extensions: [format] }],
    };
    const res = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
    if (res.canceled || !res.filePath) return null;
    writeFileSync(res.filePath, await buildDesignExport(designExportDeps, input));
    return res.filePath;
  });
  ipcMain.handle("design:reveal", async (_e, threadId: string) => {
    const root = service.designRoot(threadId);
    if (!root) return;
    mkdirSync(root, { recursive: true });
    await shell.openPath(root);
  });
  // Self-improve: scores turns of opted-in projects (off for every project by default).
  const learnDb = new LearnDb(store.sql);
  // After a Codex/ACP turn, extract memory in the background; Claude keeps its own. Extraction
  // shares self-improve's accounting: an explicit background pick, and the project's memory cap.
  const extractor = createExtractor({
    store: memory.store,
    enabled: (pid) => memoryOn(settings.get(), pid),
    driverFor: (id) => drivers.find((d) => d.id === id),
    account: (r) => learnDb.recordRun({ ...r, purpose: "memory", day: today(Date.now()), at: Date.now() }),
    budgetLeft: (pid) => settings.get().learn!.memoryDailyTokens - learnDb.runTokens(pid, today(Date.now()), "memory"),
    background: (pid) => {
      const learn = settings.get().learn!;
      const chosen = learn.backgroundByProject[pid] ?? learn.background;
      if (!chosen) return null;
      const driver = drivers.find((d) => d.id === chosen.agent);
      return driver ? { driver, model: chosen.model, effort: null } : null;
    },
  });
  service.setTurnListener((d) => extractor.schedule(d));
  const learner = createLearner({
    db: learnDb,
    settings: () => settings.get().learn,
    broadcast,
    drivers: () => service.allDrivers(),
    busy: () => service.pendingState().running.length > 0,
    casesRoot: (projectId) => join(userData, "learn", projectId, "cases"),
    checkCommand: (projectId) => store.getProject(projectId).checkCommand?.trim() || null,
    existing: (projectId) => memory.store.list(projectId).map((n) => n.description),
    pathExists: (projectId, rel) => existsSync(join(store.getProject(projectId).path, rel)),
    // Names only (never contents), so a drafted lesson points at files that exist.
    projectFiles: (cwd) => {
      try {
        return execCommandSync("git", ["ls-files"], { cwd, timeout: 5000 }).split(/\r?\n/).filter(Boolean).slice(0, 200);
      } catch {
        return [];
      }
    },
    verifyLesson: createVerifier({
      db: learnDb,
      settings: () => settings.get().learn,
      drivers: () => service.allDrivers(),
      casesRoot: (projectId) => join(userData, "learn", projectId, "cases"),
      projectPath: (projectId) => store.getProject(projectId).path,
      appVersion: app.getVersion(),
    }),
  });
  learnerRef = learner;
  service.setLearner(learner);
  service.setMemoryUpdates((projectId, threadId) => memoryUpdateFor(projectId, threadId));
  ipcMain.handle("learn:scores", (_e, threadId: string) => learner.scores(threadId));
  ipcMain.handle("learn:overview", (_e, projectId: string) => learner.overview(projectId));
  ipcMain.handle("learn:set-lesson", (_e, id: string, action: LessonAction) => learner.setLesson(id, action));
  ipcMain.handle("learn:verify", (_e, id: string) => learner.verify(id));
  // Lessons verified on another model or app version go back to candidates at startup.
  try {
    learner.revalidate(store.listProjects().map((p) => p.id), app.getVersion());
  } catch {
    // Revalidation is best-effort.
  }

  // The Library: skills, agents, and MCP servers, as the agents will see them.
  const catalogOfAgents = () =>
    agentCatalog({
      installed: (c) => onPath(c),
      custom: customAgents,
      liveCapabilities: (id) => service.listAgents().find((a) => a.id === id)?.capabilities,
    });
  /** Whether the tool server's `?t=` names a design thread (its skill tool then lists the design-only skills). */
  const isDesignThread = (threadId: string | undefined): boolean => {
    try {
      return !!threadId && store.getThread(threadId).kind === "design";
    } catch {
      return false;
    }
  };
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
      servers: mcpStore.list().map((e) => viewOf(e, mcpVault, `global:${e.name}`)),
      project: projectScope
        ? { servers: projectScope.list().map((e) => viewOf(e, mcpVault, `${mcpScope(projectId)}:${e.name}`)), offGlobal: projectScope.offGlobal(), file: join(mcpProjectDir(projectId!), "mcp.json") }
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
    const base = input.scope === "project" ? dirs.projectCubiq : dirs.harness;
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
  ipcMain.handle("mcp:save", async (_e, entry: McpServerEntry, previousName?: string, projectId?: string | null) => {
    (projectId ? mcpScopes.project(projectId) : mcpStore).save(entry, previousName);
    if (previousName && previousName !== entry.name) await mcpChanged(mcpScope(projectId), previousName);
    await mcpChanged(mcpScope(projectId), entry.name);
    return mcpOverview(projectId ?? null);
  });
  ipcMain.handle("mcp:remove", async (_e, name: string, projectId?: string | null) => {
    const store = projectId ? mcpScopes.project(projectId) : mcpStore;
    const entry = store.list().find((s) => s.name === name);
    const key = `${mcpScope(projectId)}:${name}`;
    // Revoke the sign-in at the server (best effort) before the store drops its tokens from the vault.
    if (entry && isRemote(entry.spec) && mcpAuth.hasTokens(key)) {
      const spec = resolveSpec(entry.spec);
      if (isRemote(spec)) await mcpAuth.disconnect(key, spec).catch(() => {});
    }
    store.remove(name);
    await mcpChanged(mcpScope(projectId), name);
    return mcpOverview(projectId ?? null);
  });
  ipcMain.handle("mcp:enable", async (_e, name: string, enabled: boolean, projectId?: string | null) => {
    (projectId ? mcpScopes.project(projectId) : mcpStore).setEnabled(name, enabled);
    await mcpChanged(mcpScope(projectId), name);
    return mcpOverview(projectId ?? null);
  });
  ipcMain.handle("mcp:test", async (_e, name: string, projectId?: string | null) => {
    const store = projectId ? mcpScopes.project(projectId) : mcpStore;
    const entry = store.list().find((s) => s.name === name);
    if (!entry) return { ok: false, tools: [], error: "No such server." };
    if (!isRemote(entry.spec)) return testServer(resolveSpec(entry.spec));
    // A URL server is tested the way agents reach it: through the gateway, which serves only enabled servers.
    if (!entry.enabled) return { ok: false, tools: [], error: "Turn the server on to test it." };
    const spec = gatewaySpec(mcpScope(projectId), name);
    return spec ? testServer(spec) : { ok: false, tools: [], error: "The app's tool server isn't up yet. Try again in a moment." };
  });
  ipcMain.handle("mcp:probe", (_e, url: string, headers?: Record<string, string>) =>
    probeMcpUrl(url, { ...(headers && { headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, expandEnvRefs(v)])) }) }),
  );
  ipcMain.handle("mcp:status", (_e, projectId: string | null, refresh?: boolean) => mcpStatusOf(projectId ?? null, refresh === true));
  ipcMain.handle("mcp:connect", async (_e, name: string, projectId?: string | null) => {
    let spec;
    try {
      spec = remoteSpecOf(name, projectId);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    const result = await mcpAuth.connect(`${mcpScope(projectId)}:${name}`, spec);
    await mcpChanged(mcpScope(projectId), name);
    return result.ok ? { ok: true } : { ok: false, error: redactSecrets(result.error, knownSecrets()) };
  });
  ipcMain.handle("mcp:disconnect", async (_e, name: string, projectId?: string | null) => {
    await mcpAuth.disconnect(`${mcpScope(projectId)}:${name}`, remoteSpecOf(name, projectId));
    await mcpChanged(mcpScope(projectId), name);
    return mcpOverview(projectId ?? null);
  });
  ipcMain.handle("mcp:client-secret", (_e, name: string, secret: string | null, projectId?: string | null) => {
    remoteSpecOf(name, projectId);
    if (secret && !mcpVault.available) throw new Error("This computer can't encrypt secrets (no OS keychain), so a client secret can't be saved.");
    mcpAuth.setClientSecret(`${mcpScope(projectId)}:${name}`, secret);
    return mcpOverview(projectId ?? null);
  });
  // Copy a server another agent loads into the app's list; its values are read here and go straight into the vault.
  ipcMain.handle("mcp:import", async (_e, agent: string, source: string, name: string, projectId?: string | null) => {
    const spec = readExternalSpec(agent, source, name, { projectPath: projectPathOf(projectId ?? null) });
    if (!spec) throw new Error(`Couldn't read "${name}" from ${source}.`);
    const own = cleanName(name);
    (projectId ? mcpScopes.project(projectId) : mcpStore).save({ name: own, spec, enabled: true });
    await mcpChanged(mcpScope(projectId), own);
    return mcpOverview(projectId ?? null);
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
    if (patch.zoom !== undefined) for (const w of windows) applyZoom(w);
    const view = settings.view();
    broadcast({ type: "settings", settings: view });
    return view;
  });
  // A changed provider changes what the next agent process inherits; running
  // processes keep the old environment, so stop them and re-broadcast settings.
  const afterProviderChange = () => {
    secretsCache = null;
    service.dispose();
    syncProviderAgents();
    broadcast({ type: "agents" });
    for (const d of drivers) void (d.refreshModels?.({ force: true }) ?? Promise.resolve()).finally(() => broadcast({ type: "agents" }));
    const view = settings.view();
    broadcast({ type: "settings", settings: view });
    return view;
  };
  ipcMain.handle("providers:list", () => settings.providers().map((p) => settings.providerView(p)));
  ipcMain.handle("providers:save", (_e, input: ProviderInput, secret?: string | null, headerValues?: Record<string, string>) => {
    const view = settings.saveProvider(input, secret, headerValues);
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
  /** A saved provider by id, or a draft from the editor, with its headers resolved and its key. */
  const probeTarget = (target: string | ProviderInput, secret?: string, headerValues?: Record<string, string>) => {
    if (typeof target !== "string") return settings.draftProvider(target, secret, headerValues);
    const saved = settings.providers().find((p) => p.id === target);
    if (!saved) throw new Error(`unknown provider ${target}`);
    return settings.draftProvider(settings.providerView(saved));
  };
  ipcMain.handle("providers:test", (_e, target: string | ProviderInput, modelId: string, secret?: string, headerValues?: Record<string, string>) => {
    const { provider, key } = probeTarget(target, secret, headerValues);
    return testConnection(provider, modelId, key);
  });
  // models.dev metadata, cached a day in the data folder; discovery still works without it.
  const modelsDev = new ModelsDev({ file: join(userData, "models-dev.json") });
  ipcMain.handle("providers:discover", async (_e, input: ProviderInput, secret?: string, headerValues?: Record<string, string>): Promise<ModelDiscovery> => {
    const { provider, key } = probeTarget(input, secret, headerValues);
    const result = await discoverModels(provider, key, { modelsDev });
    if (!result.ok) return { ok: false, error: redactSecrets(result.error, [...knownSecrets(), ...(key ? [key] : [])]) };
    const smallModel = pickSmallModel(result.models);
    return { ok: true, models: result.models, ...(smallModel && { smallModel }) };
  });
  ipcMain.handle("providers:catalog", async (_e, query: unknown): Promise<CatalogProvider[]> => {
    await modelsDev.load();
    return modelsDev.catalog(typeof query === "string" ? query.slice(0, 100) : "");
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
  // Pictures for ui:cards rows: thread-folder images always; the web only with Rich replies "+ link previews" on.
  const linkPreviews = createLinkPreviews();
  ipcMain.handle("ui:image", async (_e, threadId: unknown, src: unknown, kind: unknown): Promise<string | null> => {
    if (typeof src !== "string" || !src || src.length > 2048) return null;
    if (/^https:\/\//i.test(src)) return settings.get().linkPreviews === true ? linkPreviews.image(src, kind === "page" ? "page" : "image") : null;
    if (typeof threadId !== "string") return null;
    try {
      return localImage(service.threadFolder(threadId), src);
    } catch {
      return null;
    }
  });
  // Link chips in replies: a page's name, title, description and favicon, only with Rich replies "+ link previews" on.
  ipcMain.handle("ui:link-meta", async (_e, url: unknown): Promise<LinkMeta | null> => {
    if (typeof url !== "string" || !url || url.length > 2048) return null;
    return settings.get().linkPreviews === true ? linkPreviews.meta(url) : null;
  });
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
      // An agent that keeps the shared memory itself doesn't need the memory tools.
      tools: harnessTools(thread ?? undefined).filter((t) => !(thread && drivers.find((d) => d.id === thread.agent)?.capabilities.nativeMemory && (t.name === MEMORY_READ_TOOL || t.name === MEMORY_WRITE_TOOL))),
      skills: thread && delivery ? skillsInputFor(delivery, cwd, thread.kind === "design") : null,
      mcp: servers.map((s) => ({ name: s.name, listed: mcpTools.peek(s.spec), deferred })),
      memoryIndex: pid && memoryOn(settings.get(), pid) ? (({ lines, tokens }) => ({ lines, tokens }))(memoryBlockFor(pid)) : null,
    });
  });
  ipcMain.handle("memory:overview", (_e, projectId: string) => memoryApi.overview(projectId));
  // Anything but "global" from the renderer is the project's own scope.
  const memoryScope = (scope: unknown): MemoryScope => (scope === "global" ? "global" : "project");
  ipcMain.handle("memory:read", (_e, projectId: string, file: string, scope?: unknown) => memoryApi.read(projectId, file, memoryScope(scope)));
  ipcMain.handle(
    "memory:write",
    (_e, projectId: string, note: { file?: string; name: string; description: string; type: MemoryType; body: string }, scope?: unknown) =>
      memoryApi.write(projectId, note, memoryScope(scope)),
  );
  ipcMain.handle("memory:delete", (_e, projectId: string, file: string, scope?: unknown) => memoryApi.remove(projectId, file, memoryScope(scope)));
  ipcMain.handle("memory:set-enabled", (_e, projectId: string | null, on: boolean) => memoryApi.setEnabled(projectId, on));
  ipcMain.handle("memory:import", (_e, projectId: string) => memoryApi.reimport(projectId));
  ipcMain.handle("automation:overview", (_e, projectId: string) => automations.overview(projectId));
  ipcMain.handle("automation:save", (_e, projectId: string, input: AutomationInput, id?: string) => automations.save(projectId, input, id));
  ipcMain.handle("automation:delete", (_e, id: string) => automations.remove(id));
  ipcMain.handle("automation:run-now", (_e, id: string) => automations.runNow(id));
  ipcMain.handle("automation:runs", (_e, id: string) => automations.runs(id));
  ipcMain.handle("app:update-status", () => updater.status());
  ipcMain.handle("limits:list", () => limits.all());
  ipcMain.handle("app:install-update", () => updater.install());

  ipcMain.handle("projects:list", () => store.listProjects().map((p) => ({ ...p, missing: !existsSync(p.path) })));
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
  ipcMain.handle("projects:relocate", async (event, id: string) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.OpenDialogOptions = {
      title: "Locate the project folder",
      properties: ["openDirectory"],
    };
    const res = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    const path = res.filePaths[0];
    if (res.canceled || !path) return null;
    return { ...store.setProjectPath(id, path), missing: false };
  });
  ipcMain.handle("projects:delete", (_e, id: string) => service.deleteProject(id));
  // A project mutation returns the row, as add/delete do; the renderer store applies it.
  ipcMain.handle("projects:set-check-command", (_e, projectId: string, command: string | null, fixRounds?: number | null) =>
    store.setCheckCommand(projectId, command, fixRounds),
  );
  ipcMain.handle("threads:list", (_e, projectId: string) => store.listThreads(projectId));
  ipcMain.handle("threads:all", () => store.listAllThreads());
  ipcMain.handle("threads:create", (_e, projectId: string, agent?: string, opts?: { worktree?: boolean; kind?: unknown; designSystem?: unknown; expertId?: unknown }) => {
    const kind: ThreadKind = opts?.kind === "design" ? "design" : "chat";
    // Only a design thread keeps a system, and only an id the picker could offer (checked again at each turn).
    const designSystem = kind === "design" && typeof opts?.designSystem === "string" && /^[\w:.-]{1,80}$/.test(opts.designSystem) ? opts.designSystem : null;
    // Only an expert the catalogue knows; anything else (unknown id, bad shape) is no expert.
    const expertId = typeof opts?.expertId === "string" && EXPERT_ID_RE.test(opts.expertId) && experts.get(opts.expertId) ? opts.expertId : null;
    return opts?.worktree
      ? service.createWorktreeThread(projectId, agent, kind, designSystem, expertId)
      : service.createThread(projectId, agent, kind, designSystem, expertId);
  });
  ipcMain.handle("threads:set-prototype-tier", (_e, threadId: string, tier: unknown) => service.setPrototypeTier(threadId, readTier(tier)));
  ipcMain.handle("threads:set-design-system", (_e, threadId: string, id: unknown) =>
    service.setDesignSystem(threadId, typeof id === "string" && /^[\w:.-]{1,80}$/.test(id) ? id : null),
  );
  ipcMain.handle("design:systems", (_e, projectId: string | null): DesignSystemOption[] => service.designSystems(projectId)),
  ipcMain.handle("design:system-doc", (_e, threadId: string) => service.designSystemDoc(threadId));
  ipcMain.handle("design:system-edit", (_e, threadId: string, edit: unknown) => service.editDesignSystem(threadId, readSystemEdit(edit)));
  ipcMain.handle("threads:set-expert", (_e, threadId: string, expertId: unknown) => {
    // Only an expert the catalogue knows; null clears it.
    const id = typeof expertId === "string" && EXPERT_ID_RE.test(expertId) && experts.get(expertId) ? expertId : null;
    if (expertId !== null && !id) throw new Error("Unknown expert.");
    return service.setThreadExpert(threadId, id);
  });
  ipcMain.handle("experts:list", () => experts.list());
  ipcMain.handle("experts:get", (_e, id: unknown) => (typeof id === "string" && EXPERT_ID_RE.test(id) ? experts.get(id) : null));
  // Install from a GitHub link, a folder or a .zip into the user's experts folder (nothing in a package is run).
  ipcMain.handle("experts:import", (event, source: unknown, pick: unknown) => {
    if (typeof source !== "string" || source.length > 2000) throw new Error("Paste a GitHub link, or pick a folder or a .zip.");
    const names = Array.isArray(pick) ? pick.filter((n): n is string => typeof n === "string" && n.length <= 200).slice(0, 100) : undefined;
    // Packages in another language are translated to English once, here, with a small Claude model (nothing non-English is installed).
    const translate = makeTranslate((system, user) => claudeOneShot(system, user, "haiku"));
    // Translation can take a while on a big package: the dialog shows how far it got.
    const onProgress = (done: number, total: number) => {
      if (!event.sender.isDestroyed()) event.sender.send("experts:import-progress", { done, total });
    };
    return importExperts(source.trim(), { userDir: join(userData, "experts"), translate, onProgress, ...(names ? { pick: names } : {}) });
  });
  // The folder or .zip an expert is imported from, through the system picker; null when cancelled.
  ipcMain.handle("experts:pick-source", async (event, kind: unknown) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.OpenDialogOptions =
      kind === "zip"
        ? { title: "Import experts from a .zip", properties: ["openFile"], filters: [{ name: "Expert package", extensions: ["zip"] }] }
        : { title: "Import experts from a folder", properties: ["openDirectory"] };
    const res = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    const path = res.filePaths[0];
    return res.canceled || !path ? null : path;
  });
  ipcMain.handle("experts:remove", (_e, id: unknown) => {
    if (typeof id !== "string") throw new Error("Invalid expert id.");
    removeImportedExpert(join(userData, "experts"), id);
  });
  ipcMain.handle("threads:update", (_e, id: string, patch: Partial<Pick<Thread, "title" | "model" | "effort" | "contextWindow" | "permissionMode" | "agent" | "pinned" | "archived">>) =>
    service.updateThread(id, pick(patch, ["title", "model", "effort", "contextWindow", "permissionMode", "agent", "pinned", "archived"])),
  );
  ipcMain.handle("threads:delete", async (_e, id: string) => {
    await service.deleteThread(id);
    // Its team workspace and Codex member roles go with it.
    teamToolLists.delete(id);
    rmSync(teamRunDir(id), { recursive: true, force: true });
    rmSync(join(userData, "codex-roles", id), { recursive: true, force: true });
  });
  ipcMain.handle("threads:switch", (_e, id: string, agent: string, mode: SwitchMode, model?: string) => service.switchAgent(id, agent, mode, model));
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
  ipcMain.handle("events:page", (_e, threadId: string, opts?: { beforeSeq?: unknown; minEvents?: unknown }) => {
    // Numbers only; minEvents is capped so a window can't ask for the whole thread.
    const page: { beforeSeq?: number; minEvents?: number } = {};
    if (typeof opts?.beforeSeq === "number" && Number.isFinite(opts.beforeSeq)) page.beforeSeq = Math.floor(opts.beforeSeq);
    if (typeof opts?.minEvents === "number" && Number.isFinite(opts.minEvents)) page.minEvents = Math.min(20_000, Math.max(1, Math.floor(opts.minEvents)));
    return store.listEventsPage(threadId, page);
  });
  ipcMain.handle("thread:totals", (_e, threadId: string) => store.threadTotals(threadId));
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
  ipcMain.handle("pending:get", () => service.pendingState());
  ipcMain.handle("question:respond", (_e, requestId: string, answer: unknown) => service.respondQuestion(requestId, questionAnswerOf(answer)));
  ipcMain.handle("diff:get", (_e, projectId: string, threadId?: string | null) => service.getDiff(projectId, threadId));
  // /doctor: the core CLIs always, plus the other ACP agents found; a fix is looked up in the app's own last report.
  const doctorAgents = (): GatherDeps["agents"] => {
    const core = [
      { id: "claude", label: "Claude Code", command: "claude", installHint: "curl -fsSL https://claude.ai/install.sh | bash" },
      { id: "codex", label: "Codex", command: "codex", installHint: "npm install -g @openai/codex" },
      { id: "opencode", label: "OpenCode", command: "opencode", installHint: "npm install -g opencode-ai" },
    ];
    const ids = new Set(core.map((a) => a.id));
    const extra = acpAgents.filter((a) => !ids.has(a.id) && !a.command.includes("/") && !a.command.includes("\\")).map((a) => ({ id: a.id, label: a.label, command: a.command, installHint: a.install ?? null }));
    return [...core, ...extra];
  };
  const pinned = (): Record<string, string> => settings.get().agentBinary ?? {};
  const doctor = createDoctor({
    agents: doctorAgents,
    pinned,
    savePin: (agent, path) => {
      const { [agent]: _old, ...rest } = pinned();
      settings.update({ agentBinary: path ? { ...rest, [agent]: path } : rest });
    },
    worktreesDir: join(userData, "worktrees"),
    liveWorktreeIds: () => new Set(Object.values(store.listAllThreads()).flat().filter((t) => t.worktreePath).map((t) => t.id)),
  });
  setBinaryPins(pinsByCommand({ agents: doctorAgents, pinned }));
  ipcMain.handle("doctor:run", () => doctor.run());
  ipcMain.handle("doctor:fix", (_e, findingId: unknown, fixIndex: unknown) => doctor.fix(String(findingId), Number(fixIndex)));
  ipcMain.handle("search:query", (_e, query: SearchQuery) =>
    store.search({
      text: typeof query?.text === "string" ? query.text.slice(0, 500) : "",
      projectId: typeof query?.projectId === "string" ? query.projectId : null,
      agent: typeof query?.agent === "string" ? query.agent : null,
      limit: typeof query?.limit === "number" ? Math.min(Math.max(1, Math.floor(query.limit)), 100) : 20,
    }),
  );
  ipcMain.handle("artifacts:list", (_e, threadId: string) => service.listArtifacts(threadId));
  ipcMain.handle("artifacts:read", (_e, threadId: string, path: string, version?: number | null) =>
    service.readArtifact(threadId, String(path), typeof version === "number" ? version : null),
  );
  // A member's newest team result, copied into the version store so the panel opens it like the plan.
  ipcMain.handle("team:member-file", (_e, threadId: string, memberId: string) => {
    const dir = teamRunDir(String(threadId));
    const name = latestFileBy(dir, String(memberId));
    const text = name ? readTeamFile(dir, name) : null;
    return name && text !== null ? service.saveTeamFile(String(threadId), name, text) : null;
  });
  ipcMain.handle("artifacts:diff", (_e, threadId: string, path: string, version?: number | null) =>
    service.artifactDiff(threadId, String(path), typeof version === "number" ? version : null),
  );
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
    applyZoom(win);
    // Chromium resets zoom per page load, and a reload would otherwise come back at its own remembered level.
    win.webContents.on("did-finish-load", () => applyZoom(win));
    win.webContents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown") return;
      const dir = zoomKey(input, process.platform === "darwin");
      if (dir === null) return;
      event.preventDefault();
      stepAppZoom(dir);
    });
    // Ctrl+wheel / pinch steps the setting too, instead of zooming behind its back.
    win.webContents.on("zoom-changed", (_e, direction) => stepAppZoom(direction === "in" ? 1 : -1));
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
    learner.dispose();
    service.dispose();
    previews.dispose();
    designWatcher.closeAll();
    shooter.close();
    terminals.dispose();
    devServers.stopAll();
    automations.dispose();
    mcpTools.flush();
    void toolServer?.then((s) => s.close());
    void mcpPool.closeAll();
    void mcpGateway.closeAll();
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
  // The smoke attaches its own webview, as the pane does once it opens.
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

/** A System-tab edit from the renderer, checked for shape (setToken checks the name and value themselves). */
function readSystemEdit(edit: unknown): DesignSystemEdit {
  const e = (edit ?? {}) as { token?: { name?: unknown; scheme?: unknown; value?: unknown }; designMd?: unknown };
  if (e.token && typeof e.token.name === "string" && typeof e.token.value === "string" && (e.token.scheme === "light" || e.token.scheme === "dark")) {
    return { token: { name: e.token.name, scheme: e.token.scheme, value: e.token.value } };
  }
  if (typeof e.designMd === "string" && e.designMd.length <= 200_000) return { designMd: e.designMd };
  throw new Error("Invalid design-system edit.");
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
