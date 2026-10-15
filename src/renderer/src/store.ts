import { create } from "zustand";
import type {
  ArtifactFile,
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
  PermissionMode,
  PermissionRequest,
  PlanDecision,
  PlanRequest,
  QuestionAnswer,
  QuestionRequest,
  Project,
  SkillEntry,
  StoredEvent,
  SwitchMode,
  SwitchResult,
  Thread,
  ThreadKind,
} from "../../shared/types";
import { api } from "./api";
import { appendDelta, applyLiveEvent, emptyLive, flushPending, type LiveThread } from "./live";
import { DEFAULT_LAYOUT, sanitizeLayout } from "./layout";
import { IDLE, takeOverReducer, type TakeOverState } from "./takeover";
import { threadSeen, turnEnded, type FinishedTurn } from "./inbox";
import { threadKind } from "./sections";
import { buildInCodePrompt, buildThreadPatch, designDirName, handoffPath } from "../../shared/design";
import type { SelectedElement } from "../../shared/selection";
import type { PrototypeTier } from "../../shared/tiers";
import type { TurnScore } from "../../shared/learn";

/** A design thread's canvas selection: the page it is on and its elements. */
export interface DesignSelection {
  page: string;
  elements: SelectedElement[];
}

/** The right panel's tabs. Changes and Files need a project; Browser works without one; File shows an artifact. */
export type InspectorTab = "changes" | "browser" | "files" | "artifact";

export type LibraryTab = "experts" | "skills" | "connectors" | "mcp" | "agents" | "memory";

/** A new thread's pickers before it exists; reset once the thread is created. */
interface Draft {
  agent?: string;
  model?: string;
  effort?: string | null;
  contextWindow?: number | null;
  permissionMode?: PermissionMode;
  /** A design thread's design system (absent = the project's default). */
  designSystem?: string;
}

interface State {
  projects: Project[];
  threads: Record<string, Thread[]>; // by project id
  skills: SkillEntry[];
  agents: AgentInfo[];
  settings: SettingsView | null;
  settingsOpen: boolean;
  setSettingsOpen(open: boolean): void;
  /** The About sheet is open (macOS app menu, or Settings → Updates). */
  aboutOpen: boolean;
  setAboutOpen(open: boolean): void;
  /** The context sheet is open; true with contextSheetThread null means a new thread in the selected project. */
  contextSheetOpen: boolean;
  contextSheetThread: string | null;
  openContextSheet(threadId: string | null): void;
  closeContextSheet(): void;
  /** The /mcp sheet is open; `mcpSheetPrefill` is text to review right away (`/mcp <url|command>`). */
  mcpSheetOpen: boolean;
  mcpSheetPrefill: string;
  openMcpSheet(prefill?: string): void;
  closeMcpSheet(): void;
  appUpdate: AppUpdateStatus | null;
  /** Plan rate limits by agent id, as the agents last reported them. */
  limits: Record<string, AgentLimits>;
  paletteOpen: boolean;
  /** What the palette's input starts with (">" when search hands off to actions). */
  paletteQuery: string;
  setPaletteOpen(open: boolean, query?: string): void;
  /** ⌘K search dialog. */
  searchOpen: boolean;
  setSearchOpen(open: boolean): void;
  /** Sidebar project groups the user closed (session only). */
  collapsedProjects: Record<string, boolean>;
  toggleProjectCollapsed(projectId: string): void;
  /** The agent a pending Switch dialog would move the thread to. */
  pendingSwitch: string | null;
  /** The model the thread takes once that switch lands (a provider model picked from another agent), or null for the agent's default. */
  pendingSwitchModel: string | null;
  openSwitch(agent: string | null, model?: string): void;
  /** Move the open thread to another agent; returns an error message, or null when done. */
  switchAgent(agent: string, mode: SwitchMode): Promise<string | null>;
  /** Installed editors, for "Open in". */
  editors: EditorInfo[];
  /** A short message at the bottom of the window (an editor that didn't open). */
  notice: string | null;
  /** Set when a startup IPC call fails, so the window can offer a retry instead of a blank welcome. */
  initError: string | null;
  showNotice(text: string): void;
  /** Open a file (relative to the project, at a line) or the project itself in an editor. */
  openInEditor(target: { path?: string; line?: number; column?: number }, editor?: string): Promise<void>;
  /** The Library sheet's tab, or null when it's closed. */
  libraryTab: LibraryTab | null;
  /** A skill for the Library to show first. */
  librarySkill: string | null;
  /** The agent new threads start with: the last one picked. */
  lastAgent: string | null;
  /** The pickers for a thread that hasn't been created yet. */
  draft: Draft;
  setDraft(patch: Partial<Draft>): void;
  selectedProjectId: string | null;
  selectedThreadId: string | null;
  /** Chat or Design mode: which threads the sidebar lists and what New thread makes. Follows the selected thread. */
  threadKind: ThreadKind;
  /** Switch mode; a selected thread of the other kind gives way to the project's latest of this kind, if any. */
  setThreadKind(kind: ThreadKind): Promise<void>;
  events: Record<string, StoredEvent[]>; // by thread id
  live: Record<string, LiveThread>; // streaming state not yet stored
  running: Record<string, boolean>;
  /** Pin or unpin a thread; pins are stored with the thread. */
  togglePin(threadId: string): Promise<void>;
  renameThread(threadId: string, title: string): Promise<void>;
  /** Move a thread into (or out of) its project's Archived group; its history stays. */
  setArchived(threadId: string, archived: boolean): Promise<void>;
  /** Delete a thread and its history for good. */
  deleteThread(threadId: string): Promise<void>;
  /** Each project's current branch, or null on its default branch, detached, or outside git. */
  projectBranches: Record<string, string | null>;
  loadBranch(projectId: string): Promise<void>;
  /** Which tool disclosures are open, by thread id and disclosure id; never persisted. */
  disclosures: Record<string, Record<string, boolean>>;
  setDisclosure(threadId: string, id: string, open: boolean): void;
  permissions: PermissionRequest[];
  /** Plan proposals waiting on the user, like permissions. */
  plans: PlanRequest[];
  /** Agent questions waiting on the user, answered in the docked card. */
  questions: QuestionRequest[];
  /** Turns that ended on a thread that wasn't open, for the Message Center. */
  finished: FinishedTurn[];
  /** When each running turn started (renderer clock), for a Finished row's duration. */
  turnStartedAt: Record<string, number>;
  inboxOpen: boolean;
  setInboxOpen(open: boolean): void;
  /** Panel widths and collapse state; the raw setting, drawn through clampLayout. */
  paneLayout: PaneLayout;
  setPaneLayout(patch: Partial<PaneLayout>, persist: boolean): void;
  inspectorOpen: boolean;
  inspectorTab: InspectorTab;
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
  /** Bumped when an open design thread's folder changes, so its canvas reloads. */
  designReload: Record<string, number>;
  /** Each design thread's selected elements on its canvas (one page): chips in the composer, scope for the next message. */
  designSelection: Record<string, DesignSelection>;
  /** Set (or clear, with null or no elements) a design thread's selection. */
  setDesignSelection(threadId: string, selection: DesignSelection | null): void;
  /** Text to put back in the message box (Edit on a sent message); consumed by the composer. */
  composerDraft: { text: string; nonce: number } | null;
  setComposerDraft(text: string): void;
  startPick(): Promise<void>;
  /** A skill to pre-fill in the composer, set by the empty-state shortcuts. */
  /** Skills picked from ⌘K or the Library, waiting for the composer to add them as chips. */
  pendingSkills: string[];
  /** Bumped by the composer's "/model" command so the model picker opens. */
  openPickerRequest: number;
  requestModelPicker(): void;
  diffVersion: number; // bumps when a turn ends, so the diff refreshes

