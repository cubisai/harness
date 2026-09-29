// The contract between the main process and the renderer. Everything that
// crosses the preload bridge is one of these types.

export type Invocation = "model" | "user";

/** Where a skill was found: the standard folders, or the legacy skills.json root. */
/** "projectClaude" is the project's .claude/skills: listed as Project, read natively only by Claude. */
export type SkillOrigin = "project" | "projectClaude" | "harness" | "shared" | "bundled" | "legacy";

/** One skill: a folder with a SKILL.md (see plan/docs/HARNESS.md). */
export interface SkillEntry {
  name: string;
  description: string;
  invocation: Invocation;
  argumentHint?: string;
  compatibility?: string;
  calls: string[];
  files: string[];
  sha256: string;
  /** Which search root it came from; absent on entries built before discovery. */
  origin?: SkillOrigin;
  /** The skill's folder, so links resolve and copies have a source. */
  dir?: string;
  /** False when the frontmatter says `user-invocable: false`. */
  userInvocable?: boolean;
  /** False when the user turned it off in Settings. */
  enabled?: boolean;
  /** The origin of the higher-precedence same-name skill that won. */
  shadowedBy?: SkillOrigin;
}

export interface Project {
  id: string;
  path: string;
  name: string;
  createdAt: number;
}

export type PermissionMode = "ask" | "auto-edit" | "plan" | "full";

export type Theme = "system" | "light" | "dark";
/** How much the UI animates. `prefers-reduced-motion: reduce` always wins and means instant. */
export type Motion = "instant" | "subtle" | "full";
/** Row spacing in the sidebar and transcript. */
export type Density = "comfortable" | "compact";
/** @deprecated a provider id; kept one release */
export type SecretName = string;

/** The wire protocol a provider speaks: it decides path suffixes, request bodies and probes. */
export type WireProtocol = "anthropic-messages" | "openai-responses" | "openai-chat" | "gemini";

export interface ModelCapabilities {
  tools: boolean; // required: gate tool-calling
  vision: boolean;
  reasoning: boolean;
  promptCaching?: boolean;
}

export interface ProviderModel {
  id: string; // id shown in our picker
  modelID?: string; // id actually sent on the wire, when it differs
  name?: string;
  capabilities: ModelCapabilities;
  contextWindow: number;
  maxOutput: number;
  alias?: "opus" | "sonnet" | "haiku"; // pins Claude alias slots
}

export interface ProviderSecret {
  kind: "safeStorage" | "envRef" | "command";
  ciphertext?: string; // safeStorage blob, opaque
  envVar?: string; // envRef: read from our own process env
  command?: string[]; // command: token fetcher (Codex-style)
}

export interface Provider {
  id: string; // stable slug; must avoid reserved ids
  label: string;
  wireProtocol: WireProtocol;
  baseURL: string;
  secret: ProviderSecret; // stored key OR env-var reference
  models: ProviderModel[];
  headers?: Record<string, string>;
  env?: Record<string, string>; // extra vars injected into the agent process
  queryParams?: Record<string, string>;
  retries?: { request?: number; stream?: number; streamIdleTimeoutMs?: number };
  contextWindowOverride?: number;
  pathMode?: "auto" | "raw"; // escape hatch: send the URL exactly as typed
  betaHeaders?: "default" | "strip";
}

/** A Provider as the renderer sees it; never carries key material. */
export type ProviderView = Omit<Provider, "secret"> & { secretKind: ProviderSecret["kind"]; hasSecret: boolean };

/** A Provider as the renderer sends it: the secret is a descriptor, never a value. */
export type ProviderInput = Omit<Provider, "secret"> & { secret?: Omit<ProviderSecret, "ciphertext"> };

/** The result of probing a provider: reachability, model listing, and tool-calling parity. */
export interface ConnectionResult {
  reachable: boolean;
  listsModels: boolean | null;
  supportsTools: boolean | null;
  triage?: string;
}

