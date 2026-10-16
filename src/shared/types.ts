// The contract between the main process and the renderer. Everything that
// crosses the preload bridge is one of these types.

import type { PrototypeTier } from "./tiers";
import type { ExpertDef, ExpertImportResult } from "./experts";
import type { CommentTarget, DesignComment } from "./comments";
import type { LearnCase, LearnOverview, LearnSettings, Lesson, TurnScore } from "./learn";

export type Invocation = "model" | "user";

/** Where a skill was found: the standard folders, or the legacy skills.json root. */
/**
 * "projectCubiq" is the project's .cubiq/skills, which no agent reads natively; "project" is .agents/skills;
 * "projectClaude" is .claude/skills, read natively only by Claude. All three are listed as Project.
 */
/** `expert`: an imported expert's own skills, in that expert's threads only. */
export type SkillOrigin = "projectCubiq" | "project" | "projectClaude" | "expert" | "harness" | "shared" | "bundled" | "legacy";

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
  /** "design" = delivered to design threads only (frontmatter `mode: design`). */
  mode?: "design";
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
  /** Run after a turn that changed files; null/absent = off. */
  checkCommand?: string | null;
  /** How many automatic fix turns a failed check may send (0-2); null/absent = 1. 0 = show the result, spend no tokens. */
  checkFixRounds?: number | null;
  /** The folder no longer exists (computed when listed, not stored). */
  missing?: boolean;
}

export type PermissionMode = "ask" | "auto-edit" | "plan" | "full";

export type Theme = "system" | "light" | "dark";
/** How much the UI animates. `prefers-reduced-motion: reduce` always wins and means instant. */
export type Motion = "instant" | "subtle" | "full";
/** The live-wallpaper clip played at launch, or none. */
export type Splash = "agent" | "voyage" | "off";
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
  cost?: ModelPricing; // from the provider's listing or models.dev, when known
}

/** USD per 1M tokens; cache reads cost `cacheRead` when the provider says, else the input price. */
export interface ModelPricing {
  input: number;
  output: number;
  cacheRead?: number;
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
  /** Anthropic Messages only: how the key is sent. auto = X-Api-Key on api.anthropic.com, Bearer elsewhere. */
  authStyle?: "auto" | "bearer" | "x-api-key";
  /** A cheap model (one of `models` by id) for background work: Claude's small/fast slot, OpenCode's small_model. */
  smallModel?: string;
  /** Header name → safeStorage ciphertext; only main reads it. Plain `headers` may say `${env:VAR}` instead. */
  secretHeaders?: Record<string, string>;
}

/** A Provider as the renderer sees it; never carries key material. */
export type ProviderView = Omit<Provider, "secret" | "secretHeaders"> & { secretKind: ProviderSecret["kind"]; hasSecret: boolean; secretHeaderNames?: string[] };

/**
 * A Provider as the renderer sends it: the secret is a descriptor, never a value.
 * `secretHeaderNames` lists the encrypted headers to keep; new values travel separately, once.
 */
export type ProviderInput = Omit<Provider, "secret" | "secretHeaders"> & { secret?: Omit<ProviderSecret, "ciphertext">; secretHeaderNames?: string[] };

/** The result of probing a provider: reachability, model listing, and tool-calling parity. */
export interface ConnectionResult {
  reachable: boolean;
  listsModels: boolean | null;
  supportsTools: boolean | null;
  triage?: string;
}

/** A model a provider's own listing returned, enriched from models.dev where it knows the id. */
export interface DiscoveredModel extends ProviderModel {
  enriched: boolean; // true when models.dev (or the listing itself) supplied limits/capabilities
}

/** Fetch models: the listing, plus the cheapest tool model as the suggested small model. */
export type ModelDiscovery = { ok: true; models: DiscoveredModel[]; smallModel?: string } | { ok: false; error: string };

/** A models.dev provider the "Add provider" editor can start from; untested by CubiQ. */
export interface CatalogProvider {
  id: string; // a valid provider id derived from the models.dev key
  name: string;
  wireProtocol: WireProtocol;
  baseURL: string;
  keyVar?: string; // first `env` entry
  docs?: string;
  models: DiscoveredModel[];
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
  /** The user dragged the side panel past the chat's normal width: it may keep up to 80%, the chat down to its floor. */
  inspectorWide: boolean;
  /** A design thread's chat width the user dragged to; null = automatic (45% of the room, 260–420px). */
  designChat: number | null;
}

