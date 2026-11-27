import type { ExpertDef } from "../../shared/experts";
import { newestNoticeFirst, type AutomationNotice } from "../../shared/automations";
import { create } from "zustand";
import type { AppInfo, Attachment, AttachmentSource } from "../../shared/types";
import type {
  BackgroundShell,
  ArtifactFile,
  BrowserState,
  DevicePreset,
  EditorInfo,
  IssueSummary,
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
  Question,
  QuestionAnswer,
  QuestionRequest,
  Project,
  SkillEntry,
  StoredEvent,
  SwitchMode,
  SwitchResult,
  Thread,
  ThreadKind,
  ThreadTotals,
  WorkspaceMode,
} from "../../shared/types";
import type { DocumentStatus } from "../../shared/design-mutation";
import { api } from "./api";
import { forgetComposerDrafts } from "./composer-drafts";
import { pluginSkillSelections, type PluginSelections } from "./commands";
import type { PluginCommandView } from "../../shared/plugin-parts";
import type { AppThemeState } from "../../shared/app-themes";
import { applyChromePalette } from "./app-themes";
import { appendDelta, applyLiveEvent, emptyLive, flushPending, type LiveThread } from "./live";
import { DEFAULT_LAYOUT, sanitizeLayout } from "./layout";
import { readAppRecents, writeAppRecents } from "./plugins";
import { IDLE, takeOverReducer, type TakeOverState } from "./takeover";
import { threadSeen, turnEnded, type FinishedTurn } from "./inbox";
import { waitingThreads, workspaceModeOf } from "./sections";
import { readSession, restoreDraft, restoreTarget, writeSession } from "./session";
import { setupMessage, setupQuestions } from "./issueSetup";
import { buildInCodePrompt, buildThreadPatch, designDirName } from "../../shared/design";
import type { SelectedElement } from "../../shared/selection";
import type { PrototypeTier } from "../../shared/tiers";
import type { TurnScore } from "../../shared/learn";
import type { DesignChip, SystemWhere } from "./design/intent";

let pluginCommandRequest = 0;

/** A design thread's canvas selection: the page it is on and its elements. */
/** What the next message is about, chosen from the Composer rather than typed. */
export type { DesignChip };

export interface DesignSelection {
  page: string;
  elements: SelectedElement[];
  /** The kit's names for the elements (`StatCard`), in order, when the canvas knows them: the Composer chip's label. */
  names?: string[];
}

/** The right panel's tabs. Changes and Files need a project; Browser works without one; File shows an artifact. Creator apps never open here. */
export type InspectorTab = "changes" | "browser" | "files" | "artifact";

export type LibraryTab = "experts" | "skills" | "connectors" | "apps" | "mcp" | "agents" | "memory" | "automations" | "learned";

/** A new thread's pickers before it exists; reset once the thread is created. */
interface Draft {
  agent?: string;
  model?: string;
  effort?: string | null;
  contextWindow?: number | null;
  permissionMode?: PermissionMode;
  /** A design thread's design system (absent = the project's default). */
  designSystem?: string;
  /** The issue picked before the thread exists; it applies only in the project it was picked in. */
  issue?: { projectId: string; issue: IssueSummary };
}

type SendOptions = { background?: boolean; files?: AttachmentSource[]; attachments?: Attachment[]; initialPatch?: ReturnType<typeof draftPatch> } & PluginSelections;
type OutboxMessage = { text: string; skills?: string[]; mentions?: string[]; retry?: true } & SendOptions;

interface State {
  inboxTarget: { threadId: string; requestId: string; kind: "permission" | "question" | "plan" } | null;
  projects: Project[];
  threads: Record<string, Thread[]>; // by project id
  skills: SkillEntry[];
  agents: AgentInfo[];
  settings: SettingsView | null;
  appThemes: AppThemeState | null;
  loadAppThemes(): Promise<void>;
  settingsOpen: boolean;
  setSettingsOpen(open: boolean): void;
  /** The About sheet is open (macOS app menu, or Settings → Updates). */
  aboutOpen: boolean;
  setAboutOpen(open: boolean): void;
  /** The "Download design references" sheet. */
  referencesSheetOpen: boolean;
  setReferencesSheetOpen(open: boolean): void;
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
  /** The /doctor sheet: agent installs, versions, conflicts and their fixes. */
  doctorOpen: boolean;
  openDoctor(): void;
  closeDoctor(): void;
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
  /** /codemode: set code mode, or flip it when no mode is given; says what new threads will get. */
  setCodeMode(mode?: "on" | "off"): Promise<void>;
  /** Open a file (relative to the project, at a line) or the project itself in an editor. */
  openInEditor(target: { path?: string; line?: number; column?: number }, editor?: string): Promise<void>;
  /** The Library sheet's tab, or null when it's closed. */
  libraryTab: LibraryTab | null;
  automationsRevision: Record<string, number>;
  /** A skill for the Library to show first. */
  librarySkill: string | null;
  /** The agent new threads start with: the last one picked. */
  lastAgent: string | null;
  /** The pickers for a thread that hasn't been created yet. */
  draft: Draft;
  setDraft(patch: Partial<Draft>): void;
  selectedProjectId: string | null;
  selectedThreadId: string | null;
  /** Thread ids by how recently they were selected (oldest first), so the per-thread caches can be bounded. */
  selectedOrder: string[];
  /** Chat, Design or Creator mode: which threads the sidebar lists and what New thread makes. Follows the selected thread. */
  threadKind: WorkspaceMode;
  /** Switch workspace mode; a selected thread of another mode gives way to the project's latest of this mode, if any. */
  setThreadKind(kind: WorkspaceMode): Promise<void>;
  /** The composer's Creator toggle: a new thread follows it; an open thread of the other kind gives way to a fresh draft (a session's tools are fixed). */
  toggleCreator(): Promise<void>;
  events: Record<string, StoredEvent[]>; // by thread id
  /** Each thread's loaded history window: where it starts, whether older events exist, and its whole-thread totals. */
  history: Record<string, { firstSeq: number; hasMore: boolean; loadingOlder: boolean; totals: ThreadTotals | null }>;
  live: Record<string, LiveThread>; // streaming state not yet stored
  running: Record<string, boolean>;
  /** Background threads waiting for a free slot under Settings › Run at once. */
  queued: Record<string, boolean>;
  /** Background shells agents started, by shell id (Track G). */
  shells: Record<string, BackgroundShell>;
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
  /** The latest run notice per automation, for the Message Center (newest first, capped). */
  automationNotices: AutomationNotice[];
  /** When each running turn started (renderer clock), for a Finished row's duration. */
  turnStartedAt: Record<string, number>;
  inboxOpen: boolean;
  setInboxOpen(open: boolean): void;
  /** Panel widths and collapse state; the raw setting, drawn through clampLayout. */
  paneLayout: PaneLayout;
  /** The sidebar in the design studio: folded unless opened there, without touching the saved layout. Null outside it. */
  studioFold: boolean | null;
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
  /** Each open design thread's latest change: a counter and the raw changed paths (null = unknown), so the board regenerates only the artboards it affects. */
  designChange: Record<string, { n: number; paths: string[] | null }>;
  /** Open design pages' save and undo state, by document id, with a counter that moves when conflicts wait to be fetched. */
  designDocuments: Record<string, { status: DocumentStatus; conflicts: number }>;
  /** Each design thread's selected elements on its canvas (one page): chips in the composer, scope for the next message. */
  designSelection: Record<string, DesignSelection>;
  /** Set (or clear, with null or no elements) a design thread's selection. */
  setDesignSelection(threadId: string, selection: DesignSelection | null): void;
  /** A one-shot ask from across the app to a thread's studio: show a view, or open the style picker. */
  studioRequest: { threadId: string; view?: "design" | "system"; picker?: boolean; version?: number } | null;
  requestStudio(request: { threadId: string; view?: "design" | "system"; picker?: boolean; version?: number } | null): void;
  /** The system change a thread can still step back from: its toast, and what `Undo` and ⌘Z do. `page` means the page's own undo carries it. */
  systemStep: Record<string, { text: string; undo: (() => Promise<unknown>) | "page" }>;
  setSystemStep(threadId: string, step: { text: string; undo: (() => Promise<unknown>) | "page" } | null): void;
  /** The chip a design thread's next message goes out with (`+` menu, System mode). */
  designChip: Record<string, DesignChip>;
  setDesignChip(threadId: string, chip: DesignChip | null): void;
  /** Where System mode is while it's open (its Composer chips: `Library · Colors · Default · Light`). Absent on the page. */
  designSystemWhere: Record<string, SystemWhere>;
  setDesignSystemWhere(threadId: string, where: SystemWhere | null): void;
  /** Reference images handed to a design thread's composer from elsewhere (the canvas's Draw tool); the composer takes them. */
  pendingRefs: Record<string, { path: string; thumb: string }[]>;
  addDesignRefs(threadId: string, refs: { path: string; thumb: string }[]): void;
  /** Take (and clear) a thread's pending reference images. */
  takeDesignRefs(threadId: string): { path: string; thumb: string }[];
  /** Text to put back in the message box (Edit on a sent message); consumed by the composer. */
  composerDraft: { text: string; nonce: number } & PluginSelections | null;
  setComposerDraft(text: string, selections?: PluginSelections): void;
  startPick(): Promise<void>;
  /** A skill to pre-fill in the composer, set by the empty-state shortcuts. */
  /** Skills picked from ⌘K or the Library, waiting for the composer to add them as chips. */
  pendingSkills: string[];
  /** Bumped by the composer's "/model" command so the model picker opens. */
  openPickerRequest: number;
  requestModelPicker(): void;
  /** Bumped by the composer's "/issue" command so the + menu opens on its Issues flyout. */
  issuePickerRequest: number;
  requestIssuePicker(): void;
  /** Set (null clears) the issue the open thread works on, or the draft's when there's no thread yet. */
  setIssue(issue: IssueSummary | null): Promise<void>;
  /**
   * Run an issue command's bundled skill (issue, issue-setup, triage, pr) in the open thread, or a new one.
   * /issue-setup hands it the origin remote; a bare /pr, the thread's issue.
   */
  runIssueCommand(skill: string, args: string): Promise<void>;
  diffVersion: number; // bumps when a turn ends, so the diff refreshes
  /** Bumped by "learn-changed", so an open Learned tab refetches its lessons. */
  learnVersion: number;