/** The per-agent credential choice; subscription = the agent's own login/config. */
export type CredentialChoice = { kind: "byok"; providerId: string } | { kind: "subscription" };

/** Panel geometry: a setting, so it survives a restart. Disclosure state is not part of it. */
export interface PaneLayout {
  sidebar: number;
  sidebarCollapsed: boolean;
  inspector: number;
  inspectorCollapsed: boolean;
  /** Height of the bottom terminal drawer. */
  terminal: number;
  terminalOpen: boolean;
  /** The browser takes the main area and the conversation becomes a rail. */
  browserWide: boolean;
}

export interface Settings {
  theme: Theme;
  /** Panel and thread-switch animation; SettingsStore.get() always fills it in (default instant). */
  motion?: Motion;
  /** Thread, tool and turn-meta row spacing; SettingsStore.get() always fills it in (default comfortable). */
  density?: Density;
  /** The Antigravity opt-in; on only with a current `antigravityAck`. Default off. */
  antigravity?: boolean;
  /** When the user accepted the Antigravity terms risk, and which disclosure version they saw. */
  antigravityAck?: { version: number; at: number } | null;
  /** The agent new threads start with; null = the first available (Claude). */
  defaultAgent: string | null;
  defaultPermissionMode: PermissionMode;
  /** Download new versions in the background and install them on quit. */
  autoUpdate: boolean;
  /** The editor "Open in editor" uses; null = the first one found. */
  editor: string | null;
  /** Per agent id: allow BYOK injection for drivers that write outside the app data folder. Absent = off. */
  providerInjection: Record<string, boolean>;
  /** Panel sizes and which panels are collapsed; SettingsStore.get() always fills it in. */
  paneLayout?: PaneLayout;
  /** Skills the user turned off, as `${origin}:${name}`. */
  skills?: { disabled: string[] };
  /** Shared CubiQ memory: on unless turned off; projects listed here are off. SettingsStore.get() always fills it in. */
  memory?: { enabled: boolean; disabledProjects: string[] };
}

export interface EditorInfo {
  id: string;
  label: string;
}

export type OpenResult = { ok: true; editor: string } | { ok: false; error: string };

/** How to start an MCP server: a local command, or a URL (Streamable HTTP). */
export type McpServerSpec =
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { type: "http"; url: string; headers?: Record<string, string> };

/** An MCP server the app passes to every agent (mcp.json in the data folder). */
export interface McpServerEntry {
  name: string;
  spec: McpServerSpec;
  enabled: boolean;
}

/** An MCP server as the window sees it: env and header values never leave the main process. */
export interface McpServerView {
  name: string;
  enabled: boolean;
  type: McpServerSpec["type"];
  /** The command line or URL. */
  target: string;
  envKeys: string[];
  headerKeys: string[];
}

/** A server an agent loads from its own config, shown read-only. */
export interface ExternalMcpServer {
  name: string;
  type: "stdio" | "http" | "sse" | "unknown";
  target: string;
  /** Which agent loads it, and from where. */
  agent: string;
  source: string;
}

export interface McpOverview {
  /** The app's own tools (the browser pane's), served to agents as the "cubiq" server. */
  builtIn: { name: string; active: boolean; tools: { name: string; description: string; autoAllow: boolean }[] };
  /** The global servers, for all projects. */
  servers: McpServerView[];
  /** The selected project's own servers and the global ones it switches off; null for the global scope. */
  project: { servers: McpServerView[]; offGlobal: string[]; file: string } | null;
  external: ExternalMcpServer[];
  file: string;
}

export interface McpTestResult {
  ok: boolean;
  tools: { name: string; description: string }[];
  error?: string;
}

/** Everything the Library shows about one skill. */
export interface SkillDetail {
  skill: SkillEntry;
  /** SKILL.md without its frontmatter. */
  body: string;
  dir: string;
  /** Skills that call this one. */
  calledBy: string[];
  /** How the skill reaches each available agent. */
  routes: { agent: string; how: string }[];
}