export interface Settings {
  theme: Theme;
  /** Panel and thread-switch animation; SettingsStore.get() always fills it in (default full). */
  motion?: Motion;
  /** Thread, tool and turn-meta row spacing; SettingsStore.get() always fills it in (default comfortable). */
  density?: Density;
  /** Whole-app zoom, one of ZOOM_STEPS (shared/zoom.ts); SettingsStore.get() always fills it in (default 1). */
  zoom?: number;
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
  /** Panel sizes and which panels are collapsed; SettingsStore.get() always fills it in. */
  paneLayout?: PaneLayout;
  /** Skills the user turned off, as `${origin}:${name}`. */
  skills?: { disabled: string[] };
  /** Shared CubiQ memory: on unless turned off; projects listed here are off. SettingsStore.get() always fills it in. */
  memory?: { enabled: boolean; disabledProjects: string[] };
  /** MCP tool search for agents without their own: "auto" routes when 20+ tools are enabled (default), "off" never. */
  mcpRouter?: "auto" | "off";
  /** Sidebar Recent section grouped by project (true, the default when unset) or one flat list (false). */
  sidebarGroupByProject?: boolean;
  /** Tell agents they may answer with inline UI blocks (checklist, calculator, …). Off unless set: it costs guide tokens. */
  uiBlocks?: boolean;
  /** The launch splash clip; unset means "agent". */
  splash?: Splash;
  /** Self-improve (scorecard, lessons, verified promotion): off unless a project is listed. SettingsStore.get() always fills it in. */
  learn?: LearnSettings;
}

export type MemoryType = "user" | "feedback" | "project" | "reference";

/** One note in a project's shared memory, without its body. */
export interface MemoryNote {
  file: string;
  name: string;
  description: string;
  type: MemoryType;
  /** When the note was last written, "YYYY-MM-DD"; absent on older notes. */
  updated?: string;
}

/** Where a note lives: the project's own notes, or the global notes about the user shared by every project. */
export type MemoryScope = "project" | "global";

/** The Library's view of one project's memory. */
export interface MemoryOverview {
  enabled: boolean;
  projectOn: boolean;
  dir: string;
  index: { lines: number; tokens: number };
  notes: MemoryNote[];
  /** Notes about the user that every project shares. */
  global: MemoryNote[];
  /** What agents see at the start of a session: notes listed out of all (global + project), and its estimated tokens. */
  block: { shown: number; total: number; tokens: number };
}

export interface EditorInfo {
  id: string;
  label: string;
}

export type OpenResult = { ok: true; editor: string } | { ok: false; error: string };

/** How to start an MCP server: a local command, or a URL (Streamable HTTP, or the older SSE transport). */
export type McpServerSpec =
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { type: "http"; url: string; headers?: Record<string, string>; oauth?: McpOAuthConfig }
  | { type: "sse"; url: string; headers?: Record<string, string>; oauth?: McpOAuthConfig };

/** A remote server's OAuth settings. Empty = discover everything and register dynamically. */
export interface McpOAuthConfig {
  /** A client the user registered with the server themselves; its secret, if any, lives in the vault. */
  clientId?: string;
  /** Space-separated scopes to ask for instead of the server's own list. */
  scopes?: string;
  /** Fixed loopback port for the sign-in callback (a pre-registered client needs a stable redirect URI). */
  callbackPort?: number;
}

/** One server read out of pasted text (a URL, a command line or JSON config), ready to review and save. */
export interface McpDraft {
  name: string;
  spec: McpServerSpec;
}

/** What a remote MCP URL turned out to be when the app knocked on it. */
export interface McpProbeResult {
  ok: boolean;
  /** Which transport answered. */
  transport?: "http" | "sse";
  /** "oauth": it wants a sign-in (it publishes OAuth metadata); "token": it wants a key but publishes no OAuth; "none": it answered. */
  auth: "none" | "oauth" | "token";
  /** The server's own name from its initialize answer, when it gave one. */
  serverName?: string;
  /** The protected-resource metadata URL from the 401 challenge, when there was one. */
  resourceMetadata?: string;
  error?: string;
}

