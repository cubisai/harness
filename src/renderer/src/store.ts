import { create } from "zustand";
import type {
  BrowserState,
  DevicePreset,
  EditorInfo,
  AgentLimits,
  AppUpdateStatus,
  LiveDelta,
  SettingsView,
  AgentInfo,
  LiveUpdate,
  PaneLayout,
  PermissionRequest,
  Project,
  SkillEntry,
  StoredEvent,
  SwitchMode,
  SwitchResult,
  Thread,
} from "../../shared/types";
import { api } from "./api";
import { appendDelta, applyLiveEvent, emptyLive, flushPending, type LiveThread } from "./live";
import { DEFAULT_LAYOUT, sanitizeLayout } from "./layout";
import { IDLE, takeOverReducer, type TakeOverState } from "./takeover";

export type LibraryTab = "experts" | "skills" | "connectors" | "mcp" | "agents";

interface State {
  projects: Project[];
  threads: Record<string, Thread[]>; // by project id
  skills: SkillEntry[];
  agents: AgentInfo[];
  settings: SettingsView | null;
  settingsOpen: boolean;
  setSettingsOpen(open: boolean): void;
  appUpdate: AppUpdateStatus | null;
  /** Plan rate limits by agent id, as the agents last reported them. */
  limits: Record<string, AgentLimits>;
  paletteOpen: boolean;
  setPaletteOpen(open: boolean): void;
  /** The agent a pending Switch dialog would move the thread to. */
  pendingSwitch: string | null;
  openSwitch(agent: string | null): void;
  /** Move the open thread to another agent; returns an error message, or null when done. */
  switchAgent(agent: string, mode: SwitchMode): Promise<string | null>;
  /** Installed editors, for "Open in". */
  editors: EditorInfo[];
  /** A short message at the bottom of the window (an editor that didn't open). */
  notice: string | null;
  showNotice(text: string): void;
  /** Open a file (relative to the project, at a line) or the project itself in an editor. */
  openInEditor(target: { path?: string; line?: number; column?: number }, editor?: string): Promise<void>;
  /** The Library sheet's tab, or null when it's closed. */
  libraryTab: LibraryTab | null;
  /** A skill for the Library to show first. */
  librarySkill: string | null;
  /** The agent new threads start with: the last one picked. */
  lastAgent: string | null;
  selectedProjectId: string | null;
  selectedThreadId: string | null;
  events: Record<string, StoredEvent[]>; // by thread id
  live: Record<string, LiveThread>; // streaming state not yet stored
  running: Record<string, boolean>;
  /** Pinned threads; session-local until pins get a column (Phase 8 Pass 3). */
  pinned: Record<string, boolean>;
  togglePin(threadId: string): void;
  /** Each project's current branch, or null on its default branch, detached, or outside git. */
  projectBranches: Record<string, string | null>;
  loadBranch(projectId: string): Promise<void>;
  /** Which tool disclosures are open, by thread id and disclosure id; never persisted. */
  disclosures: Record<string, Record<string, boolean>>;
  setDisclosure(threadId: string, id: string, open: boolean): void;
  permissions: PermissionRequest[];
  /** Panel widths and collapse state; the raw setting, drawn through clampLayout. */
  paneLayout: PaneLayout;
  setPaneLayout(patch: Partial<PaneLayout>, persist: boolean): void;
  inspectorOpen: boolean;
  inspectorTab: "changes" | "browser";
  /** The browser pane has been shown this session, so its <webview> stays mounted. */
  browserMounted: boolean;
  /** A URL for the browser pane to load. */
  browserUrl: string | null;
  /** The user is picking an element in the browser pane. */
  picking: boolean;
  /** Who holds the browser pane's pointer: the agent, the user, or nobody. */
  takeOver: TakeOverState;
  /** A click or key in the browser pane: the user takes the pointer and pauses the agent. */
  browserInput(): void;
  /** Hand the pointer back to the agent and resume its acting tools. */
  resumeAgent(): void;
  /** The user ends the turn: pause lifted, agent interrupted. */
  stopAgent(): Promise<void>;
  setWatch(on: boolean): void;
  /** The browser pane's device, console lines and screenshots, pushed in-band. */
  browser: BrowserState;
  /** browserState() has been fetched; the panel only asks for it once. */
  browserLoaded: boolean;
  /** Fetch the browser pane's state, once. */
  loadBrowserState(): Promise<void>;
  /** Emulate a viewport in the browser pane; the store updates from the push. */
  setBrowserDevice(device: DevicePreset): Promise<void>;
  /** Give the browser the main area, with the conversation as a rail. */
  toggleBrowserWide(): void;
  /** Text to add to the message box (a picked element), with a nonce so repeats still apply. */
  composerInsert: { text: string; nonce: number } | null;
  startPick(): Promise<void>;
  /** A skill to pre-fill in the composer, set by the empty-state shortcuts. */
  pendingSkill: string | null;
  diffVersion: number; // bumps when a turn ends, so the diff refreshes