/** An agent the app knows, installed or not. */
export interface AgentCatalogEntry {
  id: string;
  label: string;
  kind: "agent-sdk" | "app-server" | "acp" | "cli";
  /** The command line the app runs, or null for the in-process SDK. */
  command: string | null;
  installed: boolean;
  source: "built-in" | "agents.json";
  install?: string;
  homepage?: string;
  /** How skilled's model-invoked skills reach it. */
  skills: string;
  /** How MCP servers (the app's and the browser tools) reach it. */
  mcp: string;
  /** What it can do here; the Library shows it as chips and a can't-do list. */
  capabilities?: AgentCapabilities;
  /** Reached only unofficially: shown as "Unsupported · <this>". */
  unsupported?: string;
  /** Hidden until Settings records the opt-in acknowledgement. */
  optIn?: boolean;
}

/** One plan rate-limit window, e.g. Claude's 5-hour or Codex's weekly limit. */
export interface LimitWindow {
  id: string;
  label: string;
  /** 0-100, or null when the agent only said the window exists. */
  usedPercent: number | null;
  /** Epoch ms. */
  resetsAt: number | null;
}

/**
 * An agent's subscription rate limits, as the agent last reported them. Most
 * arrive with its normal responses (Claude's rate-limit events, Codex's
 * rate-limit notifications); the limits refresher also asks the agent
 * directly when a snapshot is stale, so they survive restarts and idle time.
 */
export interface AgentLimits {
  agent: string;
  windows: LimitWindow[];
  /** "warning": close to a limit. "limited": a limit was hit. */
  state: "ok" | "warning" | "limited";
  plan: string | null;
  updatedAt: number;
}

export interface AppUpdateStatus {
  current: string;
  /** A downloaded version waiting for a restart. */
  ready: string | null;
  /** False in dev builds and packages that can't update themselves. */
  supported: boolean;
}

/** Settings as the renderer sees them: API keys only as set / not set. */
export interface SettingsView extends Settings {
  providers: ProviderView[];
  /** Stored per-agent credential choices only; an absent agent defaults to subscription. */
  providerCredential: Record<string, CredentialChoice>;
  /** Provider ids synthesized by the v2 migration, for the upgrade banner. */
  migratedProviders: string[];
  /** False where the OS offers no keychain, so keys are stored obfuscated rather than encrypted. */
  secretsEncrypted: boolean;
}

export interface Thread {
  id: string;
  projectId: string;
  /** Which agent runs this thread: "claude", or an ACP agent's id. */
  agent: string;
  title: string;
  /**
   * Read-only: the current agent's resume cursor, `bindings[bindingKey(agent)]`,
   * or the pre-bindings session id. Kept for one release so a rollback still resumes.
   */
  sessionId: string | null;
  /** Every agent session this thread has used, by `bindingKey()`. Switching agents keeps them all. */
  bindings: Record<string, SessionBinding>;
  model: string;
  /** Reasoning effort for the current model; null = the model's own default. */
  effort: string | null;
  permissionMode: PermissionMode;
  createdAt: number;
  updatedAt: number;
  /** Pinned to the top of its project in the sidebar. */
  pinned?: boolean;
  /** Out of the sidebar's lists (in an Archived group), kept with its history. */
  archived?: boolean;
  /** The branch of the thread's own worktree; null when it runs in the project folder. */
  branch?: string | null;
  /** Where the thread's tools run when it has its own worktree. */
  worktreePath?: string | null;
}

/**
 * One agent session a thread has used. The event log is the canonical
 * history; a cursor is the agent's own and may be lost at any time.
 */
export interface SessionBinding {
  agent: string;
  instanceId: string;
  /** The agent's own session id to resume, or null when it starts over. */
  resumeCursor: string | null;
  status: "active" | "stale" | "lost" | "rolled-back";
  /** Cursors are scoped by folder: Claude keeps transcripts per cwd. */
  cwd: string;
  configDir?: string;
  lastSeenAt: number;
  /** The thread's newest event when the cursor was last written. */
  lastSeq: number;
  /** Driver-private state (model, effort, MCP roots). */
  runtime?: unknown;
}

