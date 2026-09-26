import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, app, dialog, ipcMain, nativeTheme, safeStorage, shell } from "electron";
import type { CredentialChoice, LiveUpdate, McpOverview, McpServerEntry, OpenResult, PermissionDecision, ProviderInput, SendRequest, Settings, Thread } from "../shared/types";
import { spawnSync } from "node:child_process";
import { createAcpDriver } from "./agents/acp/driver";
import { createClaudeDriver, resolvePackagedClaudeBinary } from "./agents/claude";
import { createCodexDriver } from "./agents/codex";
import { LimitsTracker } from "./agents/limits";
import { loadAcpAgents, onPath } from "./agents/registry";
import { BrowserController, isAllowedUrl } from "./browser/controller";
import { browserTools } from "./browser/tools";
import { Store } from "./db";
import { startToolServer, type ToolServer } from "./mcp-http";
import { TerminalManager } from "./terminal";
import { Service } from "./service";
import { catalogFor, testConnection } from "./providers";
import { injectionFor } from "./inject";
import { redactSecrets } from "./inject/redact";
import { codexInstructions, prepareCodexPlan } from "./inject/codex";
import { opencodeVersion } from "./inject/opencode";
import { ensureOpenCodeGuard, withOpenCodeGuard } from "./inject/opencode-guard";
import { findPython } from "./guard";
import { SettingsStore } from "./settings";
import { agentCatalog, skillDetail } from "./library";
import { Editors, realHost } from "./editors";
import { readExternalMcp } from "./mcp/external";
import { BUILT_IN_SERVER, McpServerStore, testServer, viewOf } from "./mcp/servers";
import { Updater, type UpdaterBackend } from "./updater";
import { defaultSkillsCandidates, findSkillsRoot, loadCatalog } from "./skills/catalog";
import { ensureModelSkillsDir, ensurePlugin } from "./skills/plugin";

const here = fileURLToPath(new URL(".", import.meta.url));
const smoke = process.argv.includes("--smoke");

