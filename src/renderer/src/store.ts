import { create } from "zustand";
import type {
  EditorInfo,
  AgentLimits,
  AppUpdateStatus,
  LiveDelta,
  SettingsView,
  AgentInfo,
  LiveUpdate,
  PermissionRequest,
  Project,
  SkillEntry,
  StoredEvent,
  Thread,
} from "../../shared/types";
import { api } from "./api";
import { appendDelta, applyLiveEvent, emptyLive, flushPending, type LiveThread } from "./live";

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
  permissions: PermissionRequest[];
  inspectorOpen: boolean;
  inspectorTab: "changes" | "browser" | "terminal";
  /** The browser pane has been shown this session, so its <webview> stays mounted. */
  browserMounted: boolean;
  /** A URL for the browser pane to load. */
  browserUrl: string | null;
  /** The user is picking an element in the browser pane. */
  picking: boolean;
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
  updateThread(patch: Partial<Pick<Thread, "title" | "model" | "permissionMode" | "agent">>): Promise<void>;
  send(text: string, skill?: string): Promise<void>;
  interrupt(): Promise<void>;
  respond(requestId: string, decision: "allow-once" | "allow-always" | "deny"): Promise<void>;
  toggleInspector(): void;
  showInspector(tab: "changes" | "browser" | "terminal"): void;
  /** Terminals opened this session (by project id, or "home"), kept mounted so their shells survive tab switches. */
  terminals: string[];
  apply(update: LiveUpdate): void;
}

function upsertThread(list: Thread[] | undefined, thread: Thread): Thread[] {
  const rest = (list ?? []).filter((t) => t.id !== thread.id);
  return [thread, ...rest].sort((a, b) => b.updatedAt - a.updatedAt);
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
  lastAgent: null,
  selectedProjectId: null,
  selectedThreadId: null,
  events: {},
  live: {},
  running: {},
  permissions: [],
  inspectorOpen: false,
  inspectorTab: "changes",
  browserMounted: false,
  terminals: [],
  browserUrl: null,
  picking: false,
  composerInsert: null,

  async startPick() {
    set({ picking: true });
    try {
      await api().browserPick();
    } catch {
      set({ picking: false });
    }
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
    const limits = Object.fromEntries(limitList.map((l) => [l.agent, l]));
    set((s) => ({ projects, skills, agents, threads, settings, appUpdate, limits: { ...limits, ...s.limits } }));
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

  toggleInspector() {
    set((s) => ({ inspectorOpen: !s.inspectorOpen }));
  },

  showInspector(tab) {
    set((s) => {
      // Clicking the open tab's button again closes the inspector.
      if (s.inspectorOpen && s.inspectorTab === tab) return { inspectorOpen: false };
      const term = s.selectedProjectId ?? "home";
      return {
        inspectorOpen: true,
        inspectorTab: tab,
        browserMounted: s.browserMounted || tab === "browser",
        terminals: tab === "terminal" && !s.terminals.includes(term) ? [...s.terminals, term] : s.terminals,
      };
    });
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
        if (!update.running) {
          for (let i = queued.length - 1; i >= 0; i--) if (queued[i]!.threadId === update.threadId) queued.splice(i, 1);
        }
        set((s) => ({
          running: { ...s.running, [update.threadId]: update.running },
          live: update.running ? s.live : { ...s.live, [update.threadId]: emptyLive() },
          permissions: update.running ? s.permissions : s.permissions.filter((p) => p.threadId !== update.threadId),
          diffVersion: update.running ? s.diffVersion : s.diffVersion + 1,
        }));
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
      case "settings":
        applyTheme(update.settings.theme);
        set({ settings: update.settings });
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