/** A thread exported to JSON: the only way back from the bindings migration. */
export interface ThreadExport {
  schemaVersion: number;
  exportedAt: number;
  thread: Thread;
  events: StoredEvent[];
  /** Offloaded tool payloads by sha256, inlined so an import elsewhere has no dangling refs. */
  blobs: Record<string, string>;
}

/** The repository's head, branch, and changed paths at the moment a checkpoint was built. */
export interface GitState {
  head: string | null;
  branch: string | null;
  dirty: string[];
}

/** A structured handoff built from a thread's stored events; thread state only. */
export interface HandoffCheckpoint {
  threadId: string;
  /** Provenance of the newest event that has any. */
  from: { agent: string; model: string } | null;
  builtAt: number;
  lastSeq: number;
  /** The first user event's text, or "". */
  goal: string;
  /** Every user and assistant-text event, in order, each cut to 2000 chars. */
  messages: { role: "user" | "assistant"; text: string }[];
  files: { path: string; status: string; additions: number; deletions: number }[];
  commands: { toolUseId: string; name: string; summary: string; isError: boolean; exitCode: number | null; output: string; artifact: string | null }[];
  /** The last assistant-text, when its trimmed text ends with "?". */
  openQuestions: string[];
  git: GitState | null;
}

/**
 * How a thread moves to another agent: hand off the thread state, start the
 * agent fresh, or go back to the session it already has.
 */
export type SwitchMode = "handoff" | "fresh" | "back";

export type SwitchResult =
  | {
      ok: true;
      mode: SwitchMode;
      thread: Thread;
      /** What the new session received, for a handoff. */
      seeded?: { channel: "inject-items" | "first-message"; sent: number; tokens: number; tier: number; estimated: boolean };
      /** The git ref to return to, or null when there was no repository to checkpoint. */
      gitRef?: string | null;
      /** The switch happened but the handoff didn't reach the new session. */
      warning?: string;
    }
  | { ok: false; reason: string };

/** Who produced an event: the agent, its model, and how it was reached. */
export interface Provenance {
  agent: string;
  model: string;
  provider: string | null;
  instanceId: string | null;
}

/** Whether the numbers came from the vendor, were estimated, or weren't reported. */
export type UsageProvenance = "reported" | "estimated" | "unavailable";

/** Why a turn missed the prompt cache (Phase 5 classifies it). */
export type MissCause =
  | "tool-definitions"
  | "system-prompt"
  | "model"
  | "compaction"
  | "ttl-expiry"
  | "session-rebuild"
  | "unknown";

/** One turn's token usage. `inputTokens` is uncached (net-new) tokens only. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  cacheTtl: "5m" | "1h" | "30m" | "unknown" | null;
  hitRate: number | null;
  miss: boolean;
  missCause?: MissCause;
  provenance: UsageProvenance;
  /** Tokens currently in the model's context: the latest request's input, cached tokens included. */
  contextUsed?: number | null;
  /** The model's context window, when the agent reports one. */
  contextSize?: number | null;
}

/** One entry of a plan the agent is working through. */
export interface PlanEntry {
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority?: "high" | "medium" | "low";
}

/** Stable semantic ids shared by every event, so a handoff can replay exactly. */
export interface EventIds {
  messageId?: string;
  turnId?: string;
  itemId?: string;
  parentId?: string;
}

/**
 * The terminal, persisted union: what a thread shows, normalized across agents.
 * Stored in order, one row each. Live-only kinds live in `LiveDelta` and are
 * never persisted.
 */