/**
 * Apps launched from the Dock get launchd's PATH, not the shell's, so
 * `npm -g` tools (codex, agy-acp, opencode) never resolve. Prepend the
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
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 880,
    minHeight: 560,
    show: false,
    title: "UnSkilled",
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
    backgroundMaterial: isWin ? "mica" : undefined,
    backgroundColor: isMac || isWin ? "#00000000" : nativeTheme.shouldUseDarkColors ? "#1c1c1e" : "#f5f5f7",
    webPreferences: {
      preload: join(here, "../preload/index.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true, // the browser pane
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
  await app.whenReady();

  const userData = app.getPath("userData");
  mkdirSync(userData, { recursive: true });
  const store = new Store(join(userData, "unskilled.db"));
  const settings = new SettingsStore(join(userData, "settings.json"), {
    available: safeStorage.isEncryptionAvailable(),
    encrypt: (s) => safeStorage.encryptString(s).toString("base64"),
    decrypt: (b) => safeStorage.decryptString(Buffer.from(b, "base64")),
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
  const catalog = loadCatalog(root);
  const pluginDir = join(userData, "harness-plugin");
  const windows = new Set<BrowserWindow>();
  const broadcast = (update: LiveUpdate) => {
    for (const w of windows) if (!w.isDestroyed()) w.webContents.send("unskilled:update", update);
  };
  // Plan rate limits, fed only by what agents report during turns: no polling.
  const limits = new LimitsTracker((l) => broadcast({ type: "limits", limits: l }));
  const guardScript = root?.skillsDir ? join(root.skillsDir, "git-guardrails", "scripts", "block-dangerous-git.py") : "";
  const driver = createClaudeDriver({
    pluginDir: () => ensurePlugin(catalog, pluginDir),
    guardScript,
    onLimits: limits.for("claude"),
    injection: () => injectionFor(settings, "claude"),
    byokModels: () => {
      const c = settings.credential("claude");
      if (c.kind !== "byok") return null;
      const p = settings.providers().find((x) => x.id === c.providerId);
      return p ? catalogFor(p).claude.models : null;
    },
  });
  const browser = new BrowserController(
    (url) => broadcast({ type: "browser-open", url }),
    join(userData, "screenshots"),
    (text) => broadcast({ type: "browser-picked", text }),
  );
  const tools = browserTools(browser);
  augmentPath();
  // Claude first (the default for new threads), then any installed ACP agents.
  const { agents: acpAgents, custom: customAgents, problems } = loadAcpAgents(join(userData, "agents.json"));
  for (const p of problems) console.warn(p);
  const modelSkillsDir = join(userData, "harness-skills");
  const enabledTools = () => (browser.enabled ? tools : []);
  // Started on first use, for Codex and ACP agents, which take tools over MCP.
  let toolServer: Promise<ToolServer> | null = null;
  const getToolServer = () => (toolServer ??= startToolServer(enabledTools));
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
            skillsDir: () => ensureModelSkillsDir(catalog, modelSkillsDir),
            toolServer: getToolServer,
            onLimits: limits.for("codex"),
            injection: () =>
              prepareCodexPlan(
                injectionFor(settings, "codex", process.env, {
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
      const python = config.guardPlugin === "opencode" && guardScript ? findPython() : null;
      const driverConfig =
        python && config.guardPlugin === "opencode"
          ? { ...config, capabilities: { ...config.capabilities, preToolGuard: true, guardEnforcement: { ask: "block" as const, "auto-edit": "block" as const, full: "block" as const } } }
          : config;
      return createAcpDriver(driverConfig, {
        skillsDir: () => ensureModelSkillsDir(catalog, modelSkillsDir),
        clientVersion: app.getVersion(),
        toolServer: getToolServer,
        guardScript,
        injection: () => {
          const plan = injectionFor(settings, config.id, process.env, {
            agentLabel: config.label,
            ...(config.injector === "opencode" ? { opencodeVersion: () => opencodeVersion(config.command) } : {}),
          });
          if (!python || config.guardPlugin !== "opencode") return plan;
          return withOpenCodeGuard(plan, { pluginUrl: ensureOpenCodeGuard(join(userData, "opencode")), script: guardScript, python });
        },
      });
    }),
  ];
  // Model lists that only appear once an agent has run: ask for them now so
  // the picker isn't empty on first open. Each driver notifies when ready.
  for (const d of drivers) {
    void (d.refreshModels?.() ?? Promise.resolve()).finally(() => broadcast({ type: "agents" }));
  }
  const mcpStore = new McpServerStore(join(userData, "mcp.json"));
  const service = new Service(
    store,
    catalog,
    drivers,
    broadcast,
    enabledTools,
    () => {
      const s = settings.get();
      return { agent: s.defaultAgent, permissionMode: s.defaultPermissionMode };
    },
    () => mcpStore.enabled(),
    knownSecrets,
  );

  // The Library: skills, agents, and MCP servers, as the agents will see them.
  const catalogOfAgents = () => agentCatalog({ installed: (c) => onPath(c), custom: customAgents });
  const projectPathOf = (projectId: string | null) => {
    try {
      return projectId ? store.getProject(projectId).path : null;
    } catch {
      return null;
    }
  };
  const mcpOverview = (projectId: string | null): McpOverview => ({
    builtIn: {
      name: BUILT_IN_SERVER,
      active: browser.enabled,
      tools: tools.map((t) => ({ name: t.name, description: t.description, autoAllow: t.autoAllow })),
    },
    servers: mcpStore.list().map(viewOf),
    external: readExternalMcp({ projectPath: projectPathOf(projectId) }),
    file: join(userData, "mcp.json"),
  });
  ipcMain.handle("library:skills", () => catalog.skills);
  ipcMain.handle("library:skill", (_e, name: string) => skillDetail(catalog, name, catalogOfAgents()));
  ipcMain.handle("library:agents", () => catalogOfAgents());
  ipcMain.handle("mcp:get", (_e, projectId: string | null) => mcpOverview(projectId));
  ipcMain.handle("mcp:save", (_e, entry: McpServerEntry, previousName?: string) => {
    mcpStore.save(entry, previousName);
    return mcpOverview(null);
  });
  ipcMain.handle("mcp:remove", (_e, name: string) => {
    mcpStore.remove(name);
    return mcpOverview(null);
  });
  ipcMain.handle("mcp:enable", (_e, name: string, enabled: boolean) => {
    mcpStore.setEnabled(name, enabled);
    return mcpOverview(null);
  });
  ipcMain.handle("mcp:test", async (_e, name: string) => {
    const entry = mcpStore.list().find((s) => s.name === name);
    return entry ? testServer(entry.spec) : { ok: false, tools: [], error: "No such server." };
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
  ipcMain.handle("threads:list", (_e, projectId: string) => store.listThreads(projectId));
  ipcMain.handle("threads:create", (_e, projectId: string, agent?: string) => service.createThread(projectId, agent));
  ipcMain.handle("threads:update", (_e, id: string, patch: Partial<Pick<Thread, "title" | "model" | "permissionMode" | "agent">>) =>
    service.updateThread(id, pick(patch, ["title", "model", "permissionMode", "agent"])),
  );
  ipcMain.handle("threads:delete", (_e, id: string) => {
    service.interrupt(id);
    store.deleteThread(id);
  });
  ipcMain.handle("events:list", (_e, threadId: string) => store.listEvents(threadId));
  ipcMain.handle("skills:list", () => service.listSkills());
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
  ipcMain.handle("diff:get", (_e, projectId: string) => service.getDiff(projectId));
  ipcMain.handle("browser:attached", (_e, webContentsId: number) => browser.attach(webContentsId));
  ipcMain.handle("browser:pick", () => browser.startPick());
  const terminals = new TerminalManager({
    data: (id, data) => broadcast({ type: "terminal-data", id, data }),
    exit: (id, code) => broadcast({ type: "terminal-exit", id, code }),
  });
  ipcMain.handle("terminal:open", (_e, id: string, cwd: string | null, cols: number, rows: number) => terminals.open(id, cwd, cols, rows));
  ipcMain.on("terminal:write", (_e, id: string, data: string) => terminals.write(id, data));
  ipcMain.on("terminal:resize", (_e, id: string, cols: number, rows: number) => terminals.resize(id, cols, rows));
  ipcMain.handle("terminal:close", (_e, id: string) => terminals.close(id));

  const open = () => {
    const win = createWindow();
    windows.add(win);
    win.on("closed", () => windows.delete(win));
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
          "typeof window.unskilled === 'object' && Promise.all([window.unskilled.listSkills(), window.unskilled.getSettings(), window.unskilled.listAllSkills(), window.unskilled.getMcp(null), window.unskilled.listAgentCatalog()]).then(([s, st, all, mcp, agents]) => Array.isArray(s) && typeof st.theme === 'string' && Array.isArray(all) && mcp.builtIn.tools.length > 0 && agents.some((a) => a.id === 'claude'))",
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
        const shot = process.env.UNSKILLED_SMOKE_SCREENSHOT;
        if (shot) {
          first.showInactive();
          await new Promise((r) => setTimeout(r, 800));
          writeFileSync(shot, (await first.webContents.capturePage()).toPNG());
          console.log(`smoke: screenshot ${shot}`);
        }
        const all = ok && binaryOk && browserOk && terminalOk;
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
    service.dispose();
    terminals.dispose();
    void toolServer?.then((s) => s.close());
    store.close();
  });
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
    const ok = after.text.includes("Hello ada@example.com") && logs.text.includes("smoke-console-check") && pickOk;
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
  dialog.showErrorBox("UnSkilled could not start", err instanceof Error ? err.message : String(err));
  app.exit(1);
});