  init(): Promise<void>;
  addProject(): Promise<void>;
  /** Point a project at a newly picked folder and apply the returned row. */
  relocateProject(id: string): Promise<void>;
  deleteProject(id: string): Promise<void>;
  /** Set a project's post-turn check command and apply the returned row. */
  setCheckCommand(id: string, command: string | null, fixRounds?: number | null): Promise<void>;
  selectProject(id: string): Promise<void>;
  selectThread(id: string | null): Promise<void>;
  /** Open a new thread, returning its id (or null when nothing was created: no project, or the create failed). `worktree` gives it its own git worktree on a new branch; `designSystem` picks a design thread's system. */
  newThread(skills?: string[], opts?: { worktree?: boolean; designSystem?: string }): Promise<string | null>;
  /** Pick a design thread's design system; the next turn copies it into the design folder. */
  setDesignSystem(threadId: string, id: string): Promise<void>;
  /** Change a design thread's prototype tier. */
  setPrototypeTier(threadId: string, tier: PrototypeTier): Promise<void>;
  /** Start `text` as a new thread in the open project without leaving the current one; it reports through the Message Center. */
  sendInBackground(text: string, skills?: string[], opts?: { worktree?: boolean }, mentions?: string[]): Promise<void>;
  /** Start a chat thread (same project and agent, in the background) that builds a design thread's design into the codebase. */
  buildDesignInCode(designThreadId: string): Promise<void>;
  /** From the project's start screen: open a new thread and send `text` in it. */
  startThread(text: string, skills?: string[], mentions?: string[]): Promise<void>;
  /** Add skills for the composer to pick up (deduped, in order). */
  addPendingSkills(names: string[]): void;
  takePendingSkills(): string[];
  /** Save the open thread to a JSON file. */
  exportThread(): Promise<void>;
  /** Restore a thread export into the selected project and open it. */
  importThread(): Promise<void>;
  updateThread(patch: Partial<Pick<Thread, "title" | "model" | "effort" | "contextWindow" | "permissionMode" | "agent">>): Promise<void>;
  /** Step the open thread's reasoning effort down (-1) or up (+1), wrapping through Default. */
  cycleEffort(dir: 1 | -1): void;
  /** Start a turn on the open thread (or `threadId`); resolves false when it couldn't start (no thread, already running, or the send failed). */
  send(text: string, skills?: string[], threadId?: string, mentions?: string[]): Promise<boolean>;
  /** Compact a thread's session now (/compact), with an optional focus for the summary. */
  compact(threadId: string, focus: string | null): Promise<void>;
  /** Messages sent while a turn ran, by thread: each goes out as the next turn, in order. Stop clears them; never persisted. */
  outbox: Record<string, { text: string; skills?: string[]; mentions?: string[] }[]>;
  enqueue(threadId: string, text: string, skills?: string[], mentions?: string[]): void;
  /** Remove the queued message at `index`; drops the thread's key once its queue is empty. */
  dequeue(threadId: string, index: number): void;
  interrupt(): Promise<void>;
  respond(requestId: string, decision: "allow-once" | "allow-always" | "deny"): Promise<void>;
  respondPlan(requestId: string, decision: PlanDecision): Promise<void>;
  respondQuestion(requestId: string, answer: QuestionAnswer): Promise<void>;
  toggleInspector(): void;
  showInspector(tab: InspectorTab): void;
  /** The file shown in the panel's File tab, for one thread. */
  artifact: { threadId: string; path: string } | null;
  /** The files agents wrote, by thread, as last listed. */
  artifactFiles: Record<string, ArtifactFile[]>;
  /** Self-improve turn scores, by thread then user message seq (only opted-in projects have any). */
  turnScores: Record<string, Record<number, TurnScore>>;
  /** Show a thread file in the panel (path relative to the thread's folder, or absolute inside it). */
  openArtifact(path: string, threadId?: string): void;
  closeArtifact(): void;
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

function findThread(threads: Record<string, Thread[]>, id: string): Thread | undefined {
  return Object.values(threads)
    .flat()
    .find((t) => t.id === id);
}

/** createThread's options: the kind being shown, and a design thread's system (an explicit one beats the draft's). */
function createOpts(kind: ThreadKind, draft: Draft, opts?: { worktree?: boolean; designSystem?: string }): { worktree?: boolean; kind: ThreadKind; designSystem?: string } {
  const designSystem = kind === "design" ? (opts?.designSystem ?? draft.designSystem) : undefined;
  return { ...(opts?.worktree !== undefined ? { worktree: opts.worktree } : {}), kind, ...(designSystem ? { designSystem } : {}) };
}

/** The updates a freshly created thread needs to match the user's draft picks. */
function draftPatch(draft: Draft, thread: Thread): Partial<Pick<Thread, "model" | "effort" | "contextWindow" | "permissionMode">> {
  const patch: Partial<Pick<Thread, "model" | "effort" | "contextWindow" | "permissionMode">> = {};
  if (draft.model !== undefined && draft.model !== thread.model) patch.model = draft.model;
  if (draft.effort !== undefined && draft.effort !== thread.effort) patch.effort = draft.effort;
  if (draft.contextWindow !== undefined && draft.contextWindow !== (thread.contextWindow ?? null)) patch.contextWindow = draft.contextWindow;
  if (draft.permissionMode !== undefined && draft.permissionMode !== thread.permissionMode) patch.permissionMode = draft.permissionMode;
  return patch;
}

function ipcErrorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

let initialized = false;
let subscribed = false;
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

/** The motion preference on <html data-motion>; app.css plays entrances only for subtle/full. */
export function applyMotion(motion: SettingsView["motion"]): void {
  document.documentElement.dataset.motion = motion ?? "full";
}

/** The zoom factor as --zoom on <html>; app.css divides the macOS traffic-light inset by it, since the lights don't zoom. */
export function applyZoom(zoom: SettingsView["zoom"]): void {
  document.documentElement.style.setProperty("--zoom", String(zoom ?? 1));
}

/** The density preference on <html data-density>; app.css tightens rows for compact. */
export function applyDensity(density: SettingsView["density"]): void {
  document.documentElement.dataset.density = density ?? "comfortable";
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
  aboutOpen: false,
  setAboutOpen(open) {
    set({ aboutOpen: open });
  },
  contextSheetOpen: false,
  contextSheetThread: null,
  openContextSheet(threadId) {
    set({ contextSheetOpen: true, contextSheetThread: threadId });
  },
  closeContextSheet() {
    set({ contextSheetOpen: false, contextSheetThread: null });
  },
  mcpSheetOpen: false,
  mcpSheetPrefill: "",
  openMcpSheet(prefill) {
    set({ mcpSheetOpen: true, mcpSheetPrefill: prefill ?? "" });
  },
  closeMcpSheet() {
    set({ mcpSheetOpen: false, mcpSheetPrefill: "" });
  },
  appUpdate: null,
  limits: {},
  paletteOpen: false,
  paletteQuery: "",
  searchOpen: false,
  collapsedProjects: {},
  pendingSwitch: null,
  pendingSwitchModel: null,
  libraryTab: null,
  librarySkill: null,
  editors: [],
  notice: null,
  initError: null,
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
  setPaletteOpen(open, query = "") {
    set({ paletteOpen: open, paletteQuery: query, ...(open ? { searchOpen: false } : {}) });
  },
  setSearchOpen(open) {
    set({ searchOpen: open, ...(open ? { paletteOpen: false } : {}) });
  },
  toggleProjectCollapsed(projectId) {
    set((s) => ({ collapsedProjects: { ...s.collapsedProjects, [projectId]: !s.collapsedProjects[projectId] } }));
  },
  openSwitch(agent, model) {
    set({ pendingSwitchModel: model ?? null });
    const id = get().selectedThreadId;
    const events = id ? get().events[id] : undefined;
    // A thread with its (empty) history loaded has nothing to carry over: switch it without the dialog.
    if (agent && events && !events.some((e) => e.event.kind === "user")) {
      void get().switchAgent(agent, "fresh").then((err) => {
        if (err !== null) get().showNotice(err);
      });
      return;
    }
    set({ pendingSwitch: agent });
  },
  async switchAgent(agent, mode) {
    const id = get().selectedThreadId;
    if (!id) return "No thread is open.";
    let res: SwitchResult;
    try {
      const model = get().pendingSwitchModel ?? undefined;
      set({ pendingSwitchModel: null });
      if (mode === "back") {
        // updateThread already resumes the kept session for that agent.
        await get().updateThread({ agent, ...(model && { model }) });
        return null;
      }
      // The model rides along, so a handoff seeds the session on it rather than on the agent's default.
      res = model ? await api().switchAgent(id, agent, mode, model) : await api().switchAgent(id, agent, mode);
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
  draft: {},
  setDraft(patch) {
    set((s) => {
      const draft = { ...s.draft, ...patch };
      // A new agent brings its own model and effort; drop the old picks (a model picked with it stays).
      if (patch.agent !== undefined && patch.agent !== s.draft.agent) {
        if (patch.model === undefined) delete draft.model;
        delete draft.effort;
        delete draft.contextWindow;
      }
      // A window picked for one model doesn't carry to another.
      if (patch.model !== undefined && patch.model !== s.draft.model && patch.contextWindow === undefined) delete draft.contextWindow;
      return { draft };
    });
  },
  selectedProjectId: null,
  selectedThreadId: null,
  threadKind: "chat",
  async setThreadKind(kind) {
    const s = get();
    if (s.threadKind === kind) return;
    set({ threadKind: kind });
    const current = s.selectedThreadId ? Object.values(s.threads).flat().find((t) => t.id === s.selectedThreadId) : undefined;
    if (current && threadKind(current) === kind) return;
    const latest = (s.threads[s.selectedProjectId ?? ""] ?? [])
      .filter((t) => !t.archived && threadKind(t) === kind)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    await get().selectThread(latest?.id ?? null);
  },
  events: {},
  live: {},
  running: {},
  async togglePin(threadId) {
    const thread = findThread(get().threads, threadId);
    if (!thread) return;
    try {
      get().apply({ type: "thread", thread: await api().updateThread(threadId, { pinned: !thread.pinned }) });
    } catch (err) {
      get().showNotice(`Couldn't pin the thread: ${ipcErrorText(err)}`);
    }
  },
  async renameThread(threadId, title) {
    const clean = title.trim();
    if (!clean) return;
    try {
      get().apply({ type: "thread", thread: await api().updateThread(threadId, { title: clean }) });
    } catch (err) {
      get().showNotice(`Couldn't rename the thread: ${ipcErrorText(err)}`);
    }
  },
  async setArchived(threadId, archived) {
    try {
      // Archiving a pin unpins it: an archived thread sits only in Archived.
      get().apply({ type: "thread", thread: await api().updateThread(threadId, archived ? { archived, pinned: false } : { archived }) });
    } catch (err) {
      get().showNotice(archived ? `Couldn't archive the thread: ${ipcErrorText(err)}` : `Couldn't restore the thread: ${ipcErrorText(err)}`);
      return;
    }
    if (archived && get().selectedThreadId === threadId) await get().selectThread(null);
  },
  async deleteThread(threadId) {
    const thread = findThread(get().threads, threadId);
    if (!thread) return;
    try {
      await api().deleteThread(threadId);
    } catch (err) {
      get().showNotice(`Couldn't delete the thread: ${ipcErrorText(err)}`);
      return;
    }
    set((s) => {
      const { [threadId]: _events, ...events } = s.events;
      return {
        threads: { ...s.threads, [thread.projectId]: (s.threads[thread.projectId] ?? []).filter((t) => t.id !== threadId) },
        events,
        finished: s.finished.filter((f) => f.threadId !== threadId),
        selectedThreadId: s.selectedThreadId === threadId ? null : s.selectedThreadId,
      };
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
  plans: [],
  questions: [],
  finished: [],
  turnStartedAt: {},
  inboxOpen: false,
  setInboxOpen(open) {
    set({ inboxOpen: open });
  },
  paneLayout: { ...DEFAULT_LAYOUT },
  inspectorOpen: false,
  inspectorTab: "changes",
  artifact: null,
  artifactFiles: {},
  turnScores: {},
  browserMounted: false,
  terminals: [],
  browserUrl: null,
  picking: false,
  takeOver: IDLE,
  browser: { device: "desktop", logs: [], screenshots: [] },
  browserLoaded: false,
  composerInsert: null,
  designReload: {},
  designSelection: {},
  setDesignSelection(threadId, selection) {
    set((s) => {
      const next = { ...s.designSelection };
      if (selection && selection.elements.length) next[threadId] = selection;
      else delete next[threadId];
      return { designSelection: next };
    });
  },
  composerDraft: null,
  setComposerDraft(text) {
    set((s) => ({ composerDraft: { text, nonce: (s.composerDraft?.nonce ?? 0) + 1 } }));
  },

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
  pendingSkills: [],
  diffVersion: 0,
  openPickerRequest: 0,
  requestModelPicker() {
    set((s) => ({ openPickerRequest: s.openPickerRequest + 1 }));
  },

  async init() {
    // React StrictMode runs effects twice in development; subscribe once.
    if (initialized) return;
    initialized = true;
    set({ initError: null });
    // Subscribe before the first await, so no update sent during startup is lost. A retry after a
    // failed init must not double-subscribe (each onUpdate would then apply every update twice).
    if (!subscribed) {
      subscribed = true;
      api().onUpdate((u) => get().apply(u));
    }
    try {
      const [projects, skills, agents, settings, appUpdate, limitList, pending] = await Promise.all([
        api().listProjects(),
        api().listSkills(),
        api().listAgents(),
        api().getSettings(),
        api().updateStatus(),
        api().listLimits(),
        api().pendingState(),
      ]);
      void api()
        .listEditors()
        .then((editors) => set({ editors }));
      applyTheme(settings.theme);
      applyMotion(settings.motion);
      applyDensity(settings.density);
      applyZoom(settings.zoom);
      const threads: Record<string, Thread[]> = {};
      for (const p of projects) threads[p.id] = await api().listThreads(p.id);
      for (const p of projects) void get().loadBranch(p.id);
      const limits = Object.fromEntries(limitList.map((l) => [l.agent, l]));
      set((s) => ({ projects, skills, agents, threads, settings, paneLayout: sanitizeLayout(settings.paneLayout), appUpdate, limits: { ...limits, ...s.limits } }));
      // A window that loads mid-turn picks up what's live: running threads and the cards waiting on the user.
      const now = Date.now();
      set((s) => ({
        running: { ...Object.fromEntries(pending.running.map((id) => [id, true])), ...s.running },
        turnStartedAt: { ...Object.fromEntries(pending.running.map((id) => [id, now])), ...s.turnStartedAt },
        permissions: [...s.permissions, ...pending.permissions.filter((p) => !s.permissions.some((x) => x.requestId === p.requestId))],
        plans: [...s.plans, ...pending.plans.filter((p) => !s.plans.some((x) => x.requestId === p.requestId))],
        questions: [...s.questions, ...pending.questions.filter((q) => !s.questions.some((x) => x.requestId === q.requestId))],
      }));
      const first = projects[0];
      if (first) {
        await get().selectProject(first.id);
        const recent = threads[first.id]?.[0];
        if (recent) await get().selectThread(recent.id);
      }
    } catch (err) {
      // A startup call that rejects used to leave a blank window; let the user retry.
      initialized = false;
      set({ initError: ipcErrorText(err) });
    }
  },

  async addProject() {
    let project: Project | null;
    try {
      project = await api().addProject();
    } catch (err) {
      // A failed dialog or database write used to vanish into `void`: say so.
      get().showNotice(`Couldn't add the project: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
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

  async relocateProject(id) {
    let project: Project | null;
    try {
      project = await api().relocateProject(id);
    } catch (err) {
      get().showNotice(`Couldn't locate the project: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (!project) return;
    const relocated = project;
    set((s) => ({ projects: s.projects.map((p) => (p.id === relocated.id ? relocated : p)) }));
  },

  async deleteProject(id) {
    const project = get().projects.find((p) => p.id === id);
    if (!project) return;
    try {
      await api().deleteProject(id);
    } catch (err) {
      get().showNotice(`Couldn't delete project: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const currentSelected = get().selectedProjectId === id;
    const remainingProjects = get().projects.filter((p) => p.id !== id);
    const nextProjectId = currentSelected ? (remainingProjects[0]?.id ?? null) : get().selectedProjectId;
    const threadIdsToRemove = new Set((get().threads[id] ?? []).map((t) => t.id));

    set((s) => {
      const { [id]: _removedThreads, ...threads } = s.threads;
      const { [id]: _removedBranch, ...projectBranches } = s.projectBranches;
      const events = Object.fromEntries(Object.entries(s.events).filter(([tid]) => !threadIdsToRemove.has(tid)));
      const finished = s.finished.filter((f) => !threadIdsToRemove.has(f.threadId));
      const selectedThreadId = threadIdsToRemove.has(s.selectedThreadId ?? "") ? null : s.selectedThreadId;

      return {
        projects: remainingProjects,
        threads,
        projectBranches,
        events,
        finished,
        selectedProjectId: nextProjectId,
        selectedThreadId,
      };
    });

    if (currentSelected && nextProjectId) {
      await get().selectProject(nextProjectId);
      const recent = get().threads[nextProjectId]?.[0];
      if (recent) await get().selectThread(recent.id);
    } else if (!nextProjectId) {
      set({ selectedThreadId: null, skills: [] });
    }
  },

  async setCheckCommand(id, command, fixRounds) {
    const project = await api().setCheckCommand(id, command, fixRounds);
    set((s) => ({ projects: s.projects.map((p) => (p.id === project.id ? project : p)) }));
  },

  async selectProject(id) {
    set({ selectedProjectId: id });
    void get().loadBranch(id);
    if (!get().threads[id]) {
      const list = await api().listThreads(id);
      set((s) => ({ threads: { ...s.threads, [id]: list } }));
    }
    void api().listSkills(id).then((skills) => set({ skills }));
  },

  async selectThread(id) {
    const picked = id ? Object.values(get().threads).flat().find((t) => t.id === id) : undefined;
    set((s) => ({
      selectedThreadId: id,
      // Jumping to a thread (⌘K, the Message Center) lands in its mode.
      ...(picked ? { threadKind: threadKind(picked) } : {}),
      finished: threadSeen(s.finished, id),
      // The File tab belongs to one thread: leaving it closes the file.
      ...(s.artifact && s.artifact.threadId !== id
        ? { artifact: null, ...(s.inspectorTab === "artifact" ? { inspectorTab: "changes" as const, inspectorOpen: false } : {}) }
        : {}),
    }));
    // The thread's recorded files, so each turn's file cards include what it wrote by command.
    if (id && !get().artifactFiles[id]) {
      void Promise.resolve()
        .then(() => api().listArtifacts(id))
        .then((files) => set((x) => ({ artifactFiles: { ...x.artifactFiles, [id]: files } })))
        .catch(() => {});
    }
    if (id && !get().turnScores[id]) {
      void Promise.resolve()
        .then(() => api().learnScores(id))
        .then((list) => set((x) => ({ turnScores: { ...x.turnScores, [id]: Object.fromEntries(list.map((sc) => [sc.userSeq, sc])) } })))
        .catch(() => {});
    }
    if (id && !get().events[id]) {
      const events = await api().listEvents(id);
      set((s) => ({ events: { ...s.events, [id]: events } }));
    }
  },

  async newThread(skills, opts) {
    const projectId = get().selectedProjectId;
    if (!projectId) return null;
    let thread: Thread;
    const draft = get().draft;
    try {
      thread = await api().createThread(projectId, draft.agent ?? get().lastAgent ?? undefined, createOpts(get().threadKind, draft, opts));
      const patch = draftPatch(draft, thread);
      if (Object.keys(patch).length) thread = await api().updateThread(thread.id, patch);
    } catch (err) {
      get().showNotice(ipcErrorText(err));
      return null;
    }
    set((s) => ({
      pendingSkills: skills ?? [],
      threads: { ...s.threads, [projectId]: upsertThread(s.threads[projectId], thread) },
      events: { ...s.events, [thread.id]: [] },
      selectedThreadId: thread.id,
      draft: {},
      lastAgent: thread.agent,
    }));
    return thread.id;
  },

  async buildDesignInCode(designThreadId) {
    const design = findThread(get().threads, designThreadId);
    if (!design || design.kind !== "design") return;
    let thread: Thread;
    try {
      thread = await api().createThread(design.projectId, design.agent, { kind: "chat" });
      const patch = buildThreadPatch(design, thread);
      if (Object.keys(patch).length) thread = await api().updateThread(thread.id, patch);
    } catch (err) {
      get().showNotice(ipcErrorText(err));
      return;
    }
    set((s) => ({
      threads: { ...s.threads, [design.projectId]: upsertThread(s.threads[design.projectId], thread) },
      events: { ...s.events, [thread.id]: [] },
    }));
    const dir = designDirName(designThreadId);
    const ok = await get().send(buildInCodePrompt(dir), undefined, thread.id, [handoffPath(dir)]);
    if (ok) get().showNotice("Building it in a new chat thread. The Message Center says when it's done.");
  },

  async sendInBackground(text, skills, opts, mentions) {
    const projectId = get().selectedProjectId;
    if (!projectId) return;
    let thread: Thread;
    const draft = get().draft;
    try {
      thread = await api().createThread(projectId, draft.agent ?? get().lastAgent ?? undefined, createOpts(get().threadKind, draft, opts));
      const patch = draftPatch(draft, thread);
      if (Object.keys(patch).length) thread = await api().updateThread(thread.id, patch);
    } catch (err) {
      get().showNotice(ipcErrorText(err));
      return;
    }
    set((s) => ({
      threads: { ...s.threads, [projectId]: upsertThread(s.threads[projectId], thread) },
      events: { ...s.events, [thread.id]: [] },
      draft: {},
      lastAgent: thread.agent,
    }));
    await get().send(text, skills, thread.id, mentions);
    get().showNotice("Started in the background. The Message Center says when it's done.");
  },

  async startThread(text, skills, mentions) {
    // Send only to the thread newThread made: the selection can change while it awaits.
    const id = await get().newThread();
    if (id) await get().send(text, skills, id, mentions);
  },

  addPendingSkills(names) {
    set((s) => ({ pendingSkills: [...new Set([...s.pendingSkills, ...names])] }));
  },

  takePendingSkills() {
    const skills = get().pendingSkills;
    if (skills.length) set({ pendingSkills: [] });
    return skills;
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

  async setDesignSystem(threadId, id) {
    try {
      get().apply({ type: "thread", thread: await api().setDesignSystem(threadId, id) });
    } catch (err) {
      get().showNotice(ipcErrorText(err));
    }
  },

  async setPrototypeTier(threadId, tier) {
    try {
      get().apply({ type: "thread", thread: await api().setPrototypeTier(threadId, tier) });
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

  cycleEffort(dir) {
    const s = get();
    const id = s.selectedThreadId;
    if (!id) return;
    const thread = findThread(s.threads, id);
    if (!thread) return;
    const efforts = s.agents.find((a) => a.id === thread.agent)?.models.find((m) => m.id === thread.model)?.efforts ?? [];
    if (!efforts.length) return;
    // Default is its own stop, first in the ring.
    const levels: (string | null)[] = [null, ...efforts];
    const at = Math.max(0, levels.indexOf(thread.effort));
    void get().updateThread({ effort: levels[(at + dir + levels.length) % levels.length]! });
  },

  outbox: {},
  enqueue(threadId, text, skills, mentions) {
    set((s) => ({
      outbox: {
        ...s.outbox,
        [threadId]: [...(s.outbox[threadId] ?? []), { text, ...(skills?.length ? { skills } : {}), ...(mentions?.length ? { mentions } : {}) }],
      },
    }));
  },
  dequeue(threadId, index) {
    set((s) => {
      const list = s.outbox[threadId];
      if (!list || index < 0 || index >= list.length) return {};
      const next = list.filter((_, i) => i !== index);
      if (!next.length) {
        const { [threadId]: _dropped, ...outbox } = s.outbox;
        return { outbox };
      }
      return { outbox: { ...s.outbox, [threadId]: next } };
    });
  },

  async send(text, skills, threadId, mentions) {
    const id = threadId ?? get().selectedThreadId;
    if (!id || get().running[id]) return false;
    set((s) => ({ running: { ...s.running, [id]: true } }));
    try {
      await api().send({ threadId: id, text, ...(skills?.length ? { skills } : {}), ...(mentions?.length ? { mentions } : {}) });
      return true;
    } catch (err) {
      set((s) => ({ running: { ...s.running, [id]: false } }));
      get().showNotice(`Couldn't send: ${ipcErrorText(err)}`);
      return false;
    }
  },

  async compact(threadId, focus) {
    if (get().running[threadId]) return;
    set((s) => ({ running: { ...s.running, [threadId]: true } }));
    try {
      await api().send({ threadId, text: `/compact${focus ? ` ${focus}` : ""}`, compact: { focus } });
    } catch (err) {
      set((s) => ({ running: { ...s.running, [threadId]: false } }));
      get().showNotice(`Couldn't compact: ${ipcErrorText(err)}`);
    }
  },

  async interrupt() {
    const id = get().selectedThreadId;
    if (!id) return;
    // Stop means stop: queued messages go too, before the turn's end could deliver one.
    set((s) => {
      const { [id]: _dropped, ...outbox } = s.outbox;
      return { outbox };
    });
    await api().interrupt(id);
  },

  async respond(requestId, decision) {
    const removed = get().permissions.find((p) => p.requestId === requestId);
    set((s) => ({ permissions: s.permissions.filter((p) => p.requestId !== requestId) }));
    try {
      await api().respondPermission(requestId, decision);
    } catch (err) {
      if (removed) set((s) => (s.permissions.some((p) => p.requestId === requestId) ? {} : { permissions: [...s.permissions, removed] }));
      get().showNotice(`Couldn't send your answer: ${ipcErrorText(err)}`);
    }
  },

  async respondPlan(requestId, decision) {
    const removed = get().plans.find((p) => p.requestId === requestId);
    set((s) => ({ plans: s.plans.filter((p) => p.requestId !== requestId) }));
    try {
      await api().respondPlan(requestId, decision);
    } catch (err) {
      if (removed) set((s) => (s.plans.some((p) => p.requestId === requestId) ? {} : { plans: [...s.plans, removed] }));
      get().showNotice(`Couldn't send your answer: ${ipcErrorText(err)}`);
    }
  },
  async respondQuestion(requestId, answer) {
    const removed = get().questions.find((q) => q.requestId === requestId);
    set((s) => ({ questions: s.questions.filter((q) => q.requestId !== requestId) }));
    try {
      await api().respondQuestion(requestId, answer);
    } catch (err) {
      if (removed) set((s) => (s.questions.some((q) => q.requestId === requestId) ? {} : { questions: [...s.questions, removed] }));
      get().showNotice(`Couldn't send your answer: ${ipcErrorText(err)}`);
    }
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

  openArtifact(path, threadId) {
    const s = get();
    const id = threadId ?? s.selectedThreadId;
    if (!id) return;
    const rel = relativeToThread(s, id, path);
    const opens = !s.inspectorOpen;
    set({ artifact: { threadId: id, path: rel }, inspectorOpen: true, inspectorTab: "artifact" });
    if (opens && s.paneLayout.inspectorCollapsed) s.setPaneLayout({ inspectorCollapsed: false }, true);
    void api()
      .listArtifacts(id)
      .then((files) => set((x) => ({ artifactFiles: { ...x.artifactFiles, [id]: files } })))
      .catch(() => {});
  },

  closeArtifact() {
    set((s) => ({ artifact: null, ...(s.inspectorTab === "artifact" ? { inspectorTab: "changes" as const, inspectorOpen: false } : {}) }));
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
      case "artifact-ready":
        // Opens on its own only for the thread on screen, once its turn has ended. A design thread's own
        // pages already show on its canvas, so they only refresh the file list (and the canvas's versions).
        if (update.threadId === get().selectedThreadId && !isDesignFile(get(), update.threadId, update.path)) get().openArtifact(update.path, update.threadId);
        else
          void api()
            .listArtifacts(update.threadId)
            .then((files) => set((x) => ({ artifactFiles: { ...x.artifactFiles, [update.threadId]: files } })))
            .catch(() => {});
        return;
      case "turn-score": {
        const sc = update.score;
        set((s) => ({ turnScores: { ...s.turnScores, [sc.threadId]: { ...s.turnScores[sc.threadId], [sc.userSeq]: sc } } }));
        return;
      }
      case "design-changed":
        set((s) => ({ designReload: { ...s.designReload, [update.threadId]: (s.designReload[update.threadId] ?? 0) + 1 } }));
        return;
      case "event":
        // A plan proposal is also a new version of the thread's plan artifact: refresh its file list.
        if (update.stored.event.kind === "plan-proposal") {
          const id = update.threadId;
          void api()
            .listArtifacts(id)
            .then((files) => set((x) => ({ artifactFiles: { ...x.artifactFiles, [id]: files } })))
            .catch(() => {});
        }
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
          turnStartedAt: update.running ? { ...s.turnStartedAt, [update.threadId]: Date.now() } : s.turnStartedAt,
          // Only a turn this window saw start ends in a Finished row.
          finished: update.running || !s.running[update.threadId] ? s.finished : turnEnded(s.finished, update.threadId, s.turnStartedAt[update.threadId], Date.now(), s.selectedThreadId),
          live: update.running ? s.live : { ...s.live, [update.threadId]: emptyLive() },
          permissions: update.running ? s.permissions : s.permissions.filter((p) => p.threadId !== update.threadId),
          plans: update.running ? s.plans : s.plans.filter((p) => p.threadId !== update.threadId),
          // An async question outlives its turn: the answer goes back as the next message.
          questions: update.running ? s.questions : s.questions.filter((q) => q.threadId !== update.threadId || q.async),
          diffVersion: update.running ? s.diffVersion : s.diffVersion + 1,
        }));
        // The next queued message goes out as the next turn, exactly once.
        if (!update.running) {
          const next = get().outbox[update.threadId]?.[0];
          if (next) {
            set((s) => ({ outbox: { ...s.outbox, [update.threadId]: s.outbox[update.threadId]!.slice(1) } }));
            void get().send(next.text, next.skills, update.threadId, next.mentions);
          }
        }
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
      case "plan-approval":
        set((s) =>
          s.plans.some((p) => p.requestId === update.request.requestId) ? {} : { plans: [...s.plans, update.request] },
        );
        return;
      case "plan-approval-done":
        set((s) => ({ plans: s.plans.filter((p) => p.requestId !== update.requestId) }));
        return;
      case "question":
        set((s) => (s.questions.some((q) => q.requestId === update.request.requestId) ? {} : { questions: [...s.questions, update.request] }));
        return;
      case "question-done":
        set((s) => ({ questions: s.questions.filter((q) => q.requestId !== update.requestId) }));
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
        applyMotion(update.settings.motion);
        applyDensity(update.settings.density);
        applyZoom(update.settings.zoom);
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
      case "projects-changed":
        void api().listProjects().then((projects) => set({ projects }));
        return;
      case "open-about":
        set({ aboutOpen: true });
        break;
      case "thread":
        set((s) => ({
          threads: { ...s.threads, [update.thread.projectId]: upsertThread(s.threads[update.thread.projectId], update.thread) },
        }));
        return;
    }
  },
}));

/** Whether `path` (relative to the thread's folder) is inside a design thread's own folder. */
function isDesignFile(s: Pick<State, "threads">, threadId: string, path: string): boolean {
  const thread = Object.values(s.threads).flat().find((t) => t.id === threadId);
  return thread?.kind === "design" && path.startsWith(`${designDirName(threadId)}/`);
}

export function useSelectedThread(): Thread | null {
  return useStore((s) => {
    if (!s.selectedProjectId || !s.selectedThreadId) return null;
    return s.threads[s.selectedProjectId]?.find((t) => t.id === s.selectedThreadId) ?? null;
  });
}

/** A path relative to the thread's folder (its worktree, else its project), with forward slashes; unchanged when outside. */
export function relativeToThread(s: Pick<State, "threads" | "projects">, threadId: string, path: string): string {
  const thread = Object.values(s.threads).flat().find((t) => t.id === threadId);
  const root = thread?.worktreePath ?? s.projects.find((p) => p.id === thread?.projectId)?.path;
  const norm = (p: string) => p.replace(/\\/g, "/");
  const p = norm(path);
  if (!root) return p;
  const r = norm(root).replace(/\/+$/, "");
  const win = /^[a-z]:\//i.test(r);
  const under = win ? p.toLowerCase().startsWith(`${r.toLowerCase()}/`) : p.startsWith(`${r}/`);
  return under ? p.slice(r.length + 1) : p.replace(/^\.\//, "");
}