export type ThreadEvent = (
  | { kind: "user"; text: string; skill?: string }
  | { kind: "assistant-text"; text: string }
  | { kind: "thinking"; text: string; signature?: string; opaque?: boolean }
  | { kind: "tool-use"; toolUseId: string; name: string; summary: string; payload?: unknown }
  | { kind: "tool-result"; toolUseId: string; isError: boolean; summary: string; payload?: unknown }
  | { kind: "turn-end"; costUsd: number | null; inputTokens: number; outputTokens: number; durationMs: number; usage?: Usage }
  /** One-line-per-category token breakdown of a brand-new session's first turn. */
  | { kind: "context-breakdown"; rows: { label: string; tokens: number }[]; total: number | null; estimated: boolean }
  | { kind: "error"; message: string }
  | { kind: "notice"; text: string }
  | { kind: "turn-start"; turnId: string; agent: string; model: string }
  | { kind: "plan"; entries: PlanEntry[] }
  /** The agent presented a plan and waits for the user's decision. */
  | { kind: "plan-proposal"; text: string }
  /** The user's answer to a plan proposal, kept in history. */
  | { kind: "plan-decision"; choice: "auto" | "manual" | "keep"; feedback?: string }
  | { kind: "compaction"; trigger: "manual" | "auto" | "unknown"; preTokens: number | null; postTokens: number | null }
  | { kind: "handoff"; phase: "seeded" | "reply" | "signal"; text: string; from?: string; to?: string; tokens?: number; tier?: number }
) &
  EventIds;

/**
 * Live-only kinds pushed while a turn runs. Never persisted: `appendEvent`
 * only accepts `ThreadEvent`, so this is a compile-time guarantee.
 */
export type LiveDelta =
  | { kind: "text-delta"; itemId: string; text: string }
  | { kind: "reasoning-delta"; itemId: string; text: string; opaque?: boolean }
  | { kind: "reasoning-summary"; itemId: string; index: number; text: string }
  | { kind: "tool-input-delta"; toolUseId: string; text: string }
  | { kind: "tool-output-delta"; toolUseId: string; text: string }
  | { kind: "plan-delta"; entries: PlanEntry[] }
  | {
      kind: "usage-update";
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number | null;
      cacheWriteTokens?: number | null;
      reasoningTokens?: number | null;
      costUsd?: number | null;
      contextUsed?: number;
      contextSize?: number;
    }
  | { kind: "thinking-progress"; estimatedTokens: number };

export interface StoredEvent {
  seq: number;
  event: ThreadEvent;
  createdAt: number;
  provenance?: Provenance | null;
}

/** A tool call waiting on the user in "ask" mode. */
export interface PermissionRequest {
  requestId: string;
  threadId: string;
  toolName: string;
  summary: string;
  canAlwaysAllow: boolean;
}

export type PermissionDecision = "allow-once" | "allow-always" | "deny";

/** The user's answer to a plan proposal: accept automatically, accept by hand, or keep planning with feedback. */
export type PlanDecision = "auto" | "manual" | { keep: string };

/** A plan waiting on the user in "plan" mode. */
export interface PlanRequest {
  requestId: string;
  threadId: string;
  plan: string;
}