/** An MCP server the app passes to every agent (mcp.json in the data folder). */
export interface McpServerEntry {
  name: string;
  spec: McpServerSpec;
  enabled: boolean;
  /** Some of its secret values are in the vault but can't be opened on this machine; enter them again. */
  locked?: boolean;
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
  /** Its stored secrets can't be decrypted here (another machine or a reset keychain): enter them again. */
  locked?: boolean;
  /** The URL's transport ("http" or "sse") is in `type`; its OAuth settings, when it has any. */
  oauth?: McpOAuthConfig;
  /** For the edit form: the command's arguments (stdio). */
  args?: string[];
  /** For the edit form: env/header values that aren't secret (${VAR} references); secret keys are absent and show as set. */
  publicValues?: Record<string, string>;
  /** A client secret for the user's own OAuth client is stored. */
  hasClientSecret?: boolean;
}

/** One server's live state, for the Connectors list and the /mcp sheet. */
export interface McpServerStatus {
  name: string;
  /** checking: being listed now; needs-auth: sign in (Connect) first; failed: see error. */
  state: "connected" | "needs-auth" | "failed" | "disabled" | "checking";
  tools: { name: string; description: string }[];
  error?: string;
  /** Sign-in state for a URL server. */
  auth?: { signedIn: boolean; expiresAt?: number; scopes?: string; needsScopes?: string };
}

/** A server an agent loads from its own config, shown read-only. */
export interface ExternalMcpServer {
  name: string;
  type: "stdio" | "http" | "sse" | "unknown";
  target: string;
  /** Which agent loads it, and from where. */
  agent: string;
  source: string;
  /** The app can copy it into its own list (its values are read in the main process, never shown). */
  importable?: boolean;
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

export type ThreadKind = "chat" | "design";

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
  /** Context-window override in tokens; null/absent = the model's default. Codex only. */
  contextWindow?: number | null;
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
  /** "design" threads open with the design canvas; absent = "chat" (older rows and exports). */
  kind?: ThreadKind;
  /** A design thread's design system id (see DesignSystemOption); absent = the default. */
  designSystem?: string;
  /** A design thread's prototype tier; absent = working (and always absent on chat threads). */
  prototypeTier?: PrototypeTier;
  /** The expert this thread was summoned with (ExpertDef id); absent = none. */
  expertId?: string;
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
  | { kind: "user"; text: string; /** Older events: one skill. */ skill?: string; /** The skills the user picked, in order. */ skills?: string[] }
  | { kind: "assistant-text"; text: string }
  | { kind: "thinking"; text: string; signature?: string; opaque?: boolean }
  | { kind: "tool-use"; toolUseId: string; name: string; summary: string; payload?: unknown }
  | { kind: "tool-result"; toolUseId: string; isError: boolean; summary: string; payload?: unknown }
  | {
      kind: "turn-end";
      costUsd: number | null;
      inputTokens: number;
      outputTokens: number;
      durationMs: number;
      usage?: Usage;
      /** Model calls this turn made; only agents that run the loop themselves (the native agent) report it. */
      steps?: number;
      /** Tool outputs cleared from history this turn to fit the context (native agent). */
      pruned?: number;
    }
  /** One-line-per-category token breakdown of a brand-new session's first turn. */
  | { kind: "context-breakdown"; rows: { label: string; tokens: number }[]; total: number | null; estimated: boolean }
  | { kind: "error"; message: string }
  | { kind: "notice"; text: string; /** The evidence gate's flags, when this notice is one. */ evidence?: string[] }
  | { kind: "turn-start"; turnId: string; agent: string; model: string }
  | { kind: "plan"; entries: PlanEntry[] }
  /** The agent presented a plan and waits for the user's decision. */
  | { kind: "plan-proposal"; text: string }
  /** The user's answer to a plan proposal, kept in history. */
  | { kind: "plan-decision"; choice: "auto" | "manual" | "keep"; feedback?: string }
  /** The agent asked the user questions; what they answered (secret answers masked), or skipped. */
  | { kind: "questions"; items: { header: string; question: string; answer: string[]; note?: string }[]; skipped: boolean }
  | { kind: "compaction"; trigger: "manual" | "auto" | "unknown"; preTokens: number | null; postTokens: number | null }
  | { kind: "handoff"; phase: "seeded" | "reply" | "signal"; text: string; from?: string; to?: string; tokens?: number; tier?: number }
  /** The project's check command after a turn that changed files; ok null = still running. */
  | { kind: "check"; command: string; ok: boolean | null; exitCode: number | null; timedOut: boolean; durationMs: number; tail: string; round: number }
) &
  EventIds;