  init(): Promise<void>;
  addProject(): Promise<void>;
  selectProject(id: string): Promise<void>;
  selectThread(id: string | null): Promise<void>;
  newThread(skill?: string): Promise<void>;
  takePendingSkill(): string | null;
  /** Save the open thread to a JSON file. */
  exportThread(): Promise<void>;
  /** Restore a thread export into the selected project and open it. */
  importThread(): Promise<void>;
  updateThread(patch: Partial<Pick<Thread, "title" | "model" | "permissionMode" | "agent">>): Promise<void>;
  send(text: string, skill?: string): Promise<void>;
  interrupt(): Promise<void>;
  respond(requestId: string, decision: "allow-once" | "allow-always" | "deny"): Promise<void>;
  toggleInspector(): void;
  showInspector(tab: "changes" | "browser"): void;
  toggleTerminal(): void;
  /** Add the current terminal to `terminals` if missing, so its shell is mounted. */
  ensureTerminal(): void;
  /** Terminals opened this session (by project id, or "home"), kept mounted so their shells survive the drawer closing. */
  terminals: string[];
  apply(update: LiveUpdate): void;
}

function upsertThread(list: Thread[] | undefined, thread: Thread): Thread[] {
  const rest = (list ?? []).filter((t) => t.id !== thread.id);
  return [thread, ...rest].sort((a, b) => b.updatedAt - a.updatedAt);
}

function ipcErrorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

let initialized = false;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;