export interface DiffLine {
  kind: "context" | "add" | "del";
  text: string;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed" | "untracked";
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

export interface ModelOption {
  id: string;
  label: string;
  /** Reasoning effort levels the model supports, in the agent's own order. */
  efforts?: string[];
  /** The model's default effort, when the agent reports one. */
  defaultEffort?: string;
}

export type GuardEnforcement = "block" | "warnOnly";

/** How an agent's model-invoked skills reach it, and the prefix its Skill-tool names carry. */
export interface SkillsDelivery {
  mode: "plugin" | "extraRoots" | "envDir" | "tool" | "none";
  prefix?: string;
  /** Origins the agent already loads natively, so the harness doesn't deliver them again. */
  reads?: SkillOrigin[];
}

/**
 * What a driver's agent can actually do here. Code branches on these instead
 * of on agent ids, so a new agent only has to declare itself.
 */
export interface AgentCapabilities {
  mcpStdio: boolean;
  mcpHttp: boolean;
  preToolGuard: boolean;
  resume: boolean;
  fork: boolean;
  revert: boolean;
  compaction: boolean;
  perMessageModel: boolean;
  vision: boolean;
  webSearch: boolean;
  planMode: "native" | "emulated";
  interrupt: boolean;
  /** Reasoning arrives as it's produced; when false the UI says it shows up at the end. */
  liveReasoning?: boolean;
  /** How a new session gets the handoff: injected history items, one synthetic first message, or not at all. */
  seeding?: "inject-items" | "first-message" | "none";
  /** A native no-reply prompt channel (OpenCode's session.prompt noReply). No driver has one yet. */
  seedNoReply?: boolean;
  skillsDelivery: SkillsDelivery;
  permissionGranularity: "perTool" | "perCommand" | "modeOnly";
  /** Per permission mode: whether the git guardrail can veto a command before it runs. */
  guardEnforcement: Record<PermissionMode, GuardEnforcement>;
  sandbox: "none" | "workspace" | "full";
  /** The agent keeps the shared memory itself (reads and writes it natively), so the harness never extracts for it. */
  nativeMemory?: boolean;
}

/** How an agent's credential row behaves in Settings: data from its driver, never its id. */
export interface AgentCredentials {
  /** Providers from the list can drive it; false hides the row until its injector is verified. */
  byok: boolean;
  /** What "no provider" means: the agent's own sign-in, or its own config. */
  own: "login" | "config";
  /** Whose provider rules apply: Claude's base-URL warning, Codex's Responses-only check. */
  injector: "claude" | "codex" | "opencode" | "acp";
}

export interface AgentInfo {
  id: string;
  label: string;
  models: ModelOption[];
  defaultModel: string;
  capabilities: AgentCapabilities;
  credentials?: AgentCredentials;
  /** Set for an agent the app reaches only unofficially: shown as "Unsupported · <this>". */
  unsupported?: string;
  /** Which CLI copy this agent actually runs, and the others found; drivers that don't know omit it. */
  binary?: { path: string; version: string; others: { path: string; version: string }[] };
}

export interface SendRequest {
  threadId: string;
  text: string;
  /** A user-invoked skill picked from the / menu. */
  skill?: string;
  /** Project-relative files and folders the user @-mentioned. */
  mentions?: string[];
}

/** A viewport the browser pane can emulate; desktop means no emulation. */
export type DevicePreset = "mobile" | "tablet" | "desktop";

/** One console, exception, or failed-request line from the browser pane. */
export interface BrowserLogEntry {
  level: "error" | "warning" | "network";
  text: string;
}

export interface ScreenshotInfo {
  path: string;
  /** An unskilled-shot:// URL the renderer can load. */
  url: string;
}

/** The browser pane's in-band state, fetched once when the renderer mounts it. */
export interface BrowserState {
  device: DevicePreset;
  logs: BrowserLogEntry[];
  screenshots: ScreenshotInfo[];
}

/** Pushed from main to renderer while a turn runs. */
export type LiveUpdate =
  | { type: "event"; threadId: string; stored: StoredEvent }
  | { type: "delta"; threadId: string; delta: LiveDelta }
  | { type: "running"; threadId: string; running: boolean }
  | { type: "permission"; request: PermissionRequest }
  | { type: "plan-approval"; request: PlanRequest }
  | { type: "plan-approval-done"; requestId: string }
  | { type: "thread"; thread: Thread }
  /** The agent needs the browser pane: show it, optionally at a URL. */
  | { type: "browser-open"; url?: string }
  /** The user picked an element in the browser pane (null: cancelled). */
  | { type: "browser-picked"; text: string | null }
  /** A new console line, or null when a page load cleared the log. */
  | { type: "browser-log"; entry: BrowserLogEntry | null }
  /** A screenshot was saved, with a URL the renderer can load. */
  | { type: "browser-screenshot"; shot: ScreenshotInfo }
  /** The emulated viewport changed. */
  | { type: "browser-device"; device: DevicePreset }
  /** The agent acted in the browser pane; the UI shows who is driving. */
  | { type: "browser-action"; action: "open" | "click" | "type" | "eval"; ref?: string; url: string }
  | { type: "terminal-data"; id: string; data: string }
  | { type: "terminal-exit"; id: string; code: number }
  | { type: "settings"; settings: SettingsView }
  | { type: "app-update"; status: AppUpdateStatus }
  | { type: "limits"; limits: AgentLimits }
  /** A driver finished loading its model list; refetch agents. */
  | { type: "agents" }
  /** The app menu asked for the About sheet. */
  | { type: "open-about" };

/** The API the preload script exposes as `window.unskilled`. */
export interface UnskilledApi {
  platform: string;
  /** The window has no vibrancy or Mica behind it (Linux, Windows 10): paint the sidebar opaque. */
  opaqueSidebar: boolean;
  /** Started with --smoke: the renderer exposes its smoke hooks. */
  smoke?: boolean;
  listProjects(): Promise<Project[]>;
  addProject(): Promise<Project | null>;
  deleteProject(projectId: string): Promise<void>;
  listThreads(projectId: string): Promise<Thread[]>;
  createThread(projectId: string, agent?: string, opts?: { worktree?: boolean }): Promise<Thread>;
  updateThread(threadId: string, patch: Partial<Pick<Thread, "title" | "model" | "effort" | "permissionMode" | "agent" | "pinned" | "archived">>): Promise<Thread>;
  deleteThread(threadId: string): Promise<void>;
  /** Move a thread to another agent; a refused switch changes nothing. */
  switchAgent(threadId: string, agent: string, mode: SwitchMode): Promise<SwitchResult>;
  /** Save a thread to a JSON file; null when the dialog was cancelled. */
  exportThread(threadId: string): Promise<string | null>;
  /** Restore a thread from a JSON file as a new thread; null when cancelled. */
  importThread(projectId: string): Promise<Thread | null>;
  /** Save providers, credential choices and preferences to a JSON file; null when cancelled. */
  exportSettings(): Promise<string | null>;
  /** Replace them from an export; null when cancelled. */
  importSettings(): Promise<SettingsView | null>;
  listEvents(threadId: string): Promise<StoredEvent[]>;
  listSkills(projectId?: string): Promise<SkillEntry[]>;
  listAgents(): Promise<AgentInfo[]>;
  send(request: SendRequest): Promise<void>;
  interrupt(threadId: string): Promise<void>;
  respondPermission(requestId: string, decision: PermissionDecision): Promise<void>;
  respondPlan(requestId: string, decision: PlanDecision): Promise<void>;
  /** The working-tree diff of the project, or of `threadId`'s worktree when it has one. */
  getDiff(projectId: string, threadId?: string | null): Promise<DiffFile[]>;
  /** The project's files (git-tracked plus untracked-not-ignored), for the Files tab. */
  listFiles(projectId: string, threadId?: string | null): Promise<{ files: string[]; truncated: boolean }>;
  /** The project's current branch; null on its default branch, detached, or outside git. */
  projectBranch(projectId: string): Promise<string | null>;
  /** The browser pane's <webview> is ready; main takes control of it. */
  browserAttached(webContentsId: number): Promise<void>;
  /** Start picking an element in the browser pane. */
  browserPick(): Promise<void>;
  /** Emulate a viewport in the browser pane. */
  browserDevice(preset: DevicePreset): Promise<void>;
  /** The browser pane's current device, logs, and screenshots. */
  browserState(): Promise<BrowserState>;
  /** The user grabbed the pane: pause (true) or resume (false) the agent's acting tools. */
  browserTakeOver(paused: boolean): Promise<void>;
  /** Open (or reattach to) the terminal with this id, in `cwd` (home when null). */
  terminalOpen(id: string, cwd: string | null, cols: number, rows: number): Promise<void>;
  terminalWrite(id: string, data: string): void;
  terminalResize(id: string, cols: number, rows: number): void;
  terminalClose(id: string): Promise<void>;
  getSettings(): Promise<SettingsView>;
  updateSettings(patch: Partial<Settings>): Promise<SettingsView>;
  listProviders(): Promise<ProviderView[]>;
  /** Create or replace a provider. The secret is write-only and never echoed back. */
  saveProvider(input: ProviderInput, secret?: string | null): Promise<ProviderView>;
  removeProvider(id: string): Promise<SettingsView>;
  /** Store a provider's key (encrypted), or remove it with null. Agents restart to pick it up. */
  setProviderSecret(id: string, value: string | null): Promise<SettingsView>;
  testProvider(id: string, modelId: string): Promise<ConnectionResult>;
  setCredential(agentId: string, choice: CredentialChoice): Promise<SettingsView>;
  /** Show the app's data folder (agents.json, the database) in the file manager. */
  openDataFolder(): Promise<void>;
  updateStatus(): Promise<AppUpdateStatus>;
  /** Version, runtime versions and the git build stamp for the About sheet. */
  aboutInfo(): Promise<AboutInfo>;
  /** The harness-side context a thread (or, with no thread, a new one in the project) starts with. */
  contextPreview(threadId: string | null, projectId: string | null): Promise<ContextPreview>;
  /** Rate limits reported so far, by agent. */
  listLimits(): Promise<AgentLimits[]>;
  /** Every skill discovered for the project (or globally): the whole list, shadowed and disabled included. */
  listAllSkills(projectId?: string): Promise<SkillEntry[]>;
  getSkillDetail(name: string, projectId?: string): Promise<SkillDetail>;
  /** Turn one skill on or off; returns the refreshed all-skills list. */
  setSkillEnabled(origin: SkillOrigin, name: string, enabled: boolean): Promise<SkillEntry[]>;
  /** The standard skill folders, for the Settings/Library UI. `project` and `projectClaude` are "" without one. */
  getSkillFolders(projectId?: string): Promise<{ project: string; projectClaude: string; harness: string; bundled: string }>;
  /** Create a skill stub under the harness or the project; returns the SKILL.md path. */
  createSkill(input: { scope: "harness" | "project"; projectId?: string | null; name: string; description: string }): Promise<string>;
  listAgentCatalog(): Promise<AgentCatalogEntry[]>;
  getMcp(projectId: string | null): Promise<McpOverview>;
  /** Add or replace a server. Env or header values left empty keep what was stored. */
  saveMcpServer(entry: McpServerEntry, previousName?: string, projectId?: string | null): Promise<McpOverview>;
  removeMcpServer(name: string, projectId?: string | null): Promise<McpOverview>;
  setMcpServerEnabled(name: string, enabled: boolean, projectId?: string | null): Promise<McpOverview>;
  testMcpServer(name: string, projectId?: string | null): Promise<McpTestResult>;
  /** Use (or stop using) a global server in one project. */
  setGlobalMcpOff(projectId: string, name: string, off: boolean): Promise<McpOverview>;
  revealPath(path: string): Promise<void>;
  /** Installed editors, in the picker's order. */
  listEditors(): Promise<EditorInfo[]>;
  /**
   * Open a file (at a line) or folder in an editor: the one given, else the
   * last one used, else the first found. A relative path is taken from the
   * project's folder.
   */
  openInEditor(target: { projectId: string | null; path: string; line?: number; column?: number }, editor?: string): Promise<OpenResult>;
  /** Quit and install the downloaded update. */
  installUpdate(): Promise<void>;
  onUpdate(listener: (update: LiveUpdate) => void): () => void;
}

/** What the About sheet shows: the app, its runtime, and the git build stamp. */
export interface AboutInfo {
  name: string;
  version: string;
  commit: string | null;
  commitDate: string | null;
  electron: string;
  chrome: string;
  node: string;
  os: string;
  changelog: { hash: string; date: string; subject: string }[];
}

/** What the harness itself adds to a fresh session's context, estimated at ~4 chars per token. */
export interface ContextPreview {
  guide: { source: "bundled" | "user" | "project"; path: string; tokens: number }[];
  tools: { name: string; tokens: number }[];
  mcpServers: string[];
  /** The shared memory index, once memory exists (null until then). */
  memoryIndex: { lines: number; tokens: number } | null;
}