/**
 * Live-only kinds pushed while a turn runs. Never persisted: `appendEvent`
 * only accepts `ThreadEvent`, so this is a compile-time guarantee.
 */
export type LiveDelta =
  /** `parentId` (here and on reasoning/tool output) = the Agent call a subagent's delta belongs to. */
  | { kind: "text-delta"; itemId: string; text: string; parentId?: string }
  | { kind: "reasoning-delta"; itemId: string; text: string; opaque?: boolean; parentId?: string }
  | { kind: "reasoning-summary"; itemId: string; index: number; text: string }
  | { kind: "tool-input-delta"; toolUseId: string; text: string }
  | { kind: "tool-output-delta"; toolUseId: string; text: string; parentId?: string }
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

/** One choice of an agent's question; `preview` is markdown (a mockup or snippet). */
export interface QuestionOption {
  label: string;
  description: string;
  preview?: string;
}

/** One question an agent asks the user; no options means a free-text answer. */
export interface Question {
  /** Stable within the request; the driver maps answers back by it. */
  id: string;
  /** A short chip label (Claude caps it at 12 chars). */
  header: string;
  question: string;
  options: QuestionOption[];
  multiSelect: boolean;
  /** Offer an "Other…" free-text answer besides the options. */
  allowOther: boolean;
  /** The answer is a secret: never stored or shown in history. */
  secret?: boolean;
}

/** An agent's questions waiting on the user. */
export interface QuestionRequest {
  requestId: string;
  threadId: string;
  questions: Question[];
  /** The agent didn't wait (Codex's request_user_input_async): the card outlives the turn, and the answer goes back as a message. */
  async?: boolean;
}

/** What is live in the main process, for a window that (re)loads mid-turn. */
export interface PendingState {
  running: string[];
  permissions: PermissionRequest[];
  plans: PlanRequest[];
  questions: QuestionRequest[];
}

/** The user's answers by question id (option labels, or their own text), with optional notes per question, or "dismiss" when they skipped. */
export type QuestionAnswer = { answers: Record<string, string[]>; notes?: Record<string, string> } | "dismiss";

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

/** ⌘K search: what to look for, optionally within one project or agent's threads. */
export interface SearchQuery {
  text: string;
  projectId?: string | null;
  agent?: string | null;
  limit?: number;
}

/** One search hit. `snippet` marks matched terms between \u0001 and \u0002 (never HTML). */
export interface SearchHit {
  threadId: string;
  projectId: string;
  title: string;
  agent: string;
  /** The event's seq for a message hit; null for a title hit. */
  seq: number | null;
  kind: "title" | "user" | "assistant-text";
  snippet: string;
  updatedAt: number;
}

/** Threads whose title matched, then message hits, each best match first. */
export interface SearchResults {
  threads: SearchHit[];
  messages: SearchHit[];
}

/** One worksheet, its rows as strings, and whether the row cap cut it short. */
export type SheetPreview = { name: string; rows: string[][]; totalRows: number; truncated: boolean };

/** One slide, its title and text runs, and embedded images as data: URIs. */
export type SlidePreview = { index: number; title: string; texts: string[]; images: string[] };

/** Everything the preview worker hands back for a supported office file. */
export type OfficePreview =
  | { kind: "docx"; html: string; warnings: string[] }
  | { kind: "sheet"; sheets: SheetPreview[] }
  | { kind: "pptx"; slides: SlidePreview[] };

/** How the artifact panel shows a file. */
export type ArtifactKind = "md" | "html" | "svg" | "pdf" | "image" | "csv" | "docx" | "sheet" | "pptx" | "code" | "text";

/** One saved version of a file an agent wrote: a new one only when the content changed. */
export interface ArtifactVersion {
  version: number;
  sha256: string;
  bytes: number;
  createdAt: number;
  /** The seq of the turn-end that recorded it. */
  turnSeq: number;
}

/** A file an agent wrote in a thread, relative to the thread's folder (forward slashes), newest version last. */
/** A design system a design thread can use, for the composer's picker. */
export interface DesignSystemOption {
  /** "project" (the repo's DESIGN.md), "project:<folder>" (.agents/design-systems), or a built-in's folder name. */
  id: string;
  name: string;
  description: string;
  /** Up to 4 CSS colors to preview it. */
  swatches: string[];
  source: "project" | "projectFolder" | "builtin";
}

