// The contract between the main process and the renderer. Everything that
// crosses the preload bridge is one of these types.

export type Invocation = "model" | "user";

/** One entry of skilled's skills.json (see HARNESS.md at the repo root). */
export interface SkillEntry {
  name: string;
  description: string;
  invocation: Invocation;
  argumentHint?: string;
  compatibility?: string;
  calls: string[];
  files: string[];
  sha256: string;
}

export interface Project {
  id: string;
  path: string;
  name: string;
  createdAt: number;
}

export type PermissionMode = "ask" | "auto-edit" | "full";

export type Theme = "system" | "light" | "dark";
export type SecretName = "anthropic" | "deepseek" | "openai";

export interface Settings {
  theme: Theme;
  /** The agent new threads start with; null = the first available (Claude). */
  defaultAgent: string | null;
  defaultPermissionMode: PermissionMode;
  /** Download new versions in the background and install them on quit. */
  autoUpdate: boolean;
  /** The editor "Open in editor" uses; null = the first one found. */
  editor: string | null;
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
  /** The app's own tools (the browser pane's), served to agents as the "unskilled" server. */
  builtIn: { name: string; active: boolean; tools: { name: string; description: string; autoAllow: boolean }[] };
  servers: McpServerView[];
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
  kind: "agent-sdk" | "app-server" | "acp";
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
 * An agent's subscription rate limits, as the agent last reported them. They
 * arrive with its normal responses (Claude's rate-limit events, Codex's
 * rate-limit notifications); the app never asks for them separately.
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
  secretsSet: Record<SecretName, boolean>;
  /** False where the OS offers no keychain, so keys are stored obfuscated rather than encrypted. */
  secretsEncrypted: boolean;
}

export interface Thread {
  id: string;
  projectId: string;
  /** Which agent runs this thread: "claude", or an ACP agent's id. */
  agent: string;
  title: string;
  /** The agent's own session id, used to resume the conversation. */
  sessionId: string | null;
  model: string;
  permissionMode: PermissionMode;
  createdAt: number;
  updatedAt: number;
}

/**
 * What a thread shows, normalized across agents. Stored in order, one row
 * each; `text-delta` is live-only and never stored.
 */
export type ThreadEvent =
  | { kind: "user"; text: string; skill?: string }
  | { kind: "assistant-text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool-use"; toolUseId: string; name: string; summary: string }
  | { kind: "tool-result"; toolUseId: string; isError: boolean; summary: string }
  | { kind: "turn-end"; costUsd: number | null; inputTokens: number; outputTokens: number; durationMs: number }
  | { kind: "error"; message: string }
  | { kind: "notice"; text: string };

export interface StoredEvent {
  seq: number;
  event: ThreadEvent;
  createdAt: number;
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
}

export interface AgentInfo {
  id: string;
  label: string;
  models: ModelOption[];
  defaultModel: string;
}

export interface SendRequest {
  threadId: string;
  text: string;
  /** A user-invoked skill picked from the / menu. */
  skill?: string;
}

/** Pushed from main to renderer while a turn runs. */
export type LiveUpdate =
  | { type: "event"; threadId: string; stored: StoredEvent }
  | { type: "text-delta"; threadId: string; text: string }
  | { type: "running"; threadId: string; running: boolean }
  | { type: "permission"; request: PermissionRequest }
  | { type: "thread"; thread: Thread }
  /** The agent needs the browser pane: show it, optionally at a URL. */
  | { type: "browser-open"; url?: string }
  /** The user picked an element in the browser pane (null: cancelled). */
  | { type: "browser-picked"; text: string | null }
  | { type: "terminal-data"; id: string; data: string }
  | { type: "terminal-exit"; id: string; code: number }
  | { type: "settings"; settings: SettingsView }
  | { type: "app-update"; status: AppUpdateStatus }
  | { type: "limits"; limits: AgentLimits }
  /** A driver finished loading its model list; refetch agents. */
  | { type: "agents" };

/** The API the preload script exposes as `window.unskilled`. */
export interface UnskilledApi {
  platform: string;
  listProjects(): Promise<Project[]>;
  addProject(): Promise<Project | null>;
  listThreads(projectId: string): Promise<Thread[]>;
  createThread(projectId: string, agent?: string): Promise<Thread>;
  updateThread(threadId: string, patch: Partial<Pick<Thread, "title" | "model" | "permissionMode" | "agent">>): Promise<Thread>;
  deleteThread(threadId: string): Promise<void>;
  listEvents(threadId: string): Promise<StoredEvent[]>;
  listSkills(): Promise<SkillEntry[]>;
  listAgents(): Promise<AgentInfo[]>;
  send(request: SendRequest): Promise<void>;
  interrupt(threadId: string): Promise<void>;
  respondPermission(requestId: string, decision: PermissionDecision): Promise<void>;
  getDiff(projectId: string): Promise<DiffFile[]>;
  /** The browser pane's <webview> is ready; main takes control of it. */
  browserAttached(webContentsId: number): Promise<void>;
  /** Start picking an element in the browser pane. */
  browserPick(): Promise<void>;
  /** Open (or reattach to) the terminal with this id, in `cwd` (home when null). */
  terminalOpen(id: string, cwd: string | null, cols: number, rows: number): Promise<void>;
  terminalWrite(id: string, data: string): void;
  terminalResize(id: string, cols: number, rows: number): void;
  terminalClose(id: string): Promise<void>;
  getSettings(): Promise<SettingsView>;
  updateSettings(patch: Partial<Settings>): Promise<SettingsView>;
  /** Store an API key (encrypted), or remove it with null. Agents restart to pick it up. */
  setSecret(name: SecretName, value: string | null): Promise<SettingsView>;
  /** Show the app's data folder (agents.json, the database) in the file manager. */
  openDataFolder(): Promise<void>;
  updateStatus(): Promise<AppUpdateStatus>;
  /** Rate limits reported so far, by agent. */
  listLimits(): Promise<AgentLimits[]>;
  /** Every skill in the catalog, both halves. */
  listAllSkills(): Promise<SkillEntry[]>;
  getSkillDetail(name: string): Promise<SkillDetail>;
  listAgentCatalog(): Promise<AgentCatalogEntry[]>;
  getMcp(projectId: string | null): Promise<McpOverview>;
  /** Add or replace a server. Env or header values left empty keep what was stored. */
  saveMcpServer(entry: McpServerEntry, previousName?: string): Promise<McpOverview>;
  removeMcpServer(name: string): Promise<McpOverview>;
  setMcpServerEnabled(name: string, enabled: boolean): Promise<McpOverview>;
  testMcpServer(name: string): Promise<McpTestResult>;
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