  init(): Promise<void>;
  addProject(): Promise<void>;
  /** Open the built-in Chats project (made on first use) and start a chat there: no project folder needed. */
  newChat(): Promise<string | null>;
  /** Point a project at a newly picked folder and apply the returned row. */
  relocateProject(id: string): Promise<void>;
  deleteProject(id: string): Promise<void>;
  /** Set a project's post-turn check command and apply the returned row. */
  setCheckCommand(id: string, command: string | null, fixRounds?: number | null): Promise<void>;
  selectProject(id: string): Promise<void>;
  selectThread(id: string | null): Promise<void>;
  /** Load the next older page of a thread's history; a no-op when there is none or one is loading. */
  loadOlder(threadId: string): Promise<void>;
  /** Open a new thread, returning its id (or null when nothing was created: no project, or the create failed). `worktree` gives it its own git worktree on a new branch; `designSystem` picks a design thread's system. */
  newThread(skills?: string[], opts?: { worktree?: boolean; designSystem?: string; expertId?: string }): Promise<string | null>;
  /** The expert catalogue (null until loaded). */
  experts: ExpertDef[] | null;
  loadExperts(): Promise<void>;
  /** Start a new thread with an expert: its skills as chips, a design expert in a design thread, `prompt` pre-filled (not sent). */
  summonExpert(id: string, prompt?: string): Promise<string | null>;
  /** Set an expert on a thread that has no messages yet: its skills join the composer, and a design thread takes its design system. */
  setThreadExpert(threadId: string, id: string): Promise<void>;
  /** Pick a design thread's design system; the next turn copies it into the design folder. */
  setDesignSystem(threadId: string, id: string): Promise<void>;
  /** Change a design thread's prototype tier. */
  setPrototypeTier(threadId: string, tier: PrototypeTier): Promise<void>;
  /** Start `text` as a new thread in the open project without leaving the current one; it reports through the Message Center. */
  sendInBackground(text: string, skills?: string[], opts?: { worktree?: boolean } & PluginSelections, mentions?: string[], files?: AttachmentSource[]): Promise<boolean>;
  /** Start a chat thread (same project and agent, in the background) that builds a design thread's design into the codebase. */
  buildDesignInCode(designThreadId: string, snapshot: string, page: string): Promise<void>;
  /** From the project's start screen: open a new thread and send `text` in it. */
  startThread(text: string, skills?: string[], mentions?: string[], files?: AttachmentSource[], selections?: PluginSelections): Promise<boolean>;
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
  /**
   * Start a turn on the open thread (or `threadId`); resolves false when it couldn't start (no thread, already running, or the send failed).
   * `files` are copied into the thread first; `attachments` are ones it already holds (Retry).
   */
  send(text: string, skills?: string[], threadId?: string, mentions?: string[], opts?: SendOptions & { keepOnRefusal?: boolean }): Promise<boolean>;
  admitting: Record<string, AbortController>;
  /** Compact a thread's session now (/compact), with an optional focus for the summary. */
  compact(threadId: string, focus: string | null): Promise<void>;
  /** Messages sent while a turn ran, by thread: each goes out as the next turn, in order. Stop clears them; never persisted. */
  outbox: Record<string, OutboxMessage[]>;
  deliverOutbox(threadId: string, message: OutboxMessage): Promise<void>;
  enqueue(threadId: string, text: string, skills?: string[], mentions?: string[], files?: AttachmentSource[], selections?: PluginSelections): void;
  /** Remove the queued message at `index`; drops the thread's key once its queue is empty. */
  dequeue(threadId: string, index: number): void;
  interrupt(): Promise<void>;
  /** Stop one thread's turn, dropping the messages queued behind it. */
  interruptThread(threadId: string): Promise<void>;
  /** Stop every running thread, and any paused on a permission, plan or question. */
  stopAllRunning(): Promise<void>;
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
  /** Installed Creator apps for the selected project (and global ones), as last listed. */
  apps: AppInfo[];
  pluginCommands: PluginCommandView[];
  pluginCommandsError: string | null;
  pluginCommandsLoading: boolean;
  loadPluginCommands(): Promise<void>;
  loadApps(): Promise<void>;
  /** The Creator app open in the plugin modal. */
  appOpen: AppInfo | null;
  /** Per frame key, how many times main said a previewed draft's files changed (an open frame reloads on each). */
  appReloads: Record<string, number>;
  /** The installed plugin shown as a page over the main area (closed when the thread or project changes). */
  appPage: AppInfo | null;
  /** Installed widgets, docks and panels the user closed (by key); they show again when opened from the sidebar. Kept in localStorage. */
  surfaceHidden: string[];
  /** Widget, dock and panel draft previews from Creator threads, shown until closed. */
  surfaceDrafts: AppInfo[];
  /** Asks a widget, dock or panel to expand and come forward (bumped on every open). */
  surfaceFocus: { key: string; n: number } | null;
  /** When each installed app was last opened (orders the sidebar's Apps after favourites). Kept in localStorage. */
  appRecents: Record<string, number>;
  /** Open an app where its manifest says: the modal, a page, or its widget, dock or panel. */
  openApp(app: AppInfo): void;
  /** Close a widget, dock or panel: a draft preview goes away, an installed one hides until opened again. */
  closeSurface(key: string): void;
  closePage(): void;
  /** A plugin's bridge: a toast headed with its title, another plugin opened by name, a new chat with its text. */
  pluginNotify(app: AppInfo, text: string): void;
  pluginOpen(from: AppInfo, name: string): void;
  pluginAsk(app: AppInfo, prompt: string): Promise<void>;
  editApp(app: AppInfo): Promise<string | null>;
  closeApp(): void;
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

/** Resolvers for question cards the app raised itself, by request id. */
const appAnswers = new Map<string, (answer: QuestionAnswer) => void>();
let appAsked = 0;

/** Put an app-owned question card in the thread's request dock and wait for the answer ("dismiss" when skipped). */
function askInApp(threadId: string, questions: Question[]): Promise<QuestionAnswer> {
  const requestId = `app:${++appAsked}`;
  return new Promise((resolve) => {
    appAnswers.set(requestId, resolve);
    useStore.setState((s) => ({ questions: [...s.questions, { requestId, threadId, questions }] }));
  });
}

export function findThread(threads: Record<string, Thread[]>, id: string): Thread | undefined {
  return Object.values(threads)
    .flat()
    .find((t) => t.id === id);
}

/** How many events one history page asks for; the main side extends it back to a turn boundary. */
export const HISTORY_PAGE = 1500;

/** How many threads keep their loaded caches; older ones are evicted on selection. */
export const CACHE_THREADS = 8;

/**
 * The thread ids to drop so at most `max` remain: the oldest of `order`
 * (most-recently-selected last) beyond the newest `max`, never an id in `keep`.
 */
export function evictable(order: string[], keep: Set<string>, max: number): string[] {
  return order.slice(0, Math.max(0, order.length - max)).filter((id) => !keep.has(id));
}

/** Union of two seq-sorted event lists, deduped by seq (a later list's copy wins) and sorted ascending. */
export function mergeBySeq(a: StoredEvent[], b: StoredEvent[]): StoredEvent[] {
  const bySeq = new Map<number, StoredEvent>();
  for (const e of a) bySeq.set(e.seq, e);
  for (const e of b) bySeq.set(e.seq, e);
  return [...bySeq.values()].sort((x, y) => x.seq - y.seq);
}

/** The thread's total event count: the server total plus events past it, never below what's loaded. */
export function eventCount(events: StoredEvent[] | undefined, totals: ThreadTotals | null | undefined): number {
  const loaded = events?.length ?? 0;
  if (!totals) return loaded;
  const live = (events ?? []).reduce((n, e) => n + (e.seq > totals.lastSeq ? 1 : 0), 0);
  return Math.max(loaded, totals.events + live);
}

/** createThread's options: the mode being shown, and a design thread's system (an explicit one beats the draft's). */
function createOpts(
  mode: WorkspaceMode,
  draft: Draft,
  opts?: { worktree?: boolean; designSystem?: string; expertId?: string },
): { worktree?: boolean; kind: ThreadKind; designSystem?: string; expertId?: string; preset?: "creator" } {
  const kind: ThreadKind = mode === "design" ? "design" : "chat";
  const designSystem = kind === "design" ? (opts?.designSystem ?? draft.designSystem) : undefined;
  return {
    ...(opts?.worktree !== undefined ? { worktree: opts.worktree } : {}),
    kind,
    ...(mode === "creator" ? { preset: "creator" as const } : {}),
    ...(designSystem ? { designSystem } : {}),
    ...(opts?.expertId ? { expertId: opts.expertId } : {}),
  };
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

/** Once creation succeeds the message belongs to that thread, including any setup still to retry. */
async function startComposerThread(background: boolean, text: string, skills?: string[], mentions?: string[], files?: AttachmentSource[], opts?: PluginSelections & { worktree?: boolean }) {
  const origin = useStore.getState();
  const { selectedProjectId: projectId, draft } = origin;
  if (!projectId) return false;
  const worktree = background ? opts?.worktree ?? origin.settings?.background?.worktree : undefined;
  let thread: Thread;
  let selections: PluginSelections;
  try {
    selections = {
      pluginCommand: opts?.pluginCommand,
      pluginSkills: opts?.pluginSkills ?? pluginSkillSelections(origin.skills.filter((s) => skills?.includes(s.name))).pluginSkills ?? [],
    };
    thread = await api().createThread(projectId, draft.agent ?? origin.lastAgent ?? undefined, createOpts(origin.threadKind, draft, { worktree }));
  } catch (err) {
    origin.showNotice(ipcErrorText(err));
    return false;
  }
  if (draft.issue?.projectId === projectId) {
    thread = await api().setThreadIssue(thread.id, draft.issue.issue).catch(() => thread);
  }
  useStore.setState((s) => {
    const stillHere = s.selectedProjectId === projectId && s.selectedThreadId === origin.selectedThreadId && s.threadKind === origin.threadKind;
    return {
      threads: { ...s.threads, [projectId]: upsertThread(s.threads[projectId], thread) },
      events: { ...s.events, [thread.id]: [] },
      history: { ...s.history, [thread.id]: { firstSeq: 0, hasMore: false, loadingOlder: false, totals: null } },
      ...(stillHere && !background ? { selectedThreadId: thread.id } : {}),
      ...(stillHere && s.draft === draft ? { draft: {}, lastAgent: thread.agent } : {}),
    };
  });
  const ok = await origin.send(text, skills, thread.id, mentions, { ...selections, background, files, initialPatch: draftPatch(draft, thread), keepOnRefusal: true });
  if (background && !ok) origin.showNotice(`${useStore.getState().notice ?? "Couldn't send."} Retry in the new thread.`);
  return true;
}

function ipcErrorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

let initialized = false;
let pendingUpdates: LiveUpdate[] | null = null;
let pendingSequence = -1;
let browserLoad: Promise<void> | null = null;
let browserGeneration = 0;
let projectSelection = 0;
// A very short turn can end before its IPC admission reply arrives.
const endedBeforeReply = new WeakSet<AbortController>();
function drainOutbox(threadId: string) {
  const s = useStore.getState();
  const next = s.outbox[threadId]?.find((m) => !m.retry);
  if (next) void s.deliverOutbox(threadId, next);
}
/** Launch has restored the last session; until then the empty start state must not overwrite it. */
let restored = false;
let subscribed = false;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;

// Live deltas are batched: tokens accumulate in the queue and land in the
// store at most once per frame, instead of one write per token.
const queued: { threadId: string; delta: LiveDelta }[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

// Tool calls that only look leave the working tree alone; any other finished call may have
// changed files, so the Changes panel refreshes mid-turn, not only when the turn ends.
const LOOK_TOOLS = /^(Read|Search|Fetch|Grep|Glob|LS|list_files|WebSearch|WebFetch|web_search|TodoWrite|todo_write)$/i;
let diffTimer: ReturnType<typeof setTimeout> | null = null;

/** Whether a finished tool call may have changed files: unknown tools count as changing. */
export function mayChangeFiles(events: StoredEvent[] | undefined, toolUseId: string): boolean {
  if (!events) return true;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!.event;
    if (e.kind === "tool-use" && e.toolUseId === toolUseId) return !LOOK_TOOLS.test(e.name);
  }
  return true;
}

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
export function acceptAppThemeState(state: AppThemeState): void {
  if (state.version <= (useStore.getState().appThemes?.version ?? -1)) return;
  useStore.setState({ appThemes: state });
  if (typeof document !== "undefined") applyChromePalette(state.preview?.theme ?? state.active, isDark() ? "dark" : "light");
}

export function applyTheme(theme: SettingsView["theme"]): void {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  const state = useStore.getState().appThemes;
  applyChromePalette(state?.preview?.theme ?? state?.active ?? null, isDark() ? "dark" : "light");
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
  return forced ? forced === "dark" : typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
}

export const useStore = create<State>((set, get) => ({
  projects: [],
  inboxTarget: null,
  threads: {},
  skills: [],
  agents: [],
  settings: null,
  appThemes: null,
  async loadAppThemes() {
    try { if (api().appThemeState) acceptAppThemeState(await api().appThemeState()); }
    catch (err) { get().showNotice(ipcErrorText(err)); }
  },
  settingsOpen: false,
  setSettingsOpen(open) {
    set({ settingsOpen: open });
  },
  aboutOpen: false,
  setAboutOpen(open) {
    set({ aboutOpen: open });
  },
  referencesSheetOpen: false,
  setReferencesSheetOpen(open) {
    set({ referencesSheetOpen: open });
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
  doctorOpen: false,
  openDoctor() {
    set({ doctorOpen: true });
  },
  closeDoctor() {
    set({ doctorOpen: false });
  },
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
  automationsRevision: {},
  librarySkill: null,
  editors: [],
  notice: null,
  initError: null,
  showNotice(text) {
    set({ notice: text });
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => set({ notice: null }), 3500);
  },
  async setCodeMode(mode) {
    const next = mode ?? ((get().settings?.codeMode ?? "off") === "on" ? "off" : "on");
    try {
      set({ settings: await api().updateSettings({ codeMode: next }) });
      get().showNotice(next === "on" ? "Code mode on: new threads get run_code" : "Code mode off for new threads");
    } catch {
      get().showNotice("Couldn't change code mode");
    }
  },
  async openInEditor(target, editor) {
    const s = get();
    const project = s.projects.find((p) => p.id === s.selectedProjectId);
    const thread = Object.values(s.threads).flat().find((t) => t.id === s.selectedThreadId);
    // A worktree thread's files (and its folder) live in its worktree, not the project folder.
    const path = target.path ?? thread?.worktreePath ?? project?.path;
    if (!path) return;
    const res = await api().openInEditor({ projectId: s.selectedProjectId, threadId: s.selectedThreadId, path, line: target.line, column: target.column }, editor);
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
  selectedOrder: [],
  threadKind: "chat",
  async setThreadKind(kind) {
    const s = get();
    if (s.threadKind === kind) return;
    set({ threadKind: kind });
    const current = s.selectedThreadId ? Object.values(s.threads).flat().find((t) => t.id === s.selectedThreadId) : undefined;
    if (current && workspaceModeOf(current) === kind) return;
    const latest = (s.threads[s.selectedProjectId ?? ""] ?? [])
      .filter((t) => !t.archived && workspaceModeOf(t) === kind)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    await get().selectThread(latest?.id ?? null);
  },
  async toggleCreator() {
    const s = get();
    if (s.threadKind === "design") return;
    const next: WorkspaceMode = s.threadKind === "creator" ? "chat" : "creator";
    set({ threadKind: next });
    const current = s.selectedThreadId ? findThread(s.threads, s.selectedThreadId) : undefined;
    if (current && workspaceModeOf(current) !== next) await get().selectThread(null);
  },
  events: {},
  history: {},
  live: {},
  running: {},
  queued: {},
  shells: {},
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
    forgetComposerDrafts(thread.projectId, threadId);
    set((s) => {
      const { [threadId]: _events, ...events } = s.events;
      const { [threadId]: _history, ...history } = s.history;
      return {
        threads: { ...s.threads, [thread.projectId]: (s.threads[thread.projectId] ?? []).filter((t) => t.id !== threadId) },
        events,
        history,
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
  automationNotices: [],
  turnStartedAt: {},
  inboxOpen: false,
  setInboxOpen(open) {
    set({ inboxOpen: open });
  },
  paneLayout: { ...DEFAULT_LAYOUT },
  studioFold: null,
  inspectorOpen: false,
  inspectorTab: "changes",
  artifact: null,
  apps: [],
  pluginCommands: [],
  pluginCommandsError: null,
  pluginCommandsLoading: false,
  appOpen: null,
  appReloads: {},
  appPage: null,
  surfaceHidden: readSurfaceHidden(),
  surfaceDrafts: [],
  surfaceFocus: null,
  appRecents: readAppRecents(),
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
  designChange: {},
  designDocuments: {},
  designSelection: {},
  setDesignSelection(threadId, selection) {
    set((s) => {
      const next = { ...s.designSelection };
      if (selection && selection.elements.length) next[threadId] = selection;
      else delete next[threadId];
      return { designSelection: next };
    });
  },
  studioRequest: null,
  requestStudio(request) {
    set({ studioRequest: request });
  },
  systemStep: {},
  setSystemStep(threadId, step) {
    set((s) => {
      const next = { ...s.systemStep };
      if (step) next[threadId] = step;
      else delete next[threadId];
      return { systemStep: next };
    });
  },
  designChip: {},
  setDesignChip(threadId, chip) {
    set((s) => {
      const next = { ...s.designChip };
      if (chip) next[threadId] = chip;
      else delete next[threadId];
      return { designChip: next };
    });
  },
  designSystemWhere: {},
  setDesignSystemWhere(threadId, where) {
    set((s) => {
      const next = { ...s.designSystemWhere };
      if (where) next[threadId] = where;
      else delete next[threadId];
      return { designSystemWhere: next };
    });
  },
  composerDraft: null,
  pendingRefs: {},
  experts: null,
  async loadExperts() {
    try {
      const experts = await api().listExperts();
      set({ experts });
    } catch {
      set({ experts: [] });
    }
  },
  async summonExpert(id, prompt) {
    const def = get().experts?.find((e) => e.id === id) ?? (await api().getExpert(id));
    if (!def) return null;
    set({ libraryTab: null });
    // A design expert works in a design thread; any other expert in a chat thread.
    await get().setThreadKind(def.threadKind === "design" ? "design" : "chat");
    const threadId = await get().newThread(def.skills, { expertId: def.id, ...(def.designSystem ? { designSystem: def.designSystem } : {}) });
    if (threadId && prompt) get().setComposerDraft(prompt);
    return threadId;
  },
  async setThreadExpert(threadId, id) {
    const thread = await api().setThreadExpert(threadId, id);
    get().apply({ type: "thread", thread });
    const def = get().experts?.find((e) => e.id === id) ?? (await api().getExpert(id));
    if (!def) return;
    if (def.skills.length) get().addPendingSkills(def.skills);
    if (def.designSystem && thread.kind === "design") await get().setDesignSystem(threadId, def.designSystem);
  },
  addDesignRefs(threadId, refs) {
    if (!refs.length) return;
    set((s) => ({ pendingRefs: { ...s.pendingRefs, [threadId]: [...(s.pendingRefs[threadId] ?? []), ...refs] } }));
  },
  takeDesignRefs(threadId) {
    const refs = get().pendingRefs[threadId] ?? [];
    if (refs.length) set((s) => ({ pendingRefs: Object.fromEntries(Object.entries(s.pendingRefs).filter(([id]) => id !== threadId)) }));
    return refs;
  },
  setComposerDraft(text, selections) {
    set((s) => ({ composerDraft: { text, ...selections, nonce: (s.composerDraft?.nonce ?? 0) + 1 } }));
  },

  async loadBrowserState() {
    // Called when the browser panel mounts, never on every render.
    if (get().browserLoaded) return;
    const generation = browserGeneration;
    browserLoad ??= api().browserState().then((browser) => set((s) => {
      const live = generation === browserGeneration ? browser : { ...browser, owner: s.browser.owner, paused: s.browser.paused };
      return { browser: live, browserLoaded: true, takeOver: { ...s.takeOver, mode: live.owner ? (live.paused ? "human-driving" : "agent-driving") : "idle", paused: Boolean(live.paused) } };
    }))
      .catch((err) => get().showNotice(`Couldn't load browser: ${ipcErrorText(err)}. Reopen the Browser tab to retry.`))
      .finally(() => { browserLoad = null; });
    await browserLoad;
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
    if (next.mode === "human-driving") void api().browserTakeOver(true, get().browser.owner);
  },

  resumeAgent() {
    const cur = get().takeOver;
    const next = takeOverReducer(cur, { type: "resume" });
    if (next === cur) return;
    set({ takeOver: next });
    void api().browserTakeOver(false, get().browser.owner);
  },

  async stopAgent() {
    const owner = get().browser.owner;
    if (!owner) return;
    try { await api().browserTakeOver(false, owner, true); }
    catch (err) { get().showNotice(`Couldn't stop the browser's turn: ${ipcErrorText(err)}`); }
  },

  setWatch(on) {
    set((s) => ({ takeOver: takeOverReducer(s.takeOver, { type: "watch", on }) }));
  },
  pendingSkills: [],
  diffVersion: 0,
  learnVersion: 0,
  openPickerRequest: 0,
  requestModelPicker() {
    set((s) => ({ openPickerRequest: s.openPickerRequest + 1 }));
  },

  issuePickerRequest: 0,
  requestIssuePicker() {
    set((s) => ({ issuePickerRequest: s.issuePickerRequest + 1 }));
  },

  async runIssueCommand(skill, args) {
    const s = get();
    const id = s.selectedThreadId;
    if (id && s.running[id]) {
      s.showNotice(`Wait for this turn to finish, then run /${skill}.`);
      return;
    }
    let text = args.trim();
    if (skill === "issue-setup") {
      // The app asks the setup questions in its own card, so every agent gets the same choices; the skill acts on the answers.
      const projectId = s.selectedProjectId;
      if (!projectId) return;
      const remote = await api().issueRemote(projectId).catch(() => null);
      const threadId = id ?? (await get().newThread());
      if (!threadId) return;
      const answer = await askInApp(threadId, setupQuestions(remote));
      const message = setupMessage(answer, remote);
      if (message === null) return;
      await get().send([message, text].filter(Boolean).join("\n\n"), [skill], threadId);
      return;
    }
    // A description is a new issue, said outright: the thread's own issue note mustn't turn it into "open #n".
    if (skill === "issue" && text && !/^(#?\d+|https?:\/\/\S+)$/.test(text)) text = `New issue: ${text}`;
    if (skill === "pr" && !text) {
      const issue = id ? findThread(s.threads, id)?.issue : s.draft.issue?.projectId === s.selectedProjectId ? s.draft.issue.issue : undefined;
      if (issue) text = String(issue.number);
    }
    if (id) await get().send(text, [skill]);
    else await get().startThread(text, [skill]);
  },

  async setIssue(issue) {
    const { selectedThreadId: id, selectedProjectId: projectId } = get();
    if (!id) {
      if (!issue) {
        const { issue: _old, ...rest } = get().draft;
        set({ draft: rest });
      } else if (projectId) set((s) => ({ draft: { ...s.draft, issue: { projectId, issue } } }));
      return;
    }
    try {
      get().apply({ type: "thread", thread: await api().setThreadIssue(id, issue) });
    } catch (err) {
      get().showNotice(ipcErrorText(err));
    }
  },

  async init() {
    // React StrictMode runs effects twice in development; subscribe once.
    if (initialized) return;
    initialized = true;
    pendingUpdates = [];
    set({ initError: null });
    // Subscribe before the first await, so no update sent during startup is lost. A retry after a
    // failed init must not double-subscribe (each onUpdate would then apply every update twice).
    if (!subscribed) {
      subscribed = true;
      api().onUpdate((u) => {
        if (u.pendingSequence !== undefined) {
          if (pendingUpdates) { pendingUpdates.push(u); return; }
          if (u.pendingSequence <= pendingSequence) return;
          pendingSequence = u.pendingSequence;
        }
        get().apply(u);
      });
    }
    try {
      const [projects, skills, agents, settings, appUpdate, limitList, pending, allThreads] = await Promise.all([
        api().listProjects(),
        api().listSkills(),
        api().listAgents(),
        api().getSettings(),
        api().updateStatus(),
        api().listLimits(),
        api().pendingState(),
        api().listAllThreads(),
      ]);
      void api()
        .listEditors()
        .then((editors) => set({ editors }));
      applyTheme(settings.theme);
      await get().loadAppThemes();
      applyMotion(settings.motion);
      applyDensity(settings.density);
      applyZoom(settings.zoom);
      const threads: Record<string, Thread[]> = {};
      for (const p of projects) threads[p.id] = allThreads[p.id] ?? [];
      const limits = Object.fromEntries(limitList.map((l) => [l.agent, l]));
      set((s) => ({ projects, skills, agents, threads, settings, paneLayout: sanitizeLayout(settings.paneLayout), appUpdate, aboutOpen: s.aboutOpen || Boolean(appUpdate?.updatedFrom), limits: { ...limits, ...s.limits } }));
      // A window that loads mid-turn picks up what's live: running threads and the cards waiting on the user.
      const now = Date.now();
      const waiting = pending.queued ?? [];
      set({
        running: Object.fromEntries([...pending.running, ...waiting].map((id) => [id, true])),
        queued: Object.fromEntries(waiting.map((id) => [id, true])),
        turnStartedAt: Object.fromEntries(pending.running.map((id) => [id, now])),
        permissions: pending.permissions, plans: pending.plans, questions: pending.questions,
        automationNotices: pending.automationNotices ?? [],
      });
      pendingSequence = pending.sequence ?? -1;
      const buffered: LiveUpdate[] = pendingUpdates;
      pendingUpdates = null;
      for (const update of buffered.sort((a, b) => a.pendingSequence! - b.pendingSequence!)) {
        if (update.pendingSequence! <= pendingSequence) continue;
        pendingSequence = update.pendingSequence!;
        get().apply(update);
      }
      // Reopen where the user left off: the project, thread and new-thread picks of the last launch.
      const saved = readSession();
      set(restoreDraft(saved, agents));
      restored = true;
      const target = restoreTarget(saved, projects, threads);
      if (target) {
        await get().selectProject(target.projectId);
        // Open the selected thread before the per-project branch loads, which are not on the critical path.
        const opening = target.threadId ? get().selectThread(target.threadId) : Promise.resolve();
        for (const p of projects) void get().loadBranch(p.id);
        await opening;
      }
    } catch (err) {
      // A startup call that rejects used to leave a blank window; let the user retry.
      initialized = false;
      pendingUpdates = null;
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

  async newChat() {
    let chats: Project;
    try {
      chats = await api().openChats();
    } catch (err) {
      get().showNotice(`Couldn't start a chat: ${ipcErrorText(err)}`);
      return null;
    }
    set((s) => ({
      projects: s.projects.some((p) => p.id === chats.id) ? s.projects : [...s.projects, chats].sort((a, b) => a.name.localeCompare(b.name)),
      threads: s.threads[chats.id] ? s.threads : { ...s.threads, [chats.id]: [] },
    }));
    await get().selectProject(chats.id);
    // A chat, even from Design mode: Chats is for talking, and its threads open in Chat.
    if (get().threadKind !== "chat") await get().setThreadKind("chat");
    return get().newThread();
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
    forgetComposerDrafts(id);
    const remainingProjects = get().projects.filter((p) => p.id !== id);
    const nextProjectId = currentSelected ? (remainingProjects[0]?.id ?? null) : get().selectedProjectId;
    const threadIdsToRemove = new Set((get().threads[id] ?? []).map((t) => t.id));

    set((s) => {
      const { [id]: _removedThreads, ...threads } = s.threads;
      const { [id]: _removedBranch, ...projectBranches } = s.projectBranches;
      const events = Object.fromEntries(Object.entries(s.events).filter(([tid]) => !threadIdsToRemove.has(tid)));
      const history = Object.fromEntries(Object.entries(s.history).filter(([tid]) => !threadIdsToRemove.has(tid)));
      const finished = s.finished.filter((f) => !threadIdsToRemove.has(f.threadId));
      const selectedThreadId = threadIdsToRemove.has(s.selectedThreadId ?? "") ? null : s.selectedThreadId;

      return {
        projects: remainingProjects,
        threads,
        projectBranches,
        events,
        history,
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
    const selection = ++projectSelection;
    set({ selectedProjectId: id, ...(get().selectedProjectId !== id ? { appPage: null, skills: [] } : {}) });
    void get().loadBranch(id);
    if (!get().threads[id]) {
      const list = await api().listThreads(id);
      set((s) => ({ threads: { ...s.threads, [id]: list } }));
    }
    if (selection !== projectSelection) return;
    void api().listSkills(id).then((skills) => {
      if (selection === projectSelection && get().selectedProjectId === id) set({ skills });
    }).catch((err) => { if (selection === projectSelection) get().showNotice(ipcErrorText(err)); });
  },

  async selectThread(id) {
    const picked = id ? Object.values(get().threads).flat().find((t) => t.id === id) : undefined;
    set((s) => ({
      selectedThreadId: id,
      // A page belongs to the main area until the user goes to a thread.
      appPage: null,
      // Keep the selection order so the per-thread caches can be bounded below.
      selectedOrder: id ? [...s.selectedOrder.filter((x) => x !== id), id] : s.selectedOrder,
      // Jumping to a thread (⌘K, the Message Center) lands in its mode.
      ...(picked ? { threadKind: workspaceModeOf(picked) } : {}),
      finished: threadSeen(s.finished, id),
      // Opening a thread also clears the run notices it delivered into.
      automationNotices: id ? s.automationNotices.filter((n) => n.threadId !== id) : s.automationNotices,
      // The File tab belongs to one thread: leaving it closes the file.
      ...(s.artifact && s.artifact.threadId !== id
        ? { artifact: null, ...(s.inspectorTab === "artifact" ? { inspectorTab: "changes" as const, inspectorOpen: false } : {}) }
        : {}),
    }));
    // Bound the caches: keep the selection and live work (running turns, cards, queued messages).
    const state = get();
    const keep = new Set<string>();
    if (id) keep.add(id);
    for (const [tid, on] of Object.entries(state.running)) if (on) keep.add(tid);
    for (const p of state.permissions) keep.add(p.threadId);
    for (const p of state.plans) keep.add(p.threadId);
    for (const q of state.questions) keep.add(q.threadId);
    for (const [tid, list] of Object.entries(state.outbox)) if (list.length) keep.add(tid);
    const drop = evictable(state.selectedOrder, keep, CACHE_THREADS);
    if (drop.length) {
      const dropped = new Set(drop);
      set((s) => {
        const events = { ...s.events };
        const history = { ...s.history };
        const artifactFiles = { ...s.artifactFiles };
        const turnScores = { ...s.turnScores };
        const live = { ...s.live };
        for (const tid of dropped) {
          delete events[tid];
          delete history[tid];
          delete artifactFiles[tid];
          delete turnScores[tid];
          if (!s.running[tid]) delete live[tid];
        }
        return { events, history, artifactFiles, turnScores, live, selectedOrder: s.selectedOrder.filter((x) => !dropped.has(x)) };
      });
    }
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
      const [page, totals] = await Promise.all([api().listEventsPage(id, { minEvents: HISTORY_PAGE }), api().threadTotals(id)]);
      set((s) => ({
        // Live events can land while the page loads: keep the union, the page's stored copies winning.
        events: { ...s.events, [id]: mergeBySeq(s.events[id] ?? [], page.events) },
        history: { ...s.history, [id]: { firstSeq: page.firstSeq, hasMore: page.hasMore, loadingOlder: false, totals } },
      }));
    }
  },

  async loadOlder(threadId) {
    const history = get().history[threadId];
    if (!history?.hasMore || history.loadingOlder) return;
    set((s) => ({ history: { ...s.history, [threadId]: { ...history, loadingOlder: true } } }));
    try {
      const page = await api().listEventsPage(threadId, { beforeSeq: history.firstSeq, minEvents: HISTORY_PAGE });
      set((s) => {
        const current = s.history[threadId] ?? history;
        return {
          events: { ...s.events, [threadId]: mergeBySeq(s.events[threadId] ?? [], page.events) },
          // An empty page has no firstSeq to take; hasMore going false ends the paging anyway.
          history: { ...s.history, [threadId]: { ...current, firstSeq: page.events.length ? page.firstSeq : current.firstSeq, hasMore: page.hasMore, loadingOlder: false } },
        };
      });
    } catch {
      // Leave the loaded window as it was; the control stays so the user can retry.
      set((s) => ({ history: { ...s.history, [threadId]: { ...(s.history[threadId] ?? history), loadingOlder: false } } }));
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
      // The issue is a nicety: a tracker that went away since the pick doesn't stop the thread.
      if (draft.issue?.projectId === projectId) {
        const created = thread;
        thread = await api().setThreadIssue(created.id, draft.issue.issue).catch(() => created);
      }
    } catch (err) {
      get().showNotice(ipcErrorText(err));
      return null;
    }
    set((s) => ({
      pendingSkills: skills ?? [],
      threads: { ...s.threads, [projectId]: upsertThread(s.threads[projectId], thread) },
      events: { ...s.events, [thread.id]: [] },
      history: { ...s.history, [thread.id]: { firstSeq: 0, hasMore: false, loadingOlder: false, totals: null } },
      selectedThreadId: thread.id,
      draft: {},
      lastAgent: thread.agent,
    }));
    return thread.id;
  },

  async buildDesignInCode(designThreadId, snapshot, page) {
    const design = findThread(get().threads, designThreadId);
    if (!design || design.kind !== "design") return;
    // Chats has no codebase: a build thread there starts in its own empty folder and can't find the design.
    if (get().projects.find((p) => p.id === design.projectId)?.builtin) {
      get().showNotice("Building in a codebase needs a project folder. Chats has none.");
      return;
    }
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
      history: { ...s.history, [thread.id]: { firstSeq: 0, hasMore: false, loadingOlder: false, totals: null } },
    }));
    const ok = await get().send(buildInCodePrompt(snapshot, page), undefined, thread.id);
    if (ok) get().showNotice("Building it in a new chat thread. The Message Center says when it's done.");
  },

  sendInBackground(text, skills, opts, mentions, files) {
    return startComposerThread(true, text, skills, mentions, files, opts);
  },

  startThread(text, skills, mentions, files, selections) {
    return startComposerThread(false, text, skills, mentions, files, selections);
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
  admitting: {},
  async deliverOutbox(threadId, message) {
    if (!get().outbox[threadId]?.includes(message) || get().admitting[threadId] || get().running[threadId]) return;
    set((s) => ({ outbox: { ...s.outbox, [threadId]: s.outbox[threadId]!.filter((m) => m !== message) } }));
    await get().send(message.text, message.skills, threadId, message.mentions, { ...message, pluginSkills: message.pluginSkills ?? [], keepOnRefusal: true });
  },
  enqueue(threadId, text, skills, mentions, files, selections) {
    const pinned = selections?.pluginSkills ? selections : { ...pluginSkillSelections(get().skills.filter((s) => skills?.includes(s.name))), ...selections };
    set((s) => ({
      outbox: {
        ...s.outbox,
        [threadId]: [...(s.outbox[threadId] ?? []), { text, ...pinned, ...(skills?.length ? { skills } : {}), ...(mentions?.length ? { mentions } : {}), ...(files?.length ? { files } : {}) }],
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

  async send(text, skills, threadId, mentions, opts) {
    const id = threadId ?? get().selectedThreadId;
    if (!id) return false;
    const controller = new AbortController();
    const { keepOnRefusal, ...options } = opts ?? {};
    const message: OutboxMessage = { ...options, text, skills, mentions };
    try {
      message.pluginSkills ??= pluginSkillSelections(get().skills.filter((s) => skills?.includes(s.name))).pluginSkills ?? [];
      if (get().running[id] || get().queued[id] || get().admitting[id]) throw new Error("This thread is already sending or running.");
      set((s) => ({ admitting: { ...s.admitting, [id]: controller } }));
      if (message.initialPatch && Object.keys(message.initialPatch).length) {
        const thread = await api().updateThread(id, message.initialPatch);
        get().apply({ type: "thread", thread });
      }
      delete message.initialPatch;
      // New files are copied into the thread before the turn starts, so the message can point at them.
      if (message.files?.length) {
        const saved = await api().saveAttachments(id, message.files);
        message.attachments = [...(message.attachments ?? []), ...saved];
        delete message.files;
      }
      if (controller.signal.aborted) throw new Error("Stopped before sending.");
      const admission = await api().send({
        threadId: id,
        text,
        ...(skills?.length ? { skills } : {}),
        ...(mentions?.length ? { mentions } : {}),
        ...(message.attachments?.length ? { attachments: message.attachments } : {}),
        ...(opts?.background ? { background: true } : {}),
        ...(opts?.pluginCommand ? { pluginCommand: opts.pluginCommand } : {}),
        ...(message.pluginSkills.length ? { pluginSkills: message.pluginSkills } : {}),
      });
      if (admission.status === "rejected") throw new Error(admission.reason);
      if (opts?.background && !controller.signal.aborted) get().showNotice(admission.status === "queued" ? "Queued. This thread starts when a slot is free." : "Started in the background. The Message Center says when it's done.");
      return true;
    } catch (err) {
      if (keepOnRefusal) set((s) => ({ outbox: { ...s.outbox, [id]: [{ ...message, retry: true }, ...(s.outbox[id] ?? [])] } }));
      get().showNotice(`Couldn't send: ${ipcErrorText(err)}`);
      return false;
    } finally {
      if (get().admitting[id] === controller) set((s) => {
        const { [id]: _settled, ...admitting } = s.admitting;
        return { admitting };
      });
      if (endedBeforeReply.has(controller) && !controller.signal.aborted) drainOutbox(id);
    }
  },

  async compact(threadId, focus) {
    if (get().running[threadId]) return;
    try {
      const admission = await api().send({ threadId, text: `/compact${focus ? ` ${focus}` : ""}`, compact: { focus } });
      if (admission.status === "rejected") throw new Error(admission.reason);
    } catch (err) {
      get().showNotice(`Couldn't compact: ${ipcErrorText(err)}`);
    }
  },

  async interrupt() {
    const id = get().selectedThreadId;
    if (!id) return;
    await get().interruptThread(id);
  },

  async interruptThread(threadId) {
    get().admitting[threadId]?.abort();
    // Drop queued work before the turn's end can deliver it. Refused messages are manual drafts.
    set((s) => {
      const { [threadId]: pending, ...outbox } = s.outbox;
      const refused = pending?.filter((m) => m.retry);
      if (refused?.length) outbox[threadId] = refused;
      return { outbox };
    });
    await api().interrupt(threadId);
  },

  async stopAllRunning() {
    const s = get();
    const waiting = waitingThreads(s.permissions, s.plans, s.questions);
    const ids = new Set([...Object.keys(s.running).filter((id) => s.running[id]), ...Object.keys(s.admitting), ...waiting]);
    await Promise.all([...ids].map((id) => get().interruptThread(id)));
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
    // A card the app raised itself (askInApp) is answered here; it never went to an agent.
    const local = appAnswers.get(requestId);
    if (local) {
      appAnswers.delete(requestId);
      set((s) => ({ questions: s.questions.filter((q) => q.requestId !== requestId) }));
      local(answer);
      return;
    }
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

  async loadPluginCommands() {
    const request = ++pluginCommandRequest;
    set({ pluginCommandsLoading: true });
    try {
      const commands = await api().listPluginCommands();
      if (request === pluginCommandRequest) set({ pluginCommands: commands, pluginCommandsError: null });
    } catch (e) { if (request === pluginCommandRequest) set({ pluginCommands: [], pluginCommandsError: ipcErrorText(e) }); }
    finally { if (request === pluginCommandRequest) set({ pluginCommandsLoading: false }); }
  },

  async loadApps() {
    void get().loadPluginCommands();
    const projectId = get().selectedProjectId;
    try {
      const apps = await api().listApps(projectId);
      // A reply for a project the user already left is dropped.
      if (get().selectedProjectId === projectId) {
        const open = get().appOpen;
        const fresh = open && open.scope !== "draft" ? apps.find((a) => a.key === open.key) : null;
        const usable = fresh && fresh.enabled !== false && !fresh.error && hostOf(fresh) === "modal";
        const page = get().appPage;
        const freshPage = page ? apps.find((a) => a.key === page.key && a.enabled !== false && !a.error && a.placement === "page") : undefined;
        set({ apps, ...(usable ? { appOpen: fresh } : {}), ...(page ? { appPage: freshPage ?? null } : {}) });
        if (open && open.scope !== "draft" && !usable) get().closeApp();
      }
    } catch {
      // The list stays as it was.
    }
  },

  openApp(app) {
    const s = get();
    if (app.enabled === false || app.error) {
      s.showNotice(app.error ?? "This app is off. Turn it on in Library → Plugins.");
      return;
    }
    if (app.scope !== "draft") {
      const appRecents = { ...s.appRecents, [app.key]: Date.now() };
      writeAppRecents(appRecents);
      set({ appRecents });
    }
    const host = hostOf(app);
    if (host === "surface") {
      const n = (s.surfaceFocus?.n ?? 0) + 1;
      if (app.scope === "draft") set((x) => ({ surfaceDrafts: [...x.surfaceDrafts.filter((d) => d.key !== app.key), app], surfaceFocus: { key: app.key, n } }));
      else {
        const hidden = s.surfaceHidden.filter((k) => k !== app.key);
        if (hidden.length !== s.surfaceHidden.length) writeSurfaceHidden(hidden);
        set({ surfaceHidden: hidden, surfaceFocus: { key: app.key, n } });
      }
      // A panel lives in the sidebar: a folded sidebar opens so it can be seen.
      if (app.placement === "panel" && s.paneLayout.sidebarCollapsed && s.studioFold === null) s.setPaneLayout({ sidebarCollapsed: false }, true);
      // The same app in another host (its placement just changed) gives way.
      set((x) => ({ ...(x.appOpen?.key === app.key ? { appOpen: null } : {}), ...(x.appPage?.key === app.key ? { appPage: null } : {}) }));
      return;
    }
    if (host === "page") {
      set((x) => ({ appPage: app, appOpen: null, surfaceDrafts: x.surfaceDrafts.filter((d) => d.key !== app.key) }));
      return;
    }
    set((x) => ({ appOpen: app, surfaceDrafts: x.surfaceDrafts.filter((d) => d.key !== app.key), ...(x.appPage?.key === app.key ? { appPage: null } : {}) }));
  },

  closeSurface(key) {
    const s = get();
    if (s.surfaceDrafts.some((d) => d.key === key)) {
      set({ surfaceDrafts: s.surfaceDrafts.filter((d) => d.key !== key) });
      return;
    }
    if (s.surfaceHidden.includes(key)) return;
    const hidden = [...s.surfaceHidden, key];
    writeSurfaceHidden(hidden);
    set({ surfaceHidden: hidden });
  },

  async editApp(app) {
    const s = get();
    try {
      const project = s.selectedProjectId ? s.projects.find((p) => p.id === s.selectedProjectId) : await api().openChats();
      if (!project) throw new Error("Choose a project or open Chats first.");
      const current = s.selectedThreadId ? findThread(s.threads, s.selectedThreadId) : undefined;
      const agent = s.draft.agent ?? current?.agent ?? s.lastAgent ?? undefined;
      const draft = current && current.agent === agent ? { model: current.model ?? undefined, effort: current.effort ?? undefined, contextWindow: current.contextWindow, ...s.draft } : s.draft;
      // Always a new Creator chat, never a design thread, worktree or an automatic model turn.
      let thread = await api().createThread(project.id, agent, { kind: "chat", preset: "creator" });
      thread = await api().updateThread(thread.id, { ...draftPatch(draft, thread), title: `Edit ${app.title}` });
      const prepared = await api().prepareAppEdit(app.key, thread.id);
      set((x) => ({
        projects: x.projects.some((p) => p.id === project.id) ? x.projects : [...x.projects, project],
        threads: { ...x.threads, [project.id]: upsertThread(x.threads[project.id], thread) },
        events: { ...x.events, [thread.id]: [] },
        history: { ...x.history, [thread.id]: { firstSeq: 0, hasMore: false, loadingOlder: false, totals: null } },
        selectedProjectId: project.id,
        selectedThreadId: thread.id,
        threadKind: "creator",
        draft: {},
        pendingSkills: [],
        lastAgent: thread.agent,
        libraryTab: null,
        composerDraft: { text: prepared.prompt, nonce: (x.composerDraft?.nonce ?? 0) + 1 },
      }));
      get().openApp(prepared.app);
      return thread.id;
    } catch (err) {
      get().showNotice(`Couldn't edit the app: ${ipcErrorText(err)}`);
      return null;
    }
  },

  closeApp() {
    set({ appOpen: null });
  },

  closePage() {
    set({ appPage: null });
  },

  pluginNotify(app, text) {
    const t = text.replace(/\s+/g, " ").trim().slice(0, 200);
    if (t) get().showNotice(`${app.title}: ${t}`);
  },

  pluginOpen(from, name) {
    const target = get().apps.find((a) => a.name === name && a.scope !== "draft");
    if (!target) {
      get().showNotice(`${from.title} tried to open "${name.slice(0, 64)}", which isn't installed.`);
      return;
    }
    get().openApp(target);
  },

  async pluginAsk(app, prompt) {
    const text = prompt.trim().slice(0, 4000);
    if (!text) return;
    // A fresh chat (newChat reports its own failure); the text only fills the composer, the user sends it.
    await get().newChat();
    set({ appPage: null, appOpen: null });
    get().setComposerDraft(text);
    get().showNotice(`${app.title} started a chat. Read it, then send it.`);
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
      case "learn-changed":
        // An open Learned tab refetches: bump the version its effect depends on.
        set((s) => ({ learnVersion: s.learnVersion + 1 }));
        return;
      case "design-changed":
        set((s) => ({
          // The editor's own save: the frame already shows it, so nothing reloads.
          designReload: update.own ? s.designReload : { ...s.designReload, [update.threadId]: (s.designReload[update.threadId] ?? 0) + 1 },
          designChange: { ...s.designChange, [update.threadId]: { n: (s.designChange[update.threadId]?.n ?? 0) + 1, paths: update.paths ?? null } },
        }));
        return;
      case "design-document":
        set((s) => {
          const prior = s.designDocuments[update.status.documentId];
          return { designDocuments: { ...s.designDocuments, [update.status.documentId]: { status: update.status, conflicts: (prior?.conflicts ?? 0) + (update.conflicts ? 1 : 0) } } };
        });
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
        {
          const e = update.stored.event;
          // Coalesce a burst of edits into one diff reload.
          if (e.kind === "tool-result" && !e.isError && !diffTimer && mayChangeFiles(get().events[update.threadId], e.toolUseId)) {
            diffTimer = setTimeout(() => {
              diffTimer = null;
              set((s) => ({ diffVersion: s.diffVersion + 1 }));
            }, 300);
          }
        }
        set((s) => {
          const list = s.events[update.threadId];
          if (list?.some((e) => e.seq === update.stored.seq)) return {};
          // Deltas that arrived before this terminal event must land first.
          const live = drainQueue(s);
          live[update.threadId] = applyLiveEvent(live[update.threadId] ?? emptyLive(), update.stored);
          // An event for a thread whose history isn't loaded (and isn't being loaded) must not
          // make a one-event list, which would block the page load; selectThread brings it in.
          if (!list && update.threadId !== s.selectedThreadId) return { live };
          return {
            events: { ...s.events, [update.threadId]: [...(list ?? []), update.stored] },
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
      case "queued":
        set((s) => ({ queued: { ...s.queued, [update.threadId]: update.queued }, ...(update.queued ? { running: { ...s.running, [update.threadId]: true } } : {}) }));
        return;
      case "shell":
        set((s) => ({ shells: { ...s.shells, [update.shell.id]: update.shell } }));
        return;
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
          const pending = get().admitting[update.threadId];
          if (pending) endedBeforeReply.add(pending);
          else drainOutbox(update.threadId);
        }
        return;
      case "permission":
        set((s) =>
          s.permissions.some((p) => p.requestId === update.request.requestId)
            ? {}
            : { permissions: [...s.permissions, update.request] },
        );
        return;
      case "permission-withdrawn":
        set((s) => ({ permissions: s.permissions.filter((p) => p.requestId !== update.requestId) }));
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
      case "browser-action": {
        const owner = get().browser.owner;
        if (owner && update.owner?.turnId === owner.turnId && update.owner.threadId === owner.threadId) {
          set((s) => ({ takeOver: takeOverReducer(s.takeOver, { type: "agent-action" }) }));
        }
        return;
      }
      case "browser-control":
        browserGeneration++;
        set((s) => ({ browser: { ...s.browser, owner: update.owner, paused: update.paused }, takeOver: { ...s.takeOver,
          mode: update.owner ? (update.paused ? "human-driving" : "agent-driving") : "idle", paused: update.paused, steps: update.owner?.turnId === s.browser.owner?.turnId ? s.takeOver.steps : 0 } }));
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
      case "apps-changed":
        void get().loadApps();
        return;
      case "app-themes-changed":
        void get().loadAppThemes();
        return;
      case "automations-changed":
        if (typeof update.projectId !== "string" || !update.projectId || update.projectId.length > 160) return;
        set((s) => ({ automationsRevision: { ...s.automationsRevision, [update.projectId]: (s.automationsRevision[update.projectId] ?? 0) + 1 } }));
        return;
      case "app-open":
        // Only the window showing that Creator thread opens it; elsewhere it would take over the panel.
        if (get().selectedThreadId === update.threadId) get().openApp(update.app);
        else if (get().appOpen?.key === update.app.key && hostOf(update.app) === "modal") set({ appOpen: update.app });
        else if (get().surfaceDrafts.some((d) => d.key === update.app.key)) get().openApp(update.app);
        return;
      case "app-reload": {
        set((s) => ({ appReloads: { ...s.appReloads, [update.key]: (s.appReloads[update.key] ?? 0) + 1 } }));
        // A shown draft takes its fresh title, size and placement (and moves between modal and widget if that changed).
        const fresh = update.app;
        if (!fresh || fresh.key !== update.key) return;
        const s = get();
        const inModal = s.appOpen?.key === fresh.key;
        const inSurface = s.surfaceDrafts.some((d) => d.key === fresh.key);
        const host = hostOf(fresh);
        // Placement changed: it moves to the other host. Otherwise update it in place, without stealing focus.
        if ((inModal && host !== "modal") || (inSurface && host !== "surface")) s.openApp(fresh);
        else if (inModal) set({ appOpen: fresh });
        else if (inSurface) set({ surfaceDrafts: s.surfaceDrafts.map((d) => (d.key === fresh.key ? fresh : d)) });
        return;
      }
      case "open-about":
        set({ aboutOpen: true });
        break;
      case "automation-run": {
        // Only the newest run per automation matters; keep the list bounded.
        const notice = update.notice;
        set((s) => {
          const previous = s.automationNotices.find((n) => n.automationId === notice.automationId);
          if (previous && newestNoticeFirst(previous, notice) < 0) return s;
          return { automationNotices: [notice, ...s.automationNotices.filter((n) => n !== previous)].sort(newestNoticeFirst).slice(0, 20) };
        });
        return;
      }
      case "automation-delivered":
        // The delivered thread's own Finished row already covers it.
        return;
      case "thread": {
        const unknown = !get().projects.some((p) => p.id === update.thread.projectId);
        set((s) => ({
          threads: { ...s.threads, [update.thread.projectId]: upsertThread(s.threads[update.thread.projectId], update.thread) },
        }));
        // A thread for a project this window hasn't listed yet (made elsewhere): fetch the list so it can show.
        // Best effort, off this call: a failed fetch mustn't break whoever applied the thread.
        if (unknown)
          void Promise.resolve()
            .then(() => api().listProjects())
            .then((projects) => set({ projects }))
            .catch(() => undefined);
        return;
      }
    }
  },
}));

// Remember where the user is for the next launch. A selection left over from another project shows that project's
// start page, so it's saved as one.
useStore.subscribe((s, prev) => {
  if (!restored) return;
  if (s.selectedProjectId === prev.selectedProjectId && s.selectedThreadId === prev.selectedThreadId && s.draft === prev.draft && s.lastAgent === prev.lastAgent && s.threads === prev.threads) return;
  const open = s.selectedProjectId && s.selectedThreadId && s.threads[s.selectedProjectId]?.some((t) => t.id === s.selectedThreadId);
  writeSession({ projectId: s.selectedProjectId, threadId: open ? s.selectedThreadId : null, lastAgent: s.lastAgent, draft: s.draft });
});

/** Whether `path` (relative to the thread's folder) is inside a design thread's own folder. */
function isDesignFile(s: Pick<State, "threads">, threadId: string, path: string): boolean {
  const thread = Object.values(s.threads).flat().find((t) => t.id === threadId);
  return thread?.kind === "design" && path.startsWith(`${designDirName(threadId)}/`);
}

/**
 * Which of a design folder's `pages` a change affects: "all" when the paths are unknown or any changed file
 * isn't an `.html` page (css, js, images, fonts, json, folders… may be shared by every page), else the changed
 * paths that are pages. An `.html` that isn't a page affects nothing.
 */
export function affectedPages(paths: string[] | undefined, pages: string[]): string[] | "all" {
  if (!paths) return "all";
  const known = new Set(pages);
  const out: string[] = [];
  for (const path of paths) {
    if (!/\.html$/i.test(path)) return "all";
    if (known.has(path)) out.push(path);
  }
  return out;
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

const FLOATING_HIDDEN_KEY = "cubiq.floating.hidden";

/** Closed floating widgets, from localStorage; unreadable storage means none are hidden. */
/**
 * Which host shows an app: widgets, docks and panels stay mounted ("surface"); an installed page fills the main area;
 * everything else, and a Creator draft of a page (the chat beside it must stay visible), opens in the modal.
 */
export function hostOf(app: Pick<AppInfo, "placement" | "scope">): "modal" | "page" | "surface" {
  if (app.placement === "floating" || app.placement === "dock" || app.placement === "panel") return "surface";
  if (app.placement === "page" && app.scope !== "draft") return "page";
  return "modal";
}

function readSurfaceHidden(): string[] {
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem(FLOATING_HIDDEN_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((k): k is string => typeof k === "string" && k.length <= 200).slice(0, 200) : [];
  } catch {
    return [];
  }
}

function writeSurfaceHidden(keys: string[]): void {
  try {
    globalThis.localStorage?.setItem(FLOATING_HIDDEN_KEY, JSON.stringify(keys));
  } catch {
    // Not remembered: the widget shows again next start.
  }
}