/** One custom property in a design system's tokens.css: its light (`:root`) value and its dark override, if any. */
export interface DesignToken {
  /** "--color-bg". */
  name: string;
  light: string;
  /** The value under `@media (prefers-color-scheme: dark) { :root { … } }`; null when the token has none. */
  dark: string | null;
}

/** The tokens under one group comment in tokens.css ("Color (light)" → "Color"); "Other" before any comment. */
export interface DesignTokenGroup {
  title: string;
  tokens: DesignToken[];
}

/** A design thread's system, read for the canvas's System tab. */
export interface DesignSystemDoc {
  id: string;
  name: string;
  source: DesignSystemOption["source"];
  /** False when an edit has nowhere to go (a built-in on a thread without a project folder). */
  editable: boolean;
  /** True when the first edit copies it into the project's `.agents/design-systems/<id>-custom/` (a built-in). */
  copyOnWrite: boolean;
  designMd: string;
  /** Empty when it has no tokens.css (a project's own DESIGN.md). */
  groups: DesignTokenGroup[];
}

/** One edit from the System tab: a token value for one scheme, or the whole DESIGN.md. */
export type DesignSystemEdit = { token: { name: string; scheme: "light" | "dark"; value: string } } | { designMd: string };

/** The frame a page declares it is drawn in (`<meta name="cubiq-device">`, or a one-screen mobile page's bars). */
export type DesignDevice = "mobile" | "tablet" | "desktop" | "slide";

/** What a design page exports as (canvas toolbar › Export). */
export type DesignExportFormat = "html" | "png" | "pdf";

export interface DesignEntry {
  /** The design folder, relative to the thread's working folder ("designs/<id8>"). */
  dir: string;
  /** The page shown, relative to the design folder ("index.html"). */
  rel: string;
  /** Its `cubiq-design:` URL (the latest file; add `?v=N` for a stored version). */
  url: string;
  /** Every page in the design folder (index first, then pages, then `variant-*.html`), with their URLs. */
  pages: { rel: string; url: string; device?: DesignDevice }[];
  /** Page-to-page links (relative <a href> / data-goto between pages), for the board's flow arrows and Present. */
  links?: { from: string; to: string }[];
  /** Whether the design has a developer handoff (`handoff.md`) beside its pages. */
  handoff: boolean;
}

export interface ArtifactFile {
  path: string;
  kind: ArtifactKind;
  versions: ArtifactVersion[];
}

/**
 * A file's content for the panel. Text kinds carry `text`; pdf and image carry a
 * `cubiq-file:` `url`; office kinds (docx, sheet, pptx, csv) carry `office`. An html page whose
 * relative stylesheets were inlined for the preview also carries that `doc` (Source still shows `text`).
 */
export type ArtifactContent =
  | { ok: true; path: string; kind: ArtifactKind; bytes: number; version: number | null; text?: string; doc?: string; truncated?: boolean; url?: string; office?: OfficePreview }
  | { ok: false; error: string };