// Live deltas are batched: tokens accumulate in the queue and land in the
// store at most once per frame, instead of one write per token.
const queued: { threadId: string; delta: LiveDelta }[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

/** Apply every queued delta, flush each touched thread, and empty the queue. */
function drainQueue(s: State): Record<string, LiveThread> {
  const live = { ...s.live };
  const touched = new Set<string>();
  for (const { threadId, delta } of queued) {
    live[threadId] = appendDelta(live[threadId] ?? emptyLive(), delta);
    touched.add(threadId);
  }
  for (const threadId of touched) live[threadId] = flushPending(live[threadId]!);
  queued.length = 0;
  return live;
}

/** "system" follows the OS; "light"/"dark" pin the CSS tokens (styles/app.css). */
export function applyTheme(theme: SettingsView["theme"]): void {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  window.dispatchEvent(new Event("unskilled-theme"));
}

export function isDark(): boolean {
  const forced = document.documentElement.dataset.theme;
  return forced ? forced === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
}

export const useStore = create<State>((set, get) => ({
  projects: [],
  threads: {},
  skills: [],
  agents: [],
  settings: null,
  settingsOpen: false,
  setSettingsOpen(open) {
    set({ settingsOpen: open });
  },
  appUpdate: null,
  limits: {},
  paletteOpen: false,
  pendingSwitch: null,
  libraryTab: null,
  librarySkill: null,
  editors: [],
  notice: null,
  showNotice(text) {
    set({ notice: text });
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => set({ notice: null }), 3500);
  },
  async openInEditor(target, editor) {
    const s = get();
    const project = s.projects.find((p) => p.id === s.selectedProjectId);
    const path = target.path ?? project?.path;
    if (!path) return;
    const res = await api().openInEditor({ projectId: s.selectedProjectId, path, line: target.line, column: target.column }, editor);
    if (!res.ok) get().showNotice(res.error);
  },
  setPaletteOpen(open) {
    set({ paletteOpen: open });
  },
  openSwitch(agent) {
    set({ pendingSwitch: agent });
  },
  async switchAgent(agent, mode) {
    const id = get().selectedThreadId;
    if (!id) return "No thread is open.";
    let res: SwitchResult;
    try {
      if (mode === "back") {
        // updateThread already resumes the kept session for that agent.
        await get().updateThread({ agent });
        return null;
      }
      res = await api().switchAgent(id, agent, mode);
    } catch (err) {
      return ipcErrorText(err);
    }
    if (!res.ok) return res.reason;
    set({ lastAgent: agent });
    get().apply({ type: "thread", thread: res.thread });
    // A new agent may report its models only once it has run; refresh the list.
    set({ agents: await api().listAgents() });
    const events = await api().listEvents(id);
    set((s) => ({ events: { ...s.events, [id]: events } }));
    // The switch happened even when the handoff didn't land; say so outside the dialog.
    if (res.warning) get().showNotice(res.warning);
    return null;
  },
  lastAgent: null,
  selectedProjectId: null,
  selectedThreadId: null,
  events: {},
  live: {},
  running: {},
  pinned: {},
  togglePin(threadId) {
    set((s) => {
      const { [threadId]: was, ...rest } = s.pinned;
      return { pinned: was ? rest : { ...rest, [threadId]: true } };
    });
  },
  projectBranches: {},
  async loadBranch(projectId) {
    const branch = await api()
      .projectBranch(projectId)
      .catch(() => null);
    set((s) => ({ projectBranches: { ...s.projectBranches, [projectId]: branch } }));
  },
  disclosures: {},
  permissions: [],
  paneLayout: { ...DEFAULT_LAYOUT },
  inspectorOpen: false,
  inspectorTab: "changes",
  browserMounted: false,
  terminals: [],
  browserUrl: null,
  picking: false,
  takeOver: IDLE,
  browser: { device: "desktop", logs: [], screenshots: [] },
  browserLoaded: false,
  composerInsert: null,

  async loadBrowserState() {
    // Called when the browser panel mounts, never on every render.
    if (get().browserLoaded) return;
    set({ browserLoaded: true });
    set({ browser: await api().browserState() });
  },

  async setBrowserDevice(device) {
    await api().browserDevice(device);
    // The browser-device push carries the new device into the store.
  },

  toggleBrowserWide() {
    const s = get();
    const wide = !s.paneLayout.browserWide;
    s.setPaneLayout({ browserWide: wide }, true);
    // An emulated phone frame must never be measured as a desktop page.
    if (wide && s.browser.device !== "desktop") void api().browserDevice("desktop");
    if (wide && !(s.inspectorOpen && s.inspectorTab === "browser")) s.showInspector("browser");
  },

  async startPick() {
    set({ picking: true });
    try {
      await api().browserPick();
    } catch {
      set({ picking: false });
    }
  },

  browserInput() {
    const cur = get().takeOver;
    const next = takeOverReducer(cur, { type: "human-input" });
    if (next === cur) return;
    set({ takeOver: next });
    if (next.mode === "human-driving") void api().browserTakeOver(true);
  },

  resumeAgent() {
    const cur = get().takeOver;
    const next = takeOverReducer(cur, { type: "resume" });
    if (next === cur) return;
    set({ takeOver: next });
    void api().browserTakeOver(false);
  },

  async stopAgent() {
    set((s) => ({ takeOver: takeOverReducer(s.takeOver, { type: "stop" }) }));
    void api().browserTakeOver(false);
    await get().interrupt();
  },

  setWatch(on) {
    set((s) => ({ takeOver: takeOverReducer(s.takeOver, { type: "watch", on }) }));
  },
  pendingSkill: null,
  diffVersion: 0,

  async init() {
    // React StrictMode runs effects twice in development; subscribe once.
    if (initialized) return;
    initialized = true;
    // Subscribe before the first await, so no update sent during startup is lost.
    api().onUpdate((u) => get().apply(u));
    const [projects, skills, agents, settings, appUpdate, limitList] = await Promise.all([
      api().listProjects(),
      api().listSkills(),
      api().listAgents(),
      api().getSettings(),
      api().updateStatus(),
      api().listLimits(),
    ]);
    void api()
      .listEditors()
      .then((editors) => set({ editors }));
    applyTheme(settings.theme);
    const threads: Record<string, Thread[]> = {};
    for (const p of projects) threads[p.id] = await api().listThreads(p.id);
    for (const p of projects) void get().loadBranch(p.id);
    const limits = Object.fromEntries(limitList.map((l) => [l.agent, l]));
    set((s) => ({ projects, skills, agents, threads, settings, paneLayout: sanitizeLayout(settings.paneLayout), appUpdate, limits: { ...limits, ...s.limits } }));
    const first = projects[0];
    if (first) {
      await get().selectProject(first.id);
      const recent = threads[first.id]?.[0];
      if (recent) await get().selectThread(recent.id);
    }
  },

  async addProject() {
    const project = await api().addProject();
    if (!project) return;
    const threads = await api().listThreads(project.id);
    set((s) => ({
      projects: s.projects.some((p) => p.id === project.id)
        ? s.projects
        : [...s.projects, project].sort((a, b) => a.name.localeCompare(b.name)),
      threads: { ...s.threads, [project.id]: threads },
    }));
    await get().selectProject(project.id);
  },

  async selectProject(id) {
    set({ selectedProjectId: id });
    void get().loadBranch(id);
    if (!get().threads[id]) {
      const list = await api().listThreads(id);
      set((s) => ({ threads: { ...s.threads, [id]: list } }));
    }
  },

  async selectThread(id) {
    set({ selectedThreadId: id });
    if (id && !get().events[id]) {
      const events = await api().listEvents(id);
      set((s) => ({ events: { ...s.events, [id]: events } }));
    }
  },

  async newThread(skill) {
    const projectId = get().selectedProjectId;
    if (!projectId) return;
    const thread = await api().createThread(projectId, get().lastAgent ?? undefined);
    set((s) => ({
      pendingSkill: skill ?? null,
      threads: { ...s.threads, [projectId]: upsertThread(s.threads[projectId], thread) },
      events: { ...s.events, [thread.id]: [] },
      selectedThreadId: thread.id,
    }));
  },

  takePendingSkill() {
    const skill = get().pendingSkill;
    if (skill) set({ pendingSkill: null });
    return skill;
  },

  async exportThread() {
    const id = get().selectedThreadId;
    if (!id) return;
    try {
      const path = await api().exportThread(id);
      if (path) get().showNotice(`Exported to ${path}`);
    } catch (err) {
      get().showNotice(ipcErrorText(err));
    }
  },

  async importThread() {
    const projectId = get().selectedProjectId;
    if (!projectId) return;
    try {
      const thread = await api().importThread(projectId);
      if (!thread) return;
      set((s) => ({ threads: { ...s.threads, [projectId]: upsertThread(s.threads[projectId], thread) } }));
      await get().selectThread(thread.id);
    } catch (err) {
      get().showNotice(ipcErrorText(err));
    }
  },

  async updateThread(patch) {
    const id = get().selectedThreadId;
    if (!id) return;
    const thread = await api().updateThread(id, patch);
    if (patch.agent) set({ lastAgent: patch.agent });
    get().apply({ type: "thread", thread });
    // A new agent may report its models only once it has run; refresh the list.
    if (patch.agent) set({ agents: await api().listAgents() });
  },

  async send(text, skill) {
    const id = get().selectedThreadId;
    if (!id || get().running[id]) return;
    set((s) => ({ running: { ...s.running, [id]: true } }));
    await api().send({ threadId: id, text, skill });
  },

  async interrupt() {
    const id = get().selectedThreadId;
    if (id) await api().interrupt(id);
  },

  async respond(requestId, decision) {
    set((s) => ({ permissions: s.permissions.filter((p) => p.requestId !== requestId) }));
    await api().respondPermission(requestId, decision);
  },

  setDisclosure(threadId, id, open) {
    set((s) => {
      const thread = { ...(s.disclosures[threadId] ?? {}) };
      if (open) thread[id] = true;
      else delete thread[id];
      return { disclosures: { ...s.disclosures, [threadId]: thread } };
    });
  },

  setPaneLayout(patch, persist) {
    const next = { ...get().paneLayout, ...patch };
    set({ paneLayout: next });
    if (persist) void api().updateSettings({ paneLayout: next });
  },

  toggleInspector() {
    set((s) => ({ inspectorOpen: !s.inspectorOpen }));
  },

  showInspector(tab) {
    const opens = !(get().inspectorOpen && get().inspectorTab === tab);
    set((s) => {
      // Clicking the open tab's button again closes the inspector.
      if (s.inspectorOpen && s.inspectorTab === tab) return { inspectorOpen: false };
      return {
        inspectorOpen: true,
        inspectorTab: tab,
        browserMounted: s.browserMounted || tab === "browser",
      };
    });
    // Reopening restores a collapsed inspector at its stored width.
    if (opens && get().paneLayout.inspectorCollapsed) get().setPaneLayout({ inspectorCollapsed: false }, true);
  },

  ensureTerminal() {
    const term = get().selectedProjectId ?? "home";
    set((s) => (s.terminals.includes(term) ? {} : { terminals: [...s.terminals, term] }));
  },

  toggleTerminal() {
    const open = !get().paneLayout.terminalOpen;
    if (open) get().ensureTerminal();
    get().setPaneLayout({ terminalOpen: open }, true);
  },

  apply(update) {
    switch (update.type) {
      case "event":
        set((s) => {
          const list = s.events[update.threadId] ?? [];
          if (list.some((e) => e.seq === update.stored.seq)) return {};
          // Deltas that arrived before this terminal event must land first.
          const live = drainQueue(s);
          live[update.threadId] = applyLiveEvent(live[update.threadId] ?? emptyLive(), update.stored);
          return {
            events: { ...s.events, [update.threadId]: [...list, update.stored] },
            live,
          };
        });
        return;
      case "delta": {
        queued.push({ threadId: update.threadId, delta: update.delta });
        if (!timer) {
          timer = setTimeout(() => {
            timer = null;
            set((s) => ({ live: drainQueue(s) }));
          }, 16);
        }
        return;
      }
      case "running":
        if (!update.running) void api().listAgents().then((agents) => set({ agents }));
        // A turn may have switched branches.
        if (!update.running && get().selectedProjectId) void get().loadBranch(get().selectedProjectId!);
        if (!update.running) {
          for (let i = queued.length - 1; i >= 0; i--) if (queued[i]!.threadId === update.threadId) queued.splice(i, 1);
        }
        set((s) => ({
          running: { ...s.running, [update.threadId]: update.running },
          live: update.running ? s.live : { ...s.live, [update.threadId]: emptyLive() },
          permissions: update.running ? s.permissions : s.permissions.filter((p) => p.threadId !== update.threadId),
          diffVersion: update.running ? s.diffVersion : s.diffVersion + 1,
        }));
        if (!update.running && get().takeOver.mode !== "idle") {
          // The pause must never outlive the turn.
          set((s) => ({ takeOver: takeOverReducer(s.takeOver, { type: "turn-ended" }) }));
          void api().browserTakeOver(false);
        }
        return;
      case "permission":
        set((s) =>
          s.permissions.some((p) => p.requestId === update.request.requestId)
            ? {}
            : { permissions: [...s.permissions, update.request] },
        );
        return;
      case "browser-open":
        set({ inspectorOpen: true, inspectorTab: "browser", browserMounted: true, browserUrl: update.url ?? null });
        return;
      case "browser-picked":
        set((s) => ({
          picking: false,
          composerInsert: update.text ? { text: update.text, nonce: (s.composerInsert?.nonce ?? 0) + 1 } : s.composerInsert,
        }));
        return;
      case "browser-log":
        set((s) => ({
          browser: {
            ...s.browser,
            logs: update.entry === null ? [] : [...s.browser.logs.slice(-199), update.entry],
          },
        }));
        return;
      case "browser-screenshot":
        set((s) => ({ browser: { ...s.browser, screenshots: [...s.browser.screenshots, update.shot] } }));
        return;
      case "browser-device":
        set((s) => ({ browser: { ...s.browser, device: update.device } }));
        return;
      case "browser-action":
        set((s) => ({ takeOver: takeOverReducer(s.takeOver, { type: "agent-action" }) }));
        return;
      case "settings":
        applyTheme(update.settings.theme);
        // A broadcast during a drag would fight the pointer; keep the local layout then.
        set((s) => ({
          settings: update.settings,
          paneLayout: typeof document !== "undefined" && document.body.classList.contains("resizing") ? s.paneLayout : sanitizeLayout(update.settings.paneLayout),
        }));
        return;
      case "app-update":
        set({ appUpdate: update.status });
        return;
      case "limits":
        set((s) => ({ limits: { ...s.limits, [update.limits.agent]: update.limits } }));
        return;
      case "agents":
        void api().listAgents().then((agents) => set({ agents }));
        return;
      case "thread":
        set((s) => ({
          threads: { ...s.threads, [update.thread.projectId]: upsertThread(s.threads[update.thread.projectId], update.thread) },
        }));
        return;
    }
  },
}));

export function useSelectedThread(): Thread | null {
  return useStore((s) => {
    if (!s.selectedProjectId || !s.selectedThreadId) return null;
    return s.threads[s.selectedProjectId]?.find((t) => t.id === s.selectedThreadId) ?? null;
  });
}