export interface ModelOption {
  id: string;
  label: string;
  /** Reasoning effort levels the model supports, in the agent's own order. */
  efforts?: string[];
  /** The model's default effort, when the agent reports one. */
  defaultEffort?: string;
  /** Default context window in tokens, when the agent reports one. */
  contextWindow?: number;
  /** Largest window the model accepts as an override. */
  maxContextWindow?: number;
  /** A provider model's price (USD per 1M tokens), when known; subscription models have none. */
  cost?: ModelPricing;
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
  /** The app may route this agent's MCP servers through its own search_tools/call_mcp_tool when many tools are enabled (agents without native tool search). */
  mcpRouter?: boolean;
  /** The user can compact the session on request (/compact). ACP agents also need to advertise a compact command. */
  manualCompact?: boolean;
  /** An expert team's members run as this agent's own subagents (Claude SDK agents, OpenCode config agents); otherwise the lead plays every role. */
  subagentTeams?: boolean;
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
  /** User-invoked skills picked in the composer, in order. */
  skills?: string[];
  /** Project-relative files and folders the user @-mentioned. */
  mentions?: string[];
  /** Internal: which automatic fix round this send is (0 or absent = the user's). */
  checkRound?: number;
  /** Compact the session instead of sending a message (/compact [focus]). */
  compact?: { focus: string | null };
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
  | { type: "question"; request: QuestionRequest }
  | { type: "question-done"; requestId: string }
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
  /** An MCP server's connection or sign-in state changed: ask for mcpStatus again. */
  | { type: "mcp-status" }
  /** The project list changed (a folder went missing, or was relocated): refetch it. */
  | { type: "projects-changed" }
  /** The app menu asked for the About sheet. */
  | { type: "open-about" }
  /** A turn finished having written previewable files: open the panel on `path` (the last one). */
  | { type: "artifact-ready"; threadId: string; path: string; files: string[] }
  /** Something in an open design thread's folder changed (debounced): the canvas reloads. */
  | { type: "design-changed"; threadId: string }
  /** Self-improve: a turn's health changed (scored, or a later correction/revert). */
  | { type: "turn-score"; score: TurnScore }
  /** Self-improve: a project's lessons or cases changed (the Learned tab refetches). */
  | { type: "learn-changed"; projectId: string };

/** The API the preload script exposes as `window.unskilled`. */
export interface UnskilledApi {
  platform: string;
  /** The window has no vibrancy or Mica behind it (Linux, Windows 10): paint the sidebar opaque. */
  opaqueSidebar: boolean;
  /** Started with --smoke: the renderer exposes its smoke hooks. */
  smoke?: boolean;
  listProjects(): Promise<Project[]>;
  addProject(): Promise<Project | null>;
  /** Point a project at a newly picked folder; null when the dialog was cancelled. */
  relocateProject(projectId: string): Promise<Project | null>;
  deleteProject(projectId: string): Promise<void>;
  /** Set a project's post-turn check command; null/empty turns it off. */
  setCheckCommand(projectId: string, command: string | null, fixRounds?: number | null): Promise<Project>;
  listThreads(projectId: string): Promise<Thread[]>;
  createThread(projectId: string, agent?: string, opts?: { worktree?: boolean; kind?: ThreadKind; designSystem?: string; expertId?: string }): Promise<Thread>;
  /** Pick a design thread's design system (null = the default); the next turn copies it into the design folder. */
  setDesignSystem(threadId: string, id: string | null): Promise<Thread>;
  /** Pick a design thread's prototype tier (null = Working); the next turn tells the agent. */
  setPrototypeTier(threadId: string, tier: PrototypeTier | null): Promise<Thread>;
  updateThread(threadId: string, patch: Partial<Pick<Thread, "title" | "model" | "effort" | "contextWindow" | "permissionMode" | "agent" | "pinned" | "archived">>): Promise<Thread>;
  deleteThread(threadId: string): Promise<void>;
  /** Move a thread to another agent; a refused switch changes nothing. */
  /** `model`: land on this model of the new agent (a provider model), else its default. */
  switchAgent(threadId: string, agent: string, mode: SwitchMode, model?: string): Promise<SwitchResult>;
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
  respondQuestion(requestId: string, answer: QuestionAnswer): Promise<void>;
  pendingState(): Promise<PendingState>;
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
  saveProvider(input: ProviderInput, secret?: string | null, headerValues?: Record<string, string>): Promise<ProviderView>;
  removeProvider(id: string): Promise<SettingsView>;
  /** Store a provider's key (encrypted), or remove it with null. Agents restart to pick it up. */
  setProviderSecret(id: string, value: string | null): Promise<SettingsView>;
  /** Probe a saved provider (by id) or an unsaved draft; a draft without a new key uses the saved one of the same id. */
  testProvider(target: string | ProviderInput, modelId: string, secret?: string, headerValues?: Record<string, string>): Promise<ConnectionResult>;
  /** List a provider's models (saved or draft, as for testProvider), enriched from models.dev. */
  discoverProviderModels(input: ProviderInput, secret?: string, headerValues?: Record<string, string>): Promise<ModelDiscovery>;
  /** Search models.dev's providers (cached, offline-safe) to start a new provider from one. */
  searchProviderCatalog(query: string): Promise<CatalogProvider[]>;
  /** Show the app's data folder (agents.json, the database) in the file manager. */
  openDataFolder(): Promise<void>;
  updateStatus(): Promise<AppUpdateStatus>;
  /** Version, runtime versions and the git build stamp for the About sheet. */
  aboutInfo(): Promise<AboutInfo>;
  /** The harness-side context a thread (or, with no thread, a new one in the project) starts with. */
  contextPreview(threadId: string | null, projectId: string | null): Promise<ContextPreview>;
  memoryOverview(projectId: string): Promise<MemoryOverview>;
  memoryRead(projectId: string, file: string, scope?: MemoryScope): Promise<(MemoryNote & { body: string }) | null>;
  /** Save a note (a new one when file is absent); returns its file. Scope defaults to the project. */
  memoryWrite(projectId: string, note: { file?: string; name: string; description: string; type: MemoryType; body: string }, scope?: MemoryScope): Promise<string>;
  memoryDelete(projectId: string, file: string, scope?: MemoryScope): Promise<boolean>;
  /** Turn memory on/off everywhere (projectId null) or for one project. */
  memorySetEnabled(projectId: string | null, on: boolean): Promise<MemoryOverview | null>;
  /** Import Claude's/Codex's native memory again (deduped); returns how many notes were added. */
  memoryImport(projectId: string): Promise<number>;
  /** Self-improve: a thread's turn scores (empty when its project isn't opted in). */
  learnScores(threadId: string): Promise<TurnScore[]>;
  /** Rate limits reported so far, by agent. */
  listLimits(): Promise<AgentLimits[]>;
  /** Every skill discovered for the project (or globally): the whole list, shadowed and disabled included. */
  listAllSkills(projectId?: string): Promise<SkillEntry[]>;
  getSkillDetail(name: string, projectId?: string): Promise<SkillDetail>;
  /** Turn one skill on or off; returns the refreshed all-skills list. */
  setSkillEnabled(origin: SkillOrigin, name: string, enabled: boolean): Promise<SkillEntry[]>;
  /** The standard skill folders, for the Settings/Library UI. `project` and `projectClaude` are "" without one. */
  getSkillFolders(projectId?: string): Promise<{ projectCubiq: string; project: string; projectClaude: string; harness: string; bundled: string }>;
  /** Create a skill stub under the harness or the project; returns the SKILL.md path. */
  createSkill(input: { scope: "harness" | "project"; projectId?: string | null; name: string; description: string }): Promise<string>;
  listAgentCatalog(): Promise<AgentCatalogEntry[]>;
  getMcp(projectId: string | null): Promise<McpOverview>;
  /** Knock on a URL: transport, whether it wants a sign-in, its name. Saves nothing. */
  probeMcp(url: string, headers?: Record<string, string>): Promise<McpProbeResult>;
  /** Live state of the scope's own servers (global when projectId is null), listing tools as needed. */
  mcpStatus(projectId: string | null, refresh?: boolean): Promise<McpServerStatus[]>;
  /** Sign in to a URL server in the browser (OAuth); resolves when the sign-in finishes or fails. */
  connectMcp(name: string, projectId?: string | null): Promise<{ ok: boolean; error?: string }>;
  /** Sign out: revoke when the server allows, forget the tokens. */
  disconnectMcp(name: string, projectId?: string | null): Promise<McpOverview>;
  /** Store (or clear, with null) the secret of an OAuth client the user registered themselves. */
  setMcpClientSecret(name: string, secret: string | null, projectId?: string | null): Promise<McpOverview>;
  /** Copy a server another agent loads (Library's read-only list) into the app's list; values move into the vault. */
  importMcp(agent: string, source: string, name: string, projectId?: string | null): Promise<McpOverview>;
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
  /** ⌘K full-text search over thread titles and user/assistant messages. */
  search(query: SearchQuery): Promise<SearchResults>;
  /** The files agents wrote in this thread, with their versions; most recently written first. */
  listArtifacts(threadId: string): Promise<ArtifactFile[]>;
  /** A design thread's page for the canvas: its folder (relative to the thread's), entry file and `cubiq-design:` URL; null before the agent writes one. */
  designEntry(threadId: string, rel?: string | null): Promise<DesignEntry | null>;
  /** Text files in a design thread's folder (its pages first), as "/"-separated relative paths; [] for a thread without one. */
  designFiles(threadId: string): Promise<string[]>;
  /** Make a design's `variant-*.html` its `index.html`; the old and new index are saved as versions. */
  designPromote(threadId: string, rel: string): Promise<void>;
  /** Write the canvas's tweak values into a design page (Keep), saving versions; false when nothing changed. */
  designKeepTweaks(threadId: string, rel: string, values: Record<string, string>): Promise<boolean>;
  /** Save a pasted reference image (png/jpg/webp/gif, ≤ 10 MB) into a design thread's `refs/`; its path relative to the thread's folder. */
  designSaveRef(threadId: string, bytes: Uint8Array): Promise<string>;
  /** Capture a rectangle of the app window (CSS px, e.g. the canvas with a Draw overlay) as a PNG reference image in a design thread's `refs/`: its path relative to the thread's folder and a small data-URL thumbnail. */
  designCapture(threadId: string, rect: { x: number; y: number; width: number; height: number }): Promise<{ path: string; thumb: string }>;
  /** Copy a stored version of a design page back as its newest version (the current page is kept as a version first). */
  designRestoreVersion(threadId: string, rel: string, version: number): Promise<void>;
  /** Write an in-place text edit into a design page; refuses (throws) unless that `data-agent-id` is unique, text-only and unchanged. */
  designEditText(threadId: string, rel: string, edit: { id: string; before: string; after: string }): Promise<void>;
  /** Write inspector style changes into the `style` of the page element with that data-agent-id (Working and Real app tiers). */
  designEditStyle(threadId: string, rel: string, edit: { id: string; changes: { prop: string; value: string }[] }): Promise<void>;
  /** A design thread's comments (all pages), from its design folder. */
  designComments(threadId: string): Promise<DesignComment[]>;
  /** Add a comment on one element of a design page; the full list after. */
  designCommentAdd(threadId: string, input: { page: string; target: CommentTarget; label: string; text: string }): Promise<DesignComment[]>;
  /** Resolve or reopen a comment, or mark it sent to the agent; the full list after. */
  designCommentUpdate(threadId: string, id: string, patch: { resolved?: boolean; sent?: boolean }): Promise<DesignComment[]>;
  designCommentDelete(threadId: string, id: string): Promise<DesignComment[]>;
  /** Watch an open design thread's folder (creating it), so changes push `design-changed`; counted per call. */
  designWatch(threadId: string): Promise<void>;
  designUnwatch(threadId: string): Promise<void>;
  /** Show a design thread's folder in Finder / Explorer. */
  designReveal(threadId: string): Promise<void>;
  /** Export a design page (the version on screen) through a save dialog; the saved path, or null when cancelled. */
  designExport(threadId: string, format: DesignExportFormat, opts: { rel: string; version: number | null; width: number }): Promise<string | null>;
  /** The design systems a project's design threads can use: its DESIGN.md, its .agents/design-systems, then the built-ins. */
  designSystems(projectId: string | null): Promise<DesignSystemOption[]>;
  /** The thread's design system for the System tab, or null for a non-design thread. */
  designSystemDoc(threadId: string): Promise<DesignSystemDoc | null>;
  /** Edit the thread's design system (a built-in is copied into the project first and the thread switched to the copy). */
  designSystemEdit(threadId: string, edit: DesignSystemEdit): Promise<{ doc: DesignSystemDoc; thread: Thread }>;
  /** The expert catalogue: bundled experts and teams, then the user's imported ones. */
  listExperts(): Promise<ExpertDef[]>;
  getExpert(id: string): Promise<ExpertDef | null>;
  /** Install expert packages from a GitHub link, a folder or a .zip; a marketplace without `pick` only lists candidates. */
  importExperts(source: string, pick?: string[]): Promise<ExpertImportResult>;
  /** Remove an imported expert (bundled ones can't be removed). */
  removeExpert(id: string): Promise<void>;
  /** Pick a folder or a .zip to import experts from; null when cancelled. */
  pickExpertSource(kind: "folder" | "zip"): Promise<string | null>;
  /** Set (or clear) the expert of a thread with no messages yet; throws on a thread that has messages. */
  setThreadExpert(threadId: string, expertId: string | null): Promise<Thread>;
  /** A thread file's content for the panel: the file on disk, or a saved version. */
  readArtifact(threadId: string, path: string, version?: number | null): Promise<ArtifactContent>;
  /** Unified diff of a version against the one before it (or against git HEAD / empty for the first); null when not text. */
  artifactDiff(threadId: string, path: string, version?: number | null): Promise<string | null>;
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
  /** Each enabled MCP server: its tool count and schema cost, null until listed. Deferred = the agent loads schemas only on demand. */
  mcp: { name: string; tools: number | null; tokens: number | null; deferred: boolean; error?: string }[];
  /** The thread agent's skills listing cost; null outside a thread. */
  skills: { mode: SkillsDelivery["mode"]; count: number; tokens: number } | null;
  /** The shared memory index, once memory exists (null until then). */
  memoryIndex: { lines: number; tokens: number } | null;
}
