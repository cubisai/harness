import type { AgentCapabilities, CodeMode, McpServerEntry, ModelOption, PermissionDecision, PermissionMode, PlanEntry } from "../../../shared/types";
import { CODE_HINT } from "../../code-hint";
import type { TeamAgent } from "../../../shared/experts";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { clipAgentSummary, clipSummary } from "../../../shared/tools";
import type { EditResult, RunPayload, RunResult, ToolDiff } from "../../../shared/tools";
import { diffSummary, unifiedDiff } from "../../../shared/diff";
import { normalizePlan } from "../../../shared/plan";
import { summarizeToolResult } from "../summarize";
import { MODEL_TTL_MS } from "../model-ttl";
import { binaryInfo, majorOf, resolvedInstallAsync } from "../binaries";
import type { AgentDriver, SessionSeed, TurnInput } from "../types";
import { acpCapabilities, withCapabilities } from "../capabilities";
import { forAcpWithReport, mcpChangeNotice } from "../../mcp/servers";
import { TOOL_SERVER_NAME, withBrowserOnDemandFlag, withCode, withProject, withShells, withThread } from "../../mcp-http";
import { BROWSER_CALL } from "../../browser/on-demand";
import { SHELL_TOOL_NAMES } from "../../shell-tools";
import { ASK_USER_TOOL } from "../../questions";
import { checkCommand } from "../../guard";
import { RpcError, StdioRpc } from "../rpc";
import { classifyOpenCodeLog } from "./opencode-log";
import { startAskServer, type AskServer, type PluginAnswer, type PluginAsk } from "./ask-server";
import { exportTurnUsage } from "./opencode-usage";
import { normalizeUsage } from "../../usage";
import type { InjectionPlan } from "../../inject";
import { designWriteAllowed } from "../../design/write-scope";

/** An ACP agent the app can drive: OpenCode, Cursor, or any agent that speaks ACP over stdio. */
export interface AcpAgentConfig {
  id: string;
  label: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  /**
   * An environment variable the agent reads extra skills from. When set, it
   * points at a copy of skilled's model-invoked skills, so the agent can
   * load them without anything written into the project.
   */
  skillsDirEnv?: string;
  /**
   * Declared capabilities the ACP protocol can't report (guard enforcement,
   * skills delivery, permission granularity). Protocol bits in here are
   * overridden by `initialize`, which is authoritative in both directions.
   */
  capabilities?: Partial<AgentCapabilities>;
  /** How to install the agent, shown in the Library when it isn't installed. */
  install?: string;
  homepage?: string;
  /** The Library's MCP text, when the preset differs from the generic ACP wording. */
  mcp?: string;
  /** Which credential injector this agent uses, when it isn't the generic ACP one. */
  injector?: "opencode";
  /** The variable this agent documents for its provider key; unknown agents get their protocol's conventional one plus a notice. */
  keyVar?: string;
  /** Only the provider's own env reaches it: its provider setting isn't verified yet. */
  providerEnvOnly?: boolean;
  /** A guard plugin this agent needs injected to enforce the git guardrail. */
  guardPlugin?: "opencode";
  /**
   * Args for a newer major version of the CLI, keyed by the first major they
   * apply to; `args` covers anything older or a version that can't be read.
   */
  argsByMajor?: Record<string, string[]>;
  /** Reasoning levels come per-model as OpenCode config variants, not a session thought_level option (OpenCode v1 only; v2 has thought_level). */
  effortVia?: "opencode-variants";
  /** Turn token usage comes from `opencode export`, summed over every model call, not the last one. */
  turnUsageVia?: "opencode-export";
  /** Hidden until the user opts in and acknowledges the risk in Settings (preset-only). */
  optIn?: boolean;
  /** Shown as "Unsupported · <this>" wherever the agent appears (preset-only). */
  unsupported?: string;
}

// The slices of the ACP schema this driver reads (protocol version 1).
export type ToolKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "switch_mode" | "other";
interface ToolCallFields {
  toolCallId: string;
  title?: string | null;
  kind?: ToolKind | null;
  status?: "pending" | "in_progress" | "completed" | "failed" | null;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: { type: string; content?: { type: string; text?: string } }[] | null;
  locations?: { path: string; line?: number | null }[] | null;
}
type SessionUpdate =
  | { sessionUpdate: "agent_message_chunk" | "agent_thought_chunk" | "user_message_chunk"; content: { type: string; text?: string } }
  | ({ sessionUpdate: "tool_call" | "tool_call_update" } & ToolCallFields)
  | { sessionUpdate: "usage_update"; used: number; size: number; cost?: { amount: number; currency: string } | null }
  | { sessionUpdate: "plan"; entries: { content: string; priority: "high" | "medium" | "low"; status: "pending" | "in_progress" | "completed" }[] }
  | { sessionUpdate: "config_option_update"; configOptions: ConfigOption[] }
  | { sessionUpdate: "current_mode_update"; currentModeId: string }
  | { sessionUpdate: string };
interface ConfigOption {
  id: string;
  name: string;
  type: "select" | "boolean";
  category?: string | null;
  currentValue: string | boolean;
  options?: ({ value: string; name: string } | { group: string; name: string; options: { value: string; name: string }[] })[];
}
/**
 * OpenCode's own startup race: sessions opening at the same moment can fail
 * with "database is locked". Wait a moment and try once more.
 */
export async function onceMoreIfLocked<T>(run: () => Promise<T>, waitMs = 300 + Math.random() * 700): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (!/database is locked|SQLITE_BUSY/i.test(err instanceof Error ? err.message : String(err))) throw err;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return run();
  }
}

/** ACP's native session modes, advertised by session/new when the agent has them. */
interface SessionModeState {
  currentModeId: string;
  availableModes: { id: string; name: string; description?: string | null }[];
}
interface PermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}
interface InitializeResult {
  protocolVersion: number;
  agentCapabilities?: {
    loadSession?: boolean;
    mcpCapabilities?: { http?: boolean };
    sessionCapabilities?: { resume?: object | null; close?: object | null };
  };
  authMethods?: { id: string; name: string }[];
  agentInfo?: { name?: string; version?: string };
}

/** OpenCode 2 and later bring their own Code Mode (`execute`), so CubiQ's run_code isn't attached there. */
export function hasOwnCodeMode(init: Pick<InitializeResult, "agentInfo">): boolean {
  const info = init.agentInfo;
  const major = Number.parseInt(info?.version ?? "", 10);
  return /opencode/i.test(info?.name ?? "") && Number.isFinite(major) && major >= 2;
}

export const DEFAULT_MODEL = "default";

/** Tool kinds that only read, or edit files: allowed without asking in Auto-edit. */
const AUTO_EDIT_KINDS = new Set<ToolKind>(["read", "search", "think", "fetch", "edit", "move"]);

/** Plan mode's fallback: investigation only, everything that writes or runs waits for approval. */
const PLAN_KINDS = new Set<ToolKind>(["read", "search", "think", "fetch"]);

/**
 * The plan-mode brief an agent without a native plan mode gets, ahead of the
 * prompt: read-only, explore before asking, ask only the user's decisions (via
 * ask_user), then one decision-complete plan. Distilled from Codex's plan mode.
 */
export const PLAN_MODE_PREFIX = `<harness-plan-mode>
You are in plan mode: read-only. Reads and searches run; edits and commands are refused. A request to build something means: plan it.
1. Explore first. Never ask what the project can answer (where code lives, which component exists).
2. Ask only decisions that are the user's (preference, trade-off, scope) and change the plan: call ask_user with 2-4 options, your recommendation first marked "(Recommended)". If they skip, take your recommendation. No ask_user tool: ask in your reply and stop.
3. Finish with one plan an engineer could implement without making decisions: Summary, Key changes (by behavior, few file paths), Test plan, Assumptions. Then stop; don't ask "should I proceed?".
</harness-plan-mode>

`;

/** What an agent with its own plan mode is told: its question tool doesn't reach the app over ACP, ask_user does. */
export const PLAN_MODE_HINT = "<harness-plan-mode>To ask the user a question, call ask_user (2-4 options, recommended first).</harness-plan-mode>\n\n";

/** The files an ACP edit call names: its locations, else the path in its raw input; [] when it names none. */
export function acpEditTargets(call: Pick<ToolCallFields, "locations" | "rawInput">): string[] {
  const located = (call.locations ?? []).map((l) => l.path).filter((p) => typeof p === "string" && p !== "");
  if (located.length) return located;
  const raw = (call.rawInput ?? {}) as Record<string, unknown>;
  for (const key of ["filePath", "file_path", "path"]) if (typeof raw[key] === "string" && raw[key]) return [raw[key] as string];
  return [];
}

export function pickPermission(
  mode: PermissionMode,
  kind: ToolKind | null | undefined,
): "allow" | "ask" | "deny" {
  if (mode === "full") return "allow";
  if (mode === "auto-edit" && kind && AUTO_EDIT_KINDS.has(kind)) return "allow";
  // Plan mode's fallback is read-only: investigation runs, anything that writes
  // or executes is refused until the mode changes (proposals land in a later task).
  if (mode === "plan") return kind && PLAN_KINDS.has(kind) ? "allow" : "deny";
  return "ask";
}

/** The tool kind an OpenCode permission covers, for a sub-agent's own ask; anything else (external_directory, task...) is "other". */
const PERMISSION_KINDS: Record<string, ToolKind> = { read: "read", list: "read", glob: "search", grep: "search", codesearch: "search", edit: "edit", bash: "execute", webfetch: "fetch", websearch: "fetch" };

/**
 * An edit or command OpenCode's CubiQ plugin asks about, decided like an ACP
 * ask: Full allows, Auto-edit allows edits, Ask asks the user. Plan mode
 * defers to OpenCode's own plan agent and its ACP asks, as before the plugin
 * asked (null = defer). A sub-agent's own permission ask is decided in every
 * mode, Plan included: nothing else will answer it.
 */
export async function decidePluginAsk(
  input: Pick<TurnInput, "permissionMode" | "requestPermission"> & Partial<Pick<TurnInput, "cwd" | "design">>,
  ask: PluginAsk,
  signal?: AbortSignal,
): Promise<PermissionDecision | null> {
  const own = ask.kind === "permission";
  if (input.permissionMode === "plan" && !own) return null;
  const kind: ToolKind = ask.kind === "permission" ? (PERMISSION_KINDS[ask.tool] ?? "other") : ask.kind;
  const picked = pickPermission(input.permissionMode, kind);
  if (picked === "allow") return "allow-once";
  if (picked === "deny") return "deny";
  // A design thread's own folder is its canvas: an edit there (the summary is its file) doesn't ask.
  if (ask.kind === "edit" && input.cwd && designWriteAllowed(input.permissionMode, input.cwd, input.design, ask.summary ? [ask.summary] : [])) return "allow-once";
  return input.requestPermission({ toolName: own ? ask.tool : kindLabel(kind), summary: ask.summary || ask.tool, canAlwaysAllow: false, ...(signal ? { signal } : {}) });
}

export function optionFor(options: PermissionOption[], decision: PermissionDecision): string | undefined {
  const order: PermissionOption["kind"][] =
    decision === "allow-always" ? ["allow_always", "allow_once"] : decision === "allow-once" ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  for (const kind of order) {
    const found = options.find((o) => o.kind === kind);
    if (found) return found.optionId;
  }
  return undefined;
}

function modelsFrom(options: ConfigOption[] | null | undefined): ModelOption[] | null {
  const model = options?.find((o) => o.category === "model" && o.type === "select");
  if (!model?.options) return null;
  const flat = model.options.flatMap((o) => ("options" in o ? o.options : [o]));
  return flat.map((o) => ({ id: o.value, label: o.name }));
}

/** The `thought_level` select's option values; ACP carries one list per session, not per model. */
function effortsFrom(options: ConfigOption[] | null | undefined): string[] | null {
  const opt = options?.find((o) => o.category === "thought_level" && o.type === "select");
  if (!opt?.options) return null;
  return opt.options.flatMap((o) => ("options" in o ? o.options : [o])).map((o) => o.value);
}

interface Live {
  conn: StdioRpc;
  init: InitializeResult;
  /** The thread this process belongs to, so its config options are remembered per thread. */
  threadKey: string;
  /** The command the agent process was spawned with. */
  command: string;
  /** The environment the agent process was spawned with. */
  env: NodeJS.ProcessEnv;
  sessionId: string | null;
  configOptions: ConfigOption[];
  /** Whether this session was opened with the harness's tool server attached. */
  /** The MCP servers the session was opened with, to notice when they change. */
  mcpSignature: string;
  /** The same servers by name, to say which ones changed. */
  mcpByName: Record<string, unknown>;
  /**
   * The reasoning variant this process was spawned with, as a flat key (or
   * null). OpenCode fixes the variant at startup, so a changed pick needs a
   * new process and the session resumed.
   */
  variantKey: string | null;
  /** HTTP servers already reported as dropped on this connection, so each is said once. */
  droppedNotified: Set<string>;
  /** A freshly created session still owes its first prompt the harness guide. */
  guidePending: boolean;
  /** A freshly created session still owes its first prompt the seed's history prefix. */
  historyPending: string | null;
  /** The turn currently receiving this connection's updates. */
  turn: TurnState | null;
  /** Slash commands the agent advertised for the session (available_commands_update), by name. */
  commands?: string[];
  /** ACP's native session modes, when the agent advertises them (null = emulated plan mode). */
  modes: SessionModeState | null;
  /** The advertised mode id matching /plan/i, once modes are known. */
  planModeId: string | null;
  /** The mode to switch back to when leaving plan mode. */
  defaultModeId: string | null;
  /** The sign-in URL the agent last printed on stderr, or null. */
  authUrl: string | null;
  /** The app's tool server (with ask_user) is attached to this session. */
  askUser?: boolean;
  /** Calls the CubiQ plugin already got an answer for: OpenCode's own ACP ask for one is allowed, not asked twice. */
  approvedCalls: Set<string>;
  idleTimer?: NodeJS.Timeout;
}

export const ACP_AUTH_TIMEOUT_MS = 180_000;

/** The browser sign-in link Google's ACP server prints on stderr, or null. */
export function authUrlFrom(line: string): string | null {
  const m = /Open the following link to authenticate[^:]*:\s*(\S+)/i.exec(line);
  return m ? m[1]! : null;
}

interface TurnState {
  input: TurnInput;
  text: string;
  thought: string;
  tools: Map<
    string,
    {
      name: string;
      kind?: ToolKind | null;
      done: boolean;
      streamed?: string;
      /** Whether its tool-use event went out (held until the arguments arrive). */
      announced: boolean;
      title?: string | null;
      rawInput?: unknown;
      rawOutput?: unknown;
      /** The tool-use payload, so a write's result can repeat its diff. */
      payload?: unknown;
      /** The last plan emitted for a todowrite call, so a repeat isn't re-sent. */
      planKey?: string;
      locations?: ToolCallFields["locations"];
      /** An OpenCode v2 Code Mode script (`execute`), shown as run_code with a child row per call it made. */
      script?: boolean;
      /** Which of the script's calls have had their tool-use / tool-result sent, by index. */
      steps?: { announced: boolean; done: boolean }[];
    }
  >;
  /** Permission toolCallIds seen this turn, to spot a mismatch from the real call. */
  permissionIds: Set<string>;
  /** Whether a plan update (its own or a folded todowrite) was shown this turn. */
  planned: boolean;
  /**
   * The turn's usage: `used`/`costUsd` fold the latest usage_update. `contextUsed`
   * stays null until one arrives, so a usage-free turn isn't read as a real 0.
   */
  usage: { used: number; costUsd: number | null; contextUsed: number | null; size: number | null };
  /** Bumped when flushText emits an item, so the next run of chunks gets fresh keys. */
  run: number;
  /** Model-call errors already reported this turn, so a retrying call is said once. */
  logErrors: Set<string>;
  /** Permission asks heard on stderr this turn, by ask id, so each is said once. */
  askIds: Set<string>;
  /** Pending "waiting for a permission" notices by ask id; cleared on an ACP ask or the turn's end. */
  askTimers: Map<string, NodeJS.Timeout>;
}

const IDLE_MS = 10 * 60_000;

/** How long a stderr "asking" line waits for the matching ACP permission before we call it stalled. */
const ASK_WAIT_MS = 5_000;

/** The live item key for a run of chunks; flushText bumps `run` to start a new one. */
function itemKey(t: TurnState, kind: "text" | "thought"): string {
  return `${kind}-${t.run}`;
}

/**
 * Drives any agent speaking the Agent Client Protocol over stdio. One agent
 * process per thread, kept alive between turns (and resumed from the stored
 * session id after a restart when the agent supports it).
 */
export function createAcpDriver(
  config: AcpAgentConfig,
  deps: {
    skillsDir?: () => string | null;
    clientVersion: string;
    /** The harness's tools over HTTP MCP, for agents that take MCP servers. */
    toolServer?: () => Promise<{ url: string; token: string; skillsUrl?: string; routedUrl?: string }>;
    /** The thread's code mode: on adds run_code to the tool server URL (`&c=`), except on agents with their own (OpenCode 2+). */
    codeMode?: (threadId: string) => CodeMode;
    /**
     * Whether this session's MCP servers go through the app's router instead of
     * being sent (decided at session start); only asked when capabilities.mcpRouter.
     */
    mcpRouting?: (projectId: string | null, servers: McpServerEntry[]) => Promise<boolean>;
    /** The credential plan for the next agent process; absent = inherit process.env. */
    /**
     * `team`: the thread's expert team members, injected as subagents for this thread's process only;
     * `teamLead`: the primary agent (mode) the lead runs as, which must be allowed to hand them work;
     * `expertRoot`: the folder of the expert's private package skills, which its agents may read.
     */
    injection?: (ctx?: { effort?: { agent: string; model: string; variant: string }; team?: TeamAgent[]; teamLead?: string; expertRoot?: string; major?: number | null }) => InjectionPlan;
    /** Per-model reasoning variants, for agents that carry them outside a thought_level option. */
    variants?: () => Promise<Record<string, string[]>>;
    /** The git-guardrails script: an execute permission call is vetoed in every mode. */
    guardScript?: string;
    /** The harness guide for this turn's cwd, sent once, ahead of a new session's first prompt. */
    guide?: (cwd: string, design?: string) => string;
    /** The skills listing and MCP tool schemas this project's new session carries, in estimated tokens (0 when deferred or not yet listed). */
    extensions?: (cwd: string, projectId: string | null) => { skills: number; mcp: number };
    /** The memory block for this project's new sessions (may be ""), or null when memory is off; sent once with the guide. */
    memory?: (projectId: string, threadId?: string, sessionKey?: string | null) => string | null;
  },
): AgentDriver {
  const live = new Map<string, Live>();
  /** A bare command is resolved to its newest installed copy at spawn time. */
  const bare = !config.command.includes("/") && !config.command.includes("\\");
  let knownModels: ModelOption[] = [];
  let knownEfforts: string[] = [];
  /** When the current model list was last fetched; 0 = never. */
  let listedAt = 0;
  /** Model id → its variant names, for the effortVia agents. */
  let knownVariants: Record<string, string[]> = {};
  /** The last session's config options, so the default option can name its model. */
  let lastConfigOptions: ConfigOption[] = [];
  /** Each thread's config options from its last session, for a respawn before one exists. */
  const threadConfigs = new Map<string, ConfigOption[]>();
  let variantsPromise: Promise<void> | null = null;
  // Preset metadata, then the first initialize's protocol facts (below).
  let capabilities = acpCapabilities(config);
  // Once-per-driver, like Claude: the same feature-loss notice isn't repeated.
  const shownNotices = new Set<string>();
  // Threads already told that a variant change restarted OpenCode.
  const variantNotified = new Set<string>();
  /** The CLI's major version, once read (null: unknown, treated as the oldest). */
  let cliMajor: number | null = null;
  /** Read the CLI's major version once, for agents whose args or config change with it. */
  const knowMajor = async (): Promise<void> => {
    if (!config.argsByMajor || cliMajor !== null) return;
    cliMajor = majorOf((await resolvedInstallAsync(config.command))?.version);
  };
  /**
   * The command and args to spawn: a bare command resolves to its newest
   * install, and the CLI's major version picks the args.
   */
  const launch = async (): Promise<{ command: string; args: string[] }> => {
    await knowMajor();
    const command = bare ? ((await resolvedInstallAsync(config.command))?.path ?? config.command) : config.command;
    return { command, args: argsFor(config, cliMajor) };
  };
  /** OpenCode v1 carries reasoning levels as config variants; v2 has a thought_level option. */
  const viaVariants = (): boolean => config.effortVia === "opencode-variants" && (cliMajor ?? 1) < 2;
  // OpenCode asks over ACP only when its own config says "ask", and a user's agent can allow
  // everything; its CubiQ plugin asks this server before every edit and command instead.
  const pluginAsks = config.guardPlugin === "opencode";
  let askServer: Promise<AskServer> | null = null;

  /** One plugin ask from a thread's process: no live turn means nobody can approve it. */
  const answerPluginAsk = async (l: Live | undefined, ask: PluginAsk, signal?: AbortSignal): Promise<PluginAnswer> => {
    const t = l?.turn;
    if (!l || !t) return "deny";
    // The git guardrail vetoes a command in every mode, Plan and Full included, before anyone is asked;
    // here it needs no Python, so OpenCode's guard blocks wherever its plugin runs.
    if (ask.kind === "execute" && deps.guardScript) {
      const verdict = await checkCommand(deps.guardScript, "Bash", ask.summary);
      if (verdict.blocked) {
        t.input.onEvent({ kind: "notice", text: `Blocked by git guardrails: ${ask.summary}` });
        // The model reads the guardrail's reason, not "the user denied", so it doesn't think it was asked.
        return { decision: "deny", reason: verdict.reason || "Blocked by git guardrails." };
      }
    }
    if (ask.kind === "permission" && ask.callID) {
      // Being answered, so not the stall the stderr watcher warns about.
      t.askIds.add(ask.callID);
      clearTimeout(t.askTimers.get(ask.callID));
      t.askTimers.delete(ask.callID);
    }
    const decision = await decidePluginAsk(t.input, ask, signal);
    if (decision === null) return "allow-once";
    if (decision !== "deny" && ask.callID && ask.kind !== "permission") l.approvedCalls.add(ask.callID);
    return decision;
  };

  /** Remember the model and thought-level lists a session's config options carry. */
  const rememberConfig = (options: ConfigOption[] | null | undefined, threadKey?: string) => {
    if (!options) return;
    knownModels = modelsFrom(options) ?? knownModels;
    knownEfforts = effortsFrom(options) ?? knownEfforts;
    lastConfigOptions = options;
    if (threadKey) threadConfigs.set(threadKey, options);
  };

  /** Remember a session's native modes: the plan id, and the mode to return to when leaving plan. */
  const rememberModes = (l: Live, modes: SessionModeState | null | undefined) => {
    if (!modes?.availableModes?.length) return;
    l.modes = modes;
    const plan = modes.availableModes.find((m) => /plan/i.test(m.id))?.id ?? null;
    l.planModeId = plan;
    l.defaultModeId = modes.currentModeId !== plan ? modes.currentModeId : (modes.availableModes.find((m) => m.id !== plan)?.id ?? null);
  };

  /**
   * Put the session into the mode this round wants, when the agent advertises a
   * native plan mode. Returns whether plan mode is natively active (so the
   * prompt needs no emulation brief). A failed switch turns native plan mode
   * off for the session, with a notice, and the emulation path takes over.
   */
  const applyPlanMode = async (l: Live, input: TurnInput, mode: PermissionMode): Promise<boolean> => {
    const setMode = async (modeId: string) => {
      await l.conn.request("session/set_mode", { sessionId: l.sessionId, modeId });
      if (l.modes) l.modes.currentModeId = modeId;
    };
    const fallback = () => {
      l.planModeId = null;
      const notice = `${config.label} couldn't switch its session mode; falling back to prompt-based plan mode.`;
      if (!shownNotices.has(notice)) {
        shownNotices.add(notice);
        input.onEvent({ kind: "notice", text: notice });
      }
    };
    if (mode === "plan") {
      if (!l.planModeId) return false;
      if (l.modes?.currentModeId === l.planModeId) return true;
      try {
        await setMode(l.planModeId);
        return true;
      } catch {
        fallback();
        return false;
      }
    }
    // Leaving plan mode: put the session back where it was before.
    if (l.planModeId && l.modes?.currentModeId === l.planModeId && l.defaultModeId) {
      try {
        await setMode(l.defaultModeId);
      } catch {
        fallback();
      }
    }
    return false;
  };

  /** Load the variant map once, for the effortVia agents. */
  const ensureVariants = async (): Promise<void> => {
    await knowMajor();
    if (!viaVariants()) return;
    variantsPromise ??= (async () => {
      try {
        knownVariants = (await deps.variants?.()) ?? {};
      } catch {
        knownVariants = {};
      }
    })();
    return variantsPromise;
  };

  const modelFrom = (options: ConfigOption[] | null | undefined): string | null => {
    const opt = options?.find((o) => o.category === "model" && o.type === "select");
    return typeof opt?.currentValue === "string" ? opt.currentValue : null;
  };
  const modeFrom = (options: ConfigOption[] | null | undefined): string => {
    const opt = options?.find((o) => o.category === "mode" && o.type === "select");
    return typeof opt?.currentValue === "string" ? opt.currentValue : "build";
  };

  /**
   * The variant this turn wants, or null when none applies: effort set, and the
   * turn's model (or the session's current model for DEFAULT_MODEL) lists it.
   * The agent name is the session's current mode, defaulting to "build".
   */
  const wantedVariant = (
    threadKey: string,
    input: TurnInput,
    l?: Live,
  ): { agent: string; model: string; variant: string } | null => {
    if (!viaVariants() || !input.effort) return null;
    const options = l?.configOptions ?? threadConfigs.get(threadKey) ?? lastConfigOptions;
    const model = input.model === DEFAULT_MODEL ? modelFrom(options) : input.model;
    if (!model || !knownVariants[model]?.includes(input.effort)) return null;
    return { agent: modeFrom(options), model, variant: input.effort };
  };

  const variantKeyOf = (pick: { agent: string; model: string; variant: string } | null): string | null =>
    pick ? `${pick.agent}:${pick.model}:${pick.variant}` : null;

  /** Protocol capabilities the agent reports; initialize wins over preset metadata. */
  const PROTOCOL_LABELS: Record<"mcpHttp" | "resume", string> = { mcpHttp: "MCP over HTTP", resume: "session resume" };

  /**
   * Fold an `initialize` result into the driver's capabilities. Protocol
   * capabilities are authoritative in both directions, so a capability the
   * preset claimed but the agent no longer reports is turned off and, during
   * a turn, said out loud.
   */
  const applyInitialize = (init: InitializeResult, input?: TurnInput) => {
    const next = withCapabilities(capabilities, {
      mcpHttp: Boolean(init.agentCapabilities?.mcpCapabilities?.http),
      resume: Boolean(init.agentCapabilities?.sessionCapabilities?.resume) || Boolean(init.agentCapabilities?.loadSession),
    });
    if (input) {
      for (const key of ["mcpHttp", "resume"] as const) {
        if (capabilities[key] && !next[key]) {
          input.onEvent({ kind: "notice", text: `${config.label} no longer reports ${PROTOCOL_LABELS[key]}; it's off for this agent now.` });
        }
      }
    }
    capabilities = next;
  };

  const flushText = (t: TurnState) => {
    let flushed = false;
    if (t.thought.trim()) {
      t.input.onEvent({ kind: "thinking", text: t.thought, itemId: itemKey(t, "thought") });
      flushed = true;
    }
    if (t.text.trim()) {
      t.input.onEvent({ kind: "assistant-text", text: t.text, itemId: itemKey(t, "text") });
      flushed = true;
    }
    t.text = "";
    t.thought = "";
    if (flushed) t.run++;
  };

  /** Drop a turn's pending "waiting for a permission" notices. */
  const clearAskTimers = (t: TurnState) => {
    for (const timer of t.askTimers.values()) clearTimeout(timer);
    t.askTimers.clear();
  };

  const onUpdate = (l: Live, update: SessionUpdate) => {
    const t = l.turn;
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = (update as { content: { text?: string } }).content.text ?? "";
        if (t && text) {
          t.text += text;
          t.input.onTextDelta(text, itemKey(t, "text"));
        }
        return;
      }
      case "agent_thought_chunk": {
        const text = (update as { content: { text?: string } }).content.text ?? "";
        if (t && text) {
          t.thought += text;
          t.input.onReasoningDelta?.({ itemId: itemKey(t, "thought"), text, opaque: false });
        }
        return;
      }
      case "tool_call":
      case "tool_call_update": {
        if (!t) return;
        const u = update as ToolCallFields & { sessionUpdate: string };
        // Some agents ask permission under one id and execute under another, then
        // send bookkeeping updates under the permission id - including a "failed"
        // one after a call that in fact succeeded (Google's Antigravity: permission
        // "27060ac9…" vs the real "<sessionId>:1"). An update for a permission id
        // that never announced a tool_call is that bookkeeping, not a result.
        if (
          update.sessionUpdate === "tool_call_update" &&
          (u.status === "completed" || u.status === "failed") &&
          !t.tools.has(u.toolCallId) &&
          t.permissionIds.has(u.toolCallId)
        ) {
          return;
        }
        let tool = t.tools.get(u.toolCallId);
        const incoming = hasInput(u.rawInput) ? u.rawInput : undefined;
        // OpenCode's todowrite is a tool call carrying a plan, not a tool: fold
        // each distinct list into a plan event and show no row for it.
        const todoEntries = planEntriesFromTodos(incoming ?? tool?.rawInput);
        if (todoEntries) {
          if (!tool) {
            flushText(t);
            tool = { name: "plan", done: true, announced: true };
            t.tools.set(u.toolCallId, tool);
          }
          tool.rawInput = incoming ?? tool.rawInput;
          tool.rawOutput = u.rawOutput ?? tool.rawOutput;
          const key = JSON.stringify(todoEntries);
          if (tool.planKey !== key) {
            tool.planKey = key;
            t.input.onEvent({ kind: "plan", entries: todoEntries });
          }
          return;
        }
        if (!tool) {
          flushText(t);
          tool = { name: u.title ?? u.kind ?? "tool", kind: u.kind, done: false, announced: false };
          t.tools.set(u.toolCallId, tool);
        }
        // Keep what earlier updates said: a later one may carry only the part that changed.
        tool.title = u.title ?? tool.title;
        tool.kind = u.kind ?? tool.kind;
        tool.rawInput = incoming ?? tool.rawInput;
        tool.locations = u.locations?.length ? u.locations : tool.locations;
        tool.rawOutput = u.rawOutput ?? tool.rawOutput;
        const text = (u.content ?? []).map((c) => c.content?.text ?? "").join(" ");
        const terminal = u.status === "completed" || u.status === "failed";
        if (!tool.announced) {
          // OpenCode sends a call's arguments only on a later tool_call_update, so a
          // row announced from the first message would say just "bash" or nothing.
          // Wait for the arguments, but never past the call's first output or its end.
          const merged = { ...u, title: tool.title, kind: tool.kind, rawInput: tool.rawInput, locations: tool.locations };
          const raw = merged.rawInput as Record<string, unknown> | null | undefined;
          const command = typeof raw?.command === "string" ? raw.command : undefined;
          const own = harnessTool(merged);
          const script = codeModeScript(merged);
          const subagent = merged.kind === "think" && typeof raw?.subagent_type === "string";
          const summary = script !== null ? clipSummary(script) : (own?.summary ?? (subagent ? subagentSummary(raw!, merged.title) : toolSummary(merged, command)));
          // Vague: nothing to show, or only the tool's bare name ("bash", "edit").
          const vague = summary === "" || (/^[a-z_]+$/.test(summary) && summary === merged.title);
          if (!vague || text || terminal) {
            tool.announced = true;
            // An execute call's payload names the command even when rawInput
            // doesn't carry one (the title does), like the other adapters' Run.
            const payload = script !== null ? { code: script } : toolUsePayload(merged.kind, merged.rawInput, command ?? merged.title ?? "");
            tool.payload = payload;
            tool.script = script !== null;
            t.input.onEvent({
              kind: "tool-use",
              toolUseId: u.toolCallId,
              name: script !== null ? "run_code" : (own?.name ?? (subagent ? "Agent" : kindLabel(merged.kind))),
              summary,
              ...(payload !== undefined ? { payload } : {}),
            });
          }
        }
        // An update's content replaces the previous one (a snapshot, not an
        // increment): stream only what it adds when it extends what was sent.
        if (!tool.done && text && u.status !== "completed" && u.status !== "failed") {
          const sent = tool.streamed ?? "";
          const added = text.startsWith(sent) ? text.slice(sent.length) : `\n${text}`;
          if (added) t.input.onToolOutputDelta?.({ toolUseId: u.toolCallId, text: added });
          tool.streamed = text;
        }
        if (tool.script && !tool.done) {
          // Each call the script made becomes a child row, as native run_code's are;
          // v2 lists them only in rawOutput, so a call can't outlive its script's row.
          const steps = (tool.steps ??= []);
          scriptSteps(tool.rawOutput).forEach((s, i) => {
            const toolUseId = `${u.toolCallId}:${i + 1}`;
            const seen = (steps[i] ??= { announced: false, done: false });
            if (!seen.announced) {
              seen.announced = true;
              t.input.onEvent({ kind: "tool-use", toolUseId, name: scriptStepName(s.tool), summary: scriptStepSummary(s.input), ...(hasInput(s.input) ? { payload: s.input } : {}), parentId: u.toolCallId });
            }
            if (!seen.done && (terminal || (s.status !== "running" && s.status !== "pending"))) {
              seen.done = true;
              const failed = s.status !== "completed";
              t.input.onEvent({ kind: "tool-result", toolUseId, isError: failed, summary: failed ? "Failed" : "Done", parentId: u.toolCallId });
            }
          });
        }
        if (!tool.done && (u.status === "completed" || u.status === "failed")) {
          tool.done = true;
          // A terminal update may omit the kind its tool_call carried.
          const payload = resultPayload({ ...u, kind: u.kind ?? tool.kind }, text, tool);
          const diff = u.status === "completed" && payload && typeof payload === "object" && "diff" in payload ? (payload as EditResult).diff : [];
          const agentText = isSubagent(tool) ? taskResultText(outputText(tool.rawOutput)) : "";
          // An execute call's output can come from rawOutput when the agent sent
          // no content (Antigravity); resultPayload resolved it, so the summary
          // reads the same output rather than the empty content text.
          const resultOutput = payload && typeof payload === "object" && "output" in payload ? String((payload as RunResult).output) : text;
          t.input.onEvent({
            kind: "tool-result",
            toolUseId: u.toolCallId,
            isError: u.status === "failed",
            summary: diff.length ? diffSummary(diff) : summarizeToolResult(agentText) || summarizeToolResult(resultOutput) || (u.status === "failed" ? "Failed" : "Done"),
            ...(payload !== null ? { payload } : {}),
          });
        }
        return;
      }
      case "usage_update": {
        const u = update as { used: number; size: number; cost?: { amount: number; currency: string } | null };
        if (t) {
          t.usage.used = u.used;
          t.usage.contextUsed = u.used;
          t.usage.size = u.size;
          if (u.cost?.currency === "USD") t.usage.costUsd = u.cost.amount;
          t.input.onUsageUpdate?.({
            contextUsed: u.used,
            contextSize: u.size,
            ...(u.cost?.currency === "USD" ? { costUsd: u.cost.amount } : {}),
          });
        }
        return;
      }
      case "plan":
        if (t) {
          t.planned = true;
          const entries = normalizePlan((update as { entries?: unknown }).entries);
          if (entries) t.input.onEvent({ kind: "plan", entries });
        }
        return;
      case "config_option_update":
        l.configOptions = (update as { configOptions: ConfigOption[] }).configOptions;
        rememberConfig(l.configOptions, l.threadKey);
        return;
      case "available_commands_update":
        l.commands = ((update as { availableCommands?: { name: string }[] }).availableCommands ?? []).map((c) => c.name);
        // /compact is offered once the agent advertises a compact command of its own.
        if (!capabilities.manualCompact && l.commands.some((c) => c === "compact" || c === "summarize")) {
          capabilities = withCapabilities(capabilities, { manualCompact: true });
        }
        return;
      case "current_mode_update":
        // The agent confirms a mode switch; keep the current id without
        // re-asking its session/new state.
        if (l.modes) l.modes.currentModeId = (update as { currentModeId: string }).currentModeId;
        return;
      default:
        return;
    }
  };

  const connect = async (threadKey: string, input: TurnInput): Promise<Live> => {
    await ensureVariants();
    const existing = live.get(threadKey);
    // A live process has a pick already; a new one resolves from the turn's model.
    const wanted = wantedVariant(threadKey, input, existing);
    const wantedKey = variantKeyOf(wanted);
    if (existing?.conn.alive && wantedKey === existing.variantKey) return existing;
    if (existing?.conn.alive) {
      // The variant is fixed when OpenCode starts, so a changed pick (or a
      // reset to default) needs a new process, resumed with the same session.
      existing.conn.close();
      live.delete(threadKey);
      if (viaVariants() && !variantNotified.has(threadKey)) {
        variantNotified.add(threadKey);
        input.onEvent({ kind: "notice", text: `OpenCode restarted to apply reasoning effort ${wanted?.variant ?? "default"}; the conversation continues.` });
      }
    }

    // A thread's process is its own, so its team's subagents never reach another thread.
    const team = input.team?.length ? { team: input.team, teamLead: modeFrom(existing?.configOptions ?? threadConfigs.get(threadKey) ?? lastConfigOptions) } : {};
    const ctx = wanted || input.team?.length || input.expertRoot ? { ...(wanted ? { effort: wanted } : {}), ...team, ...(input.expertRoot ? { expertRoot: input.expertRoot } : {}) } : undefined;
    // The CLI's major version picks the config shape (OpenCode v1 or v2).
    const plan = deps.injection?.(cliMajor !== null ? { ...ctx, major: cliMajor } : ctx);
    if (plan?.error) throw new Error(plan.error);
    if (plan?.warning && !shownNotices.has(plan.warning)) {
      shownNotices.add(plan.warning);
      input.onEvent({ kind: "notice", text: plan.warning });
    }
    const env: NodeJS.ProcessEnv = { ...(plan?.env ?? process.env), ...config.env };
    if (config.skillsDirEnv && deps.skillsDir) {
      const dir = deps.skillsDir();
      if (dir) env[config.skillsDirEnv] = dir;
    }
    const { command, args } = await launch();
    // eslint-disable-next-line prefer-const
    let l: Live;
    let asks: { server: AskServer; token: string } | null = null;
    if (pluginAsks) {
      const server = await (askServer ??= startAskServer());
      asks = { server, token: server.register((ask, signal) => answerPluginAsk(l, ask, signal)) };
      env.CUBIQ_ASK_URL = server.url;
      env.CUBIQ_ASK_TOKEN = asks.token;
    }
    const conn = StdioRpc.spawn(command, args, { cwd: input.cwd, env }, {
      onNotification: (method, params) => {
        if (method === "session/update") onUpdate(l, (params as { update: SessionUpdate }).update);
      },
      onRequest: async (method, params) => {
        if (method !== "session/request_permission") throw new RpcError(-32601, `${method} is not supported by this client`);
        const p = params as { toolCall: ToolCallFields; options: PermissionOption[] };
        const t = l.turn;
        // Remember the id the agent asks under: it may differ from the id it
        // later executes under, and can arrive again as a spurious terminal update.
        t?.permissionIds.add(p.toolCall.toolCallId);
        // An ask that reaches us over ACP is one the app can answer, so any
        // stalled-ask notice the stderr log armed for this turn is disarmed.
        if (t) clearAskTimers(t);
        // The git guardrail vetoes shell commands in every mode, even Full:
        // before the user is asked (or not), the command is checked.
        if (p.toolCall.kind === "execute" && deps.guardScript) {
          const raw = p.toolCall.rawInput as { command?: unknown; cmd?: unknown } | null | undefined;
          const command = typeof raw?.command === "string" ? raw.command : typeof raw?.cmd === "string" ? raw.cmd : `${p.toolCall.title ?? ""}`;
          const verdict = await checkCommand(deps.guardScript, "Bash", command);
          if (verdict.blocked) {
            t?.input.onEvent({ kind: "notice", text: `Blocked by git guardrails: ${command}` });
            const reject = p.options.find((o) => o.kind === "reject_once");
            return reject ? { outcome: { outcome: "selected", optionId: reject.optionId } } : { outcome: { outcome: "cancelled" } };
          }
        }
        const choose = async (): Promise<PermissionDecision> => {
          if (!t) return "deny";
          // The user (or the mode) already answered this call through the CubiQ plugin.
          if (l.approvedCalls.delete(p.toolCall.toolCallId)) return "allow-once";
          const picked = pickPermission(t.input.permissionMode, p.toolCall.kind);
          if (picked === "allow") return "allow-once";
          // A design thread's own folder is its canvas: file edits there don't ask.
          if (p.toolCall.kind === "edit" && designWriteAllowed(t.input.permissionMode, t.input.cwd, t.input.design, acpEditTargets(p.toolCall))) return "allow-once";
          // The harness's own safe tools (browser snapshot, click, ...) run without asking.
          const title = `${p.toolCall.title ?? ""}`;
          if (t.input.tools.some((tool) => tool.autoAllow && title.includes(tool.name))) return "allow-once";
          // Asking the user is never an action to approve, in any mode (Plan included).
          if (title.includes(ASK_USER_TOOL)) return "allow-once";
          if (picked === "deny") return "deny";
          return t.input.requestPermission({
            toolName: kindLabel(p.toolCall.kind),
            summary: p.toolCall.title ?? JSON.stringify(p.toolCall.rawInput ?? {}),
            canAlwaysAllow: p.options.some((o) => o.kind === "allow_always"),
          });
        };
        const optionId = optionFor(p.options, await choose());
        return optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } };
      },
      onStderrLine: (line) => {
        // The sign-in link is printed on stderr; keep the first one we see.
        if (!l) return;
        const url = authUrlFrom(line);
        if (url && !l.authUrl) l.authUrl = url;
        // OpenCode's logfmt stderr is the only word on a retrying model call or
        // a permission ask it waits on without ever sending it over ACP; while a
        // turn is live, turn those into a notice instead of a bare spinner.
        const t = l.turn;
        if (!t) return;
        const log = classifyOpenCodeLog(line);
        if (!log) return;
        if (log.kind === "stream-error") {
          if (t.logErrors.has(log.error)) return;
          t.logErrors.add(log.error);
          t.input.onEvent({ kind: "notice", text: `OpenCode's model call failed: ${log.error.replace(/[.\s]+$/, "")}. It may keep retrying; switch the model or stop the turn.` });
          return;
        }
        if (t.askIds.has(log.id)) return;
        t.askIds.add(log.id);
        const asked = `${log.permission}${log.patterns.length ? ` ${log.patterns.join(", ")}` : ""}`;
        const timer = setTimeout(() => {
          t.askTimers.delete(log.id);
          if (l.turn !== t) return;
          t.input.onEvent({ kind: "notice", text: `OpenCode is waiting for a permission it can't ask here: ${asked} (often a sub-agent). Stop the turn, or allow it in OpenCode's config.` });
        }, ASK_WAIT_MS);
        timer.unref?.();
        t.askTimers.set(log.id, timer);
      },
      onExit: () => {
        asks?.server.revoke(asks.token);
        if (live.get(threadKey) === l) live.delete(threadKey);
      },
    });
    const init = await conn.request<InitializeResult>("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "cubiq", version: deps.clientVersion },
    });
    applyInitialize(init, input);
    l = { conn, init, threadKey, command, env, sessionId: null, configOptions: [], mcpSignature: "[]", mcpByName: {}, variantKey: wantedKey, droppedNotified: new Set(), guidePending: false, historyPending: null, turn: null, modes: null, planModeId: null, defaultModeId: null, authUrl: null, approvedCalls: new Set() };
    // No proactive authenticate: the server infers the method from its own
    // settings and refreshes the token itself, so calling it here only ever
    // launched a browser (including during the startup model probe). A signed-out
    // profile is signed in on demand, when session/new first needs it.
    live.set(threadKey, l);
    return l;
  };

  const mcpServersFor = async (l: Live, input: TurnInput): Promise<{ servers: { name: string }[]; routedUsers: McpServerEntry[] }> => {
    const http = Boolean(l.init.agentCapabilities?.mcpCapabilities?.http);
    const enabled = input.mcpServers.filter((s) => s.enabled);
    const routed =
      capabilities.mcpRouter === true && http && !!deps.toolServer && input.tools.length > 0 && deps.mcpRouting
        ? await deps.mcpRouting(input.projectId ?? null, enabled)
        : false;
    // Routed: the user's servers aren't sent; the agent reaches them through the
    // app's search_tools/call_mcp_tool instead. The routed entries still count
    // towards change detection, so an edit mid-thread is noticed.
    const report = forAcpWithReport(routed ? [] : input.mcpServers, http);
    const servers: { name: string }[] = report.servers;
    const dropped = [...report.dropped];
    if (input.tools.length && deps.toolServer) {
      if (http) {
        const { url, token, skillsUrl, routedUrl } = await deps.toolServer();
        // In tool mode the skill tool rides on /mcp-skills, alongside the browser tools.
        const skillsTarget = capabilities.skillsDelivery.mode === "tool" ? (skillsUrl ?? url) : url;
        const target = routed ? (routedUrl ?? skillsUrl ?? url) : skillsTarget;
        const code = (deps.codeMode?.(input.threadId) ?? "off") !== "off" && !hasOwnCodeMode(l.init);
        const shells = input.tools.some((t) => (SHELL_TOOL_NAMES as readonly string[]).includes(t.name)) ? input.threadId : undefined;
        const toolUrl = withBrowserOnDemandFlag(withShells(withCode(withThread(withProject(target, input.projectId), input.threadId), code ? input.threadId : undefined), shells), input.tools.some((t) => t.name === BROWSER_CALL));
        servers.push({ type: "http", name: TOOL_SERVER_NAME, url: toolUrl, headers: [{ name: "Authorization", value: `Bearer ${token}` }] } as { name: string });
        l.askUser = true;
      } else dropped.push("the app's browser tools");
    }
    // Never a silent drop (invariant 7): name each server the agent can't take, once per connection.
    const fresh = dropped.filter((n) => !l.droppedNotified.has(n));
    if (fresh.length) {
      for (const n of fresh) l.droppedNotified.add(n);
      input.onEvent({
        kind: "notice",
        text: `${config.label} doesn't support MCP over HTTP, so these servers were left out: ${fresh.join(", ")}.`,
      });
    }
    return { servers, routedUsers: routed ? enabled : [] };
  };

  /**
   * The agent's own sign-in: opens a browser flow and blocks until the callback
   * lands. The URL arrives on stderr, so it is relayed to the user as a notice the
   * moment it appears; a timeout and the turn's abort both end the wait.
   */
  const signIn = async (l: Live, input: TurnInput): Promise<boolean> => {
    const auth = l.init.authMethods?.[0];
    if (!auth) return false;
    l.authUrl = null;
    let announced = false;
    const announce = () => {
      if (announced || !l.authUrl) return;
      announced = true;
      input.onEvent({ kind: "notice", text: `Sign in to ${config.label}: open this link and approve access.\n${l.authUrl}` });
    };
    const timer = setInterval(announce, 200);
    let cleanup = () => {};
    const timedOut = new Promise<boolean>((resolve) => {
      const to = setTimeout(() => resolve(false), ACP_AUTH_TIMEOUT_MS);
      const onAbort = () => resolve(false);
      input.signal.addEventListener("abort", onAbort, { once: true });
      // Removed whichever way the race ends, so a turn never leaks a listener.
      cleanup = () => {
        clearTimeout(to);
        input.signal.removeEventListener("abort", onAbort);
      };
    });
    const authenticated = l.conn
      .request("authenticate", { methodId: auth.id })
      .then(() => true)
      .catch(() => false);
    const finish = await Promise.race([authenticated, timedOut]);
    cleanup();
    clearInterval(timer);
    // The link can land just before authenticate returns: flush it once more.
    announce();
    if (!finish) {
      input.onEvent({
        kind: "error",
        message: l.authUrl
          ? `${config.label} isn't signed in. Open this link to sign in, then send again:\n${l.authUrl}`
          : `${config.label} isn't signed in, and no sign-in link arrived. Run "${config.command}" once in a terminal to sign in.`,
      });
    }
    return finish;
  };

  const openSession = async (l: Live, input: TurnInput) => {
    const caps = l.init.agentCapabilities;
    const { servers: mcpServers, routedUsers } = await mcpServersFor(l, input);
    // Routed servers aren't sent, but their names+specs still take part in change
    // detection (a stableStringify-clean array of pairs), so editing one mid-thread
    // reopens the session and the notice can name it.
    const signature = JSON.stringify([mcpServers, routedUsers.map((s) => [s.name, s.spec])]);
    const byName = Object.fromEntries([...mcpServers.map((m) => [m.name, m]), ...routedUsers.map((s) => [s.name, s.spec])]);
    // The thread asked for a fresh session (e.g. back to the agent's default model,
    // which can't be set in place) while one is still live: drop it, don't reuse it.
    if (l.sessionId && !input.sessionId) {
      if (caps?.sessionCapabilities?.close) await l.conn.request("session/close", { sessionId: l.sessionId }).catch(() => {});
      l.sessionId = null;
    }
    if (l.sessionId) {
      // The MCP servers changed mid-conversation (the user opened the
      // browser, or edited their servers): reopen the same session with them.
      if (signature === l.mcpSignature) return;
      const canReopen = Boolean(caps?.sessionCapabilities?.resume && caps.sessionCapabilities.close);
      const notice = mcpChangeNotice(l.mcpByName, byName, canReopen, config.label);
      if (notice) input.onEvent({ kind: "notice", text: notice });
      l.mcpSignature = signature;
      l.mcpByName = byName;
      if (!canReopen) return;
      await l.conn.request("session/close", { sessionId: l.sessionId }).catch(() => {});
      const res = await l.conn.request<{ configOptions?: ConfigOption[]; modes?: SessionModeState | null }>("session/resume", { cwd: input.cwd, mcpServers, sessionId: l.sessionId });
      if (res?.configOptions) {
        l.configOptions = res.configOptions;
        rememberConfig(l.configOptions, l.threadKey);
      }
      rememberModes(l, res?.modes);
      input.onSessionRebuilt?.();
      return;
    }
    const params = { cwd: input.cwd, mcpServers };
    l.mcpSignature = signature;
    l.mcpByName = byName;
    let reason: string | null = null;
    if (input.sessionId && caps?.sessionCapabilities?.resume) {
      try {
        const res = await l.conn.request<{ configOptions?: ConfigOption[]; modes?: SessionModeState | null }>("session/resume", { ...params, sessionId: input.sessionId });
        l.sessionId = input.sessionId;
        l.configOptions = res?.configOptions ?? [];
        rememberConfig(l.configOptions, l.threadKey);
        rememberModes(l, res?.modes);
        return;
      } catch (err) {
        // fall through to a new session
        reason = err instanceof Error ? err.message : String(err);
      }
    } else if (input.sessionId && caps?.loadSession) {
      try {
        const res = await l.conn.request<{ configOptions?: ConfigOption[]; modes?: SessionModeState | null }>("session/load", { ...params, sessionId: input.sessionId });
        l.sessionId = input.sessionId;
        l.configOptions = res?.configOptions ?? [];
        rememberConfig(l.configOptions, l.threadKey);
        rememberModes(l, res?.modes);
        return;
      } catch (err) {
        // fall through
        reason = err instanceof Error ? err.message : String(err);
      }
    }
    let seed: SessionSeed | null = null;
    if (input.sessionId) {
      if (!reason) reason = "this agent can't reopen saved sessions";
      if (input.onSessionLost) seed = await input.onSessionLost(reason);
      else input.onEvent({ kind: "notice", text: `${config.label} couldn't resume the earlier conversation (${reason}); this is a fresh session.` });
    }
    let res: { sessionId: string; configOptions?: ConfigOption[]; modes?: SessionModeState | null };
    try {
      res = await l.conn.request<{ sessionId: string; configOptions?: ConfigOption[]; modes?: SessionModeState | null }>("session/new", params);
    } catch (err) {
      // A profile that is signed out answers -32000. Signing in is a browser
      // flow, so it happens only here, never proactively.
      const needsAuth = err instanceof RpcError && (err.code === -32000 || /auth/i.test(err.message));
      if (!needsAuth || !(await signIn(l, input))) throw err;
      res = await l.conn.request<{ sessionId: string; configOptions?: ConfigOption[]; modes?: SessionModeState | null }>("session/new", params);
    }
    l.sessionId = res.sessionId;
    l.configOptions = res.configOptions ?? [];
    rememberConfig(l.configOptions, l.threadKey);
    rememberModes(l, res.modes);
    l.guidePending = true;
    l.historyPending = seed && "promptPrefix" in seed ? seed.promptPrefix : null;
  };

  const applyModel = async (l: Live, model: string) => {
    if (model === DEFAULT_MODEL) return;
    const opt = l.configOptions.find((o) => o.category === "model" && o.type === "select");
    if (!opt || opt.currentValue === model) return;
    const res = await l.conn.request<{ configOptions?: ConfigOption[] }>("session/set_config_option", {
      sessionId: l.sessionId,
      configId: opt.id,
      value: model,
    });
    if (res?.configOptions) {
      l.configOptions = res.configOptions;
      rememberConfig(l.configOptions, l.threadKey);
    }
  };

  /** Set the session's thought level, when the agent has one and it differs. */
  const applyEffort = async (l: Live, effort: string) => {
    const opt = l.configOptions.find((o) => o.category === "thought_level" && o.type === "select");
    if (!opt || opt.currentValue === effort) return;
    const res = await l.conn.request<{ configOptions?: ConfigOption[] }>("session/set_config_option", {
      sessionId: l.sessionId,
      configId: opt.id,
      value: effort,
    });
    if (res?.configOptions) {
      l.configOptions = res.configOptions;
      rememberConfig(l.configOptions, l.threadKey);
    }
  };

  let refreshing: Promise<void> | null = null;
  const refreshModels = (opts?: { force?: boolean }): Promise<void> => {
    const ready = ensureVariants();
    // Re-list once the current list is stale, so a model released while the
    // app stays open shows up without a restart. force skips the TTL (after a
    // provider or credential change).
    if (!opts?.force && knownModels.length && Date.now() - listedAt < MODEL_TTL_MS) return ready;
    // A forced refresh waits out the run already in flight, then runs once more.
    if (opts?.force && refreshing) return refreshing.then(() => refreshModels({ force: true }));
    // Checked outside the memoized refresh, so a fixed provider refreshes next time.
    // The turn surfaces the error; there's no process to start.
    const plan = deps.injection?.();
    if (plan?.error) return ready;
    refreshing ??= (async () => {
      // One throwaway process: initialize + session/new, read the model
      // config option, then exit. Real threads spawn their own later.
      await ready;
      const { command, args } = await launch();
      const shaped = cliMajor !== null ? deps.injection?.({ major: cliMajor }) : plan;
      const env: NodeJS.ProcessEnv = { ...(shaped?.env ?? plan?.env ?? process.env), ...config.env };
      if (config.skillsDirEnv && deps.skillsDir) {
        const dir = deps.skillsDir();
        if (dir) env[config.skillsDirEnv] = dir;
      }
      const cwd = homedir();
      const conn = StdioRpc.spawn(command, args, { cwd, env }, {
        onNotification: () => {},
        onRequest: async (method) => {
          throw new RpcError(-32601, `${method} is not supported during model refresh`);
        },
      });
      try {
        const init = await conn.request<InitializeResult>("initialize", {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: "cubiq", version: deps.clientVersion },
        });
        applyInitialize(init);
        // No proactive authenticate here either: a valid profile's session/new
        // refreshes the token silently, and a signed-out one just fails below,
        // leaving the list empty until the first real turn signs in.
        const res = await conn.request<{ configOptions?: ConfigOption[] }>("session/new", { cwd, mcpServers: [] });
        rememberConfig(res.configOptions);
        if (knownModels.length) listedAt = Date.now();
      } catch {
        // Leave the list alone; the first turn will fill it in.
      } finally {
        conn.close();
        refreshing = null;
      }
    })();
    return refreshing;
  };

  return {
    id: config.id,
    label: config.label,
    defaultModel: DEFAULT_MODEL,
    get capabilities() {
      return capabilities;
    },
    get skillsDelivery() {
      return capabilities.skillsDelivery;
    },
    // An env-only provider setting is unverified, so its row stays hidden.
    credentials: { byok: !config.providerEnvOnly, own: "config", injector: config.injector ?? "acp" },
    ...(config.unsupported ? { unsupported: config.unsupported } : {}),
    skillCallPrefix: "",
    /** The CLI copy a bare command resolves to at spawn time, and the others found. */
    ...(bare ? { binary: () => binaryInfo(config.command) ?? undefined } : {}),
    models: () => {
      // OpenCode's levels are per-model variants, not a session thought_level option.
      if (viaVariants()) {
        const withVariants = (m: ModelOption): ModelOption => (knownVariants[m.id]?.length ? { ...m, efforts: knownVariants[m.id] } : m);
        const current = modelFrom(lastConfigOptions);
        const defaultOption: ModelOption = { id: DEFAULT_MODEL, label: "Agent default" };
        if (current && knownVariants[current]?.length) defaultOption.efforts = knownVariants[current];
        return [defaultOption, ...knownModels.map(withVariants)];
      }
      // One thought-level list per session: every model of the agent carries it.
      const withEfforts = (m: ModelOption): ModelOption => (knownEfforts.length ? { ...m, efforts: knownEfforts } : m);
      return [withEfforts({ id: DEFAULT_MODEL, label: "Agent default" }), ...knownModels.map(withEfforts)];
    },
    refreshModels,
    // session/set_config_option on the model option switches in place;
    // applyModel skips the default, so going back to it needs a new session.
    setModel: async ({ to }) => (to === DEFAULT_MODEL ? "new-session" : "in-place"),
    /**
     * One hidden prompt in a throwaway process (the refreshModels shape), for
     * background work (memory extraction): no tools, no session reuse, and the
     * process is closed as soon as the prompt's response lands.
     */
    async oneShot(req) {
      await ensureVariants();
      const plan = deps.injection?.(cliMajor !== null ? { major: cliMajor } : undefined);
      if (plan?.error) throw new Error(plan.error);
      const env: NodeJS.ProcessEnv = { ...(plan?.env ?? process.env), ...config.env };
      if (config.skillsDirEnv && deps.skillsDir) {
        const dir = deps.skillsDir();
        if (dir) env[config.skillsDirEnv] = dir;
      }
      const cwd = join(tmpdir(), "cubiq-oneshot");
      mkdirSync(cwd, { recursive: true });
      let text = "";
      let sessionId = "";
      const { command, args } = await launch();
      const conn = StdioRpc.spawn(command, args, { cwd, env }, {
        onNotification: (method, params) => {
          if (method !== "session/update") return;
          const update = (params as { update: SessionUpdate }).update;
          if (update.sessionUpdate !== "agent_message_chunk") return;
          const content = (update as { content?: { type?: string; text?: string } }).content;
          if (content?.type === "text" && content.text) text += content.text;
        },
        onRequest: async (method, params) => {
          if (method !== "session/request_permission") throw new RpcError(-32601, `${method} is not supported by this client`);
          const options = (params as { options?: PermissionOption[] }).options ?? [];
          const reject = options.find((o) => o.kind === "reject_once");
          return reject ? { outcome: { outcome: "selected", optionId: reject.optionId } } : { outcome: { outcome: "cancelled" } };
        },
      });
      const onAbort = () => {
        if (sessionId) conn.notify("session/cancel", { sessionId });
      };
      req.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const init = await conn.request<InitializeResult>("initialize", {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: "cubiq", version: deps.clientVersion },
        });
        applyInitialize(init);
        const res = await conn.request<{ sessionId: string; configOptions?: ConfigOption[] }>("session/new", { cwd, mcpServers: [] });
        sessionId = res.sessionId;
        const model = (res.configOptions ?? []).find((o) => o.category === "model" && o.type === "select");
        if (req.model && model) {
          // A model the session can't switch to just leaves its default; extraction is best-effort.
          await conn.request("session/set_config_option", { sessionId, configId: model.id, value: req.model }).catch(() => {});
        }
        await conn.request("session/prompt", { sessionId, prompt: [{ type: "text", text: req.prompt }] });
        return text.trim();
      } finally {
        req.signal?.removeEventListener("abort", onAbort);
        conn.close();
      }
    },
    async runTurn(input) {
      const key = input.threadId;
      let l: Live;
      try {
        l = await onceMoreIfLocked(() => connect(key, input));
        const live = l;
        await onceMoreIfLocked(() => openSession(live, input));
        rememberConfig(l.configOptions, l.threadKey);
        input.onSession(l.sessionId!);
        await applyModel(l, input.model);
        if (input.effort) await applyEffort(l, input.effort);
      } catch (err) {
        input.onEvent({ kind: "error", message: `${config.label} failed to start: ${err instanceof Error ? err.message : String(err)}` });
        live.get(key)?.conn.close();
        live.delete(key);
        return;
      }
      clearTimeout(l.idleTimer);
      const started = Date.now();
      const onAbort = () => l.conn.notify("session/cancel", { sessionId: l.sessionId });
      input.signal.addEventListener("abort", onAbort, { once: true });
      // A new session's first prompt carries the harness guide and, when the
      // earlier session was lost, the seed's history prefix; only then are they dropped.
      const g = l.guidePending ? deps.guide?.(input.cwd, input.design) ?? "" : "";
      const e = l.guidePending ? input.expert ?? "" : "";
      const m = l.guidePending && input.projectId ? deps.memory?.(input.projectId, input.threadId, null) ?? "" : "";
      const fresh = l.guidePending;
      // Code mode (when run_code is attached, and the agent has no Code Mode of its own): one fixed line inside the guide.
      const hint = g && (deps.codeMode?.(input.threadId) ?? "off") !== "off" && !hasOwnCodeMode(l.init) && Boolean(l.init.agentCapabilities?.mcpCapabilities?.http) && input.tools.length > 0 && !!deps.toolServer ? CODE_HINT : "";
      // Warm the extensions estimate (MCP tool listings) so the breakdown at the end of this turn has it.
      if (fresh) deps.extensions?.(input.cwd, input.projectId ?? null);
      if (g || e || m) l.guidePending = false;
      const h = l.historyPending;
      l.historyPending = null;
      const lead = [
        ...(g ? [{ type: "text", text: `<harness-guide>\n${g}${hint ? `\n\n${hint}` : ""}\n</harness-guide>` }] : []),
        ...(e ? [{ type: "text", text: e }] : []),
        ...(m ? [{ type: "text", text: m }] : []),
        ...(h ? [{ type: "text", text: `${h}\n---` }] : []),
      ];
      let current: TurnState | null = null;
      let lastUsage = normalizeUsage({ inputTokens: 0, outputTokens: 0, provenance: "unavailable" });
      let lastCost: number | null = null;
      let lastContextUsed: number | null = null;
      try {
        // The user may have aborted while the agent was still starting up; the
        // listener above missed it, so stop before sending the prompt.
        if (input.signal.aborted) {
          input.onEvent({ kind: "notice", text: "Stopped." });
          return;
        }
        // /compact runs the agent's own compact command, only when it advertises one.
        if (input.compact) {
          // The command list arrives as an update right after the session opens; give it a moment.
          for (let i = 0; i < 10 && l.commands === undefined; i++) await new Promise((r) => setTimeout(r, 100));
          // An advertised command wins; a preset that declares manualCompact takes a bare "/compact".
          const name = l.commands?.find((c) => c === "compact" || c === "summarize") ?? (capabilities.manualCompact ? "compact" : undefined);
          if (!name) {
            input.onEvent({ kind: "notice", text: `${config.label} doesn't offer a compact command in this session.` });
            return;
          }
          input.onEvent({ kind: "turn-start", turnId: randomUUID(), agent: config.id, model: input.model });
          const turn: TurnState = { input, text: "", thought: "", tools: new Map(), permissionIds: new Set(), planned: false, usage: { used: 0, costUsd: null, contextUsed: null, size: null }, run: 0, logErrors: new Set(), askIds: new Set(), askTimers: new Map() };
          if (l.turn) clearAskTimers(l.turn);
          current = turn;
          l.turn = turn;
          l.approvedCalls.clear();
          const res = await l.conn.request<{ stopReason: string }>("session/prompt", {
            sessionId: l.sessionId,
            prompt: [{ type: "text", text: `/${name}${input.compact.focus ? ` ${input.compact.focus}` : ""}` }],
          });
          // The summary is the agent's own working note, not a reply to show.
          turn.text = "";
          turn.thought = "";
          if (res.stopReason === "cancelled") input.onEvent({ kind: "notice", text: "Stopped." });
          else input.onEvent({ kind: "compaction", trigger: "manual", preTokens: null, postTokens: null });
          input.onEvent({ kind: "turn-end", costUsd: null, inputTokens: 0, outputTokens: 0, durationMs: Date.now() - started });
          return;
        }
        input.onEvent({ kind: "turn-start", turnId: randomUUID(), agent: config.id, model: input.model });
        // A plan round hands its proposal to the user; their answer either
        // switches to an implementing round or asks for a refined plan.
        let mode: PermissionMode = input.permissionMode;
        let prompt = input.prompt;
        for (let round = 0; round < 6; round++) {
          // A Stop between rounds must end the run, never start another round.
          if (round > 0 && input.signal.aborted) break;
          // An approved plan's implementing round runs in Ask or Auto-edit: its asks are decided by that mode.
          const roundInput = mode === input.permissionMode ? input : { ...input, permissionMode: mode };
          const turn: TurnState = { input: roundInput, text: "", thought: "", tools: new Map(), permissionIds: new Set(), planned: false, usage: { used: 0, costUsd: null, contextUsed: null, size: null }, run: 0, logErrors: new Set(), askIds: new Set(), askTimers: new Map() };
          if (l.turn) clearAskTimers(l.turn);
          current = turn;
          l.turn = turn;
          l.approvedCalls.clear();
          let stopped = false;
          // A native plan mode switches the whole session; without one the
          // prompt carries the plan-mode brief instead.
          const nativePlan = await applyPlanMode(l, input, mode);
          // A native plan mode has its own brief; it only needs to learn that ask_user exists.
          const prefix = mode !== "plan" ? "" : !nativePlan ? PLAN_MODE_PREFIX : l.askUser ? PLAN_MODE_HINT : "";
          const res = await l.conn.request<{
            stopReason: string;
            usage?: { inputTokens?: number; outputTokens?: number; cachedReadTokens?: number; cachedWriteTokens?: number } | null;
          }>("session/prompt", {
            sessionId: l.sessionId,
            prompt: [...(round === 0 ? lead : []), { type: "text", text: prefix + prompt }],
          });
          // Whether the turn produced anything visible; flushText clears the
          // buffers this reads, so decide before flushing.
          const empty = !turn.text.trim() && !turn.thought.trim() && turn.tools.size === 0 && !turn.planned;
          const planText = mode === "plan" ? turn.text.trim() : "";
          flushText(turn);
          if (res.stopReason === "cancelled") {
            input.onEvent({ kind: "notice", text: "Stopped." });
            stopped = true;
          } else if (res.stopReason === "refusal") input.onEvent({ kind: "error", message: `${config.label} declined this request.` });
          else if (res.stopReason === "max_tokens" || res.stopReason === "max_turn_requests") {
            input.onEvent({ kind: "notice", text: `${config.label} stopped early (${res.stopReason.replace(/_/g, " ")}).` });
          }
          // A prompt that resolves with no text, no tool call and no usage is how a
          // provider that needs a subscription, a key or a login fails quietly;
          // name it rather than letting the turn end silently.
          const tokens = (res.usage?.inputTokens ?? 0) + (res.usage?.outputTokens ?? 0);
          if (empty && tokens === 0 && res.stopReason !== "cancelled") {
            input.onEvent({
              kind: "error",
              message: `${config.label} returned nothing for ${input.model === DEFAULT_MODEL ? "its default model" : input.model}. The model's provider may need a subscription, a key, or a login — try another model.${l.conn.stderrHint()}`,
            });
          }
          // `usage_update.used` is context-window occupancy, not per-turn input:
          // only the prompt response's usage is a real input count.
          lastUsage = {
            ...(res.usage
              ? normalizeUsage({
                  inputTokens: res.usage.inputTokens ?? 0,
                  outputTokens: res.usage.outputTokens ?? 0,
                  cacheReadTokens: res.usage.cachedReadTokens ?? null,
                  cacheWriteTokens: res.usage.cachedWriteTokens ?? null,
                  provenance: "reported",
                })
              : normalizeUsage({ inputTokens: 0, outputTokens: 0, provenance: "unavailable" })),
            contextUsed: turn.usage.contextUsed,
            contextSize: turn.usage.size,
          };
          lastCost = turn.usage.costUsd;
          lastContextUsed = turn.usage.contextUsed;
          if (mode === "plan" && res.stopReason === "end_turn" && planText && !input.signal.aborted) {
            const d = await input.requestPlanDecision({ plan: planText });
            // Stop while the plan card was up: the abort resolves the decision as
            // { keep: "" }, which must not be read as "keep planning".
            if (input.signal.aborted) {
              if (!stopped) input.onEvent({ kind: "notice", text: "Stopped." });
              break;
            }
            if (d === "auto" || d === "manual") {
              mode = d === "auto" ? "auto-edit" : "ask";
              prompt = "Implement the plan.";
            } else {
              prompt = d.keep.trim() || "Refine the plan.";
            }
            continue;
          }
          break;
        }
        // OpenCode's prompt usage is its last model call only; the export sums
        // every call this turn made (any failure keeps the reported numbers).
        if (config.turnUsageVia === "opencode-export" && l.sessionId) {
          const sum = await exportTurnUsage({ command: l.command, env: l.env, sessionId: l.sessionId, sinceMs: started, major: cliMajor });
          if (sum) lastUsage = { ...normalizeUsage({ inputTokens: sum.input, outputTokens: sum.output, reasoningTokens: sum.reasoning, cacheReadTokens: sum.cacheRead, cacheWriteTokens: sum.cacheWrite, provenance: "reported" }), contextUsed: lastUsage.contextUsed, contextSize: lastUsage.contextSize };
        }
        if (fresh) {
          const serializedTools = (() => {
            try {
              return JSON.stringify(input.tools.map((t) => ({ name: t.name, description: t.description, schema: t.input })));
            } catch {
              // A schema that won't stringify is rare; the names and descriptions still explain the cost.
              return JSON.stringify(input.tools.map((t) => ({ name: t.name, description: t.description })));
            }
          })();
          const ext = deps.extensions?.(input.cwd, input.projectId ?? null);
          const rows = [
            { label: "Harness tools", tokens: Math.ceil(serializedTools.length / 4) },
            { label: "Harness guide", tokens: Math.ceil(g.length / 4) },
            { label: "Memory index", tokens: Math.ceil(m.length / 4) },
            { label: "Skills", tokens: ext?.skills ?? 0 },
            { label: "MCP tools", tokens: ext?.mcp ?? 0 },
          ]
            .filter((r) => r.tokens > 0)
            .sort((a, b) => b.tokens - a.tokens);
          if (rows.length) input.onEvent({ kind: "context-breakdown", rows, total: lastContextUsed, estimated: true });
        }
        // One turn-end for the whole runTurn, on the last round's usage.
        input.onEvent({
          kind: "turn-end",
          costUsd: lastCost,
          inputTokens: lastUsage.inputTokens,
          outputTokens: lastUsage.outputTokens,
          durationMs: Date.now() - started,
          usage: lastUsage,
        });
      } catch (err) {
        if (current) flushText(current);
        input.onEvent({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
        input.signal.removeEventListener("abort", onAbort);
        if (current) clearAskTimers(current);
        l.turn = null;
        l.idleTimer = setTimeout(() => {
          l.conn.close();
          live.delete(key);
        }, IDLE_MS);
        l.idleTimer.unref?.();
      }
    },
    dispose() {
      for (const l of live.values()) l.conn.close();
      live.clear();
      void askServer?.then((s) => s.close()).catch(() => {});
      askServer = null;
    },
  };
}

/**
 * A tool call's one-line summary. OpenCode titles a call with its tool's name
 * ("bash", "edit"), so a command or an edited file wins over the title.
 */
export function toolSummary(u: ToolCallFields, command: string | undefined): string {
  if (u.kind === "execute" && command) return clipSummary(command);
  if (u.kind === "edit") {
    const raw = u.rawInput as { filePath?: unknown; file_path?: unknown; path?: unknown } | null | undefined;
    const path = u.locations?.[0]?.path ?? [raw?.filePath, raw?.file_path, raw?.path].find((p): p is string => typeof p === "string");
    if (path) return clipSummary(path);
  }
  return clipSummary(u.title ?? "");
}

/**
 * A call to the harness's own MCP server (`cubiq`), which ACP agents title
 * with the server prefix and no kind (OpenCode: "cubiq_browser_open"): named
 * like Claude's rows (browser_open, skill), summarised by its main argument.
 * Stored threads still carry the old "unskilled" titles, accepted too.
 */
/** A rawInput worth waiting for: anything but null or an empty object. */
function hasInput(raw: unknown): boolean {
  return raw !== null && raw !== undefined && !(typeof raw === "object" && Object.keys(raw as object).length === 0);
}

/** An OpenCode v2 Code Mode call's script (its `execute` tool, kind other, input `{ code }`), or null for any other call. */
export function codeModeScript(u: Pick<ToolCallFields, "title" | "kind" | "rawInput">): string | null {
  if (u.title !== "execute" || (u.kind && u.kind !== "other")) return null;
  const code = (u.rawInput as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : null;
}

/** The calls a Code Mode script made, from its rawOutput's `metadata.toolCalls` (OpenCode v2), in order. */
export function scriptSteps(rawOutput: unknown): { tool: string; status: string; input?: unknown }[] {
  const calls = rawOutputOf(rawOutputOf(rawOutput)?.metadata)?.toolCalls;
  if (!Array.isArray(calls)) return [];
  return calls
    .map((c) => rawOutputOf(c))
    .filter((c): c is Record<string, unknown> => typeof c?.tool === "string")
    .map((c) => ({ tool: c.tool as string, status: typeof c.status === "string" ? c.status : "completed", input: c.input }));
}

/** A script call's row name: OpenCode's own and CubiQ's tools bare ("read"), another server's "server · tool". */
export function scriptStepName(tool: string): string {
  const dot = tool.indexOf(".");
  if (dot < 0) return tool;
  const server = tool.slice(0, dot);
  const name = tool.slice(dot + 1);
  return server === "opencode" || server === TOOL_SERVER_NAME ? name : `${server} · ${name}`;
}

/** A script call's summary: its main string argument, else its input as one line. */
export function scriptStepSummary(input: unknown): string {
  if (!hasInput(input) || typeof input !== "object") return "";
  const raw = input as Record<string, unknown>;
  const arg = ["filePath", "path", "pattern", "query", "url", "command", "name"].map((k) => raw[k]).find((v): v is string => typeof v === "string");
  return clipSummary(arg ?? JSON.stringify(input));
}

export function harnessTool(u: Pick<ToolCallFields, "title" | "kind" | "rawInput">): { name: string; summary: string } | null {
  const m = /^(?:mcp__)?(?:cubiq|unskilled)(?:__|[_:.])([a-z][a-z0-9_]*)$/i.exec(u.title ?? "");
  if (!m || (u.kind && u.kind !== "other")) return null;
  const raw = (u.rawInput ?? {}) as Record<string, unknown>;
  const arg = ["url", "ref", "text", "expression", "name", "code"].map((k) => raw[k]).find((v): v is string => typeof v === "string");
  return { name: m[1]!, summary: arg ? clipSummary(arg) : "" };
}

export function kindLabel(kind: ToolKind | null | undefined): string {
  switch (kind) {
    case "read":
      return "Read";
    case "edit":
      return "Edit";
    case "delete":
      return "Delete";
    case "move":
      return "Move";
    case "search":
      return "Search";
    case "execute":
      return "Run";
    case "think":
      return "Think";
    case "fetch":
      return "Fetch";
    default:
      return "Tool";
  }
}

/** Diff items in a tool call's content, as canonical ToolDiffs. */
export function diffContent(content: ToolCallFields["content"] | null | undefined): { diff: ToolDiff[] } | null {
  const diffs: ToolDiff[] = [];
  for (const item of content ?? []) {
    if (item.type !== "diff") continue;
    const d = item as { type: "diff"; path?: string; oldText?: string | null; newText?: string | null };
    if (typeof d.path !== "string") continue;
    diffs.push({ path: d.path, unified: unifiedDiff(d.path, d.oldText ?? "", d.newText ?? "") });
  }
  return diffs.length ? { diff: diffs } : null;
}

/**
 * The tool-use payload for a call: the Run command for an execute, the write's
 * diff for an OpenCode write (filePath + content, no oldString), and otherwise
 * the remembered raw input when there is any. Undefined keeps the event bare.
 */
export function toolUsePayload(kind: ToolKind | null | undefined, rawInput: unknown, command: string): unknown | undefined {
  if (kind === "execute") return { command } satisfies RunPayload;
  const raw = rawInput as Record<string, unknown> | null | undefined;
  if (kind === "edit" && typeof raw?.filePath === "string" && typeof raw.content === "string" && typeof raw.oldString !== "string") {
    return { ...raw, diff: [{ path: raw.filePath, unified: unifiedDiff(raw.filePath, "", raw.content) }] };
  }
  return hasInput(rawInput) ? rawInput : undefined;
}

/** A subagent call's summary: what it was asked to find, and by which agent kind. */
function subagentSummary(raw: Record<string, unknown>, title: string | null | undefined): string {
  const description = typeof raw.description === "string" ? raw.description : title ?? "";
  return clipAgentSummary(description, raw.subagent_type as string);
}

/**
 * A todowrite's `todos` as canonical plan entries, or null when the input is
 * not one.
 */
export function planEntriesFromTodos(raw: unknown): PlanEntry[] | null {
  if (!raw || typeof raw !== "object") return null;
  return normalizePlan((raw as { todos?: unknown }).todos);
}

/** The text inside a `<task_result>…</task_result>` wrapper, or the whole output when there is none. */
export function taskResultText(output: string): string {
  const m = /<task_result>([\s\S]*?)<\/task_result>/.exec(output);
  return (m ? m[1]! : output).trim();
}

/** A tool call's rawOutput object, as far as this driver reads it. */
function rawOutputOf(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

/** The first non-empty string among a rawOutput object's fields, or "". */
function firstString(raw: Record<string, unknown> | null, keys: string[]): string {
  for (const key of keys) {
    const v = raw?.[key];
    if (typeof v === "string" && v) return v;
  }
  return "";
}

/** The first number among a rawOutput object's fields, or null. */
function firstNumber(raw: Record<string, unknown> | null, keys: string[]): number | null {
  for (const key of keys) {
    const v = raw?.[key];
    if (typeof v === "number") return v;
  }
  return null;
}

/** A rawOutput's `output` text, or "" when it isn't a non-empty string. */
function outputText(v: unknown): string {
  const o = rawOutputOf(v);
  return typeof o?.output === "string" ? o.output : "";
}

/** Whether a remembered call is a subagent (OpenCode's think task). */
function isSubagent(tool: { kind?: ToolKind | null; rawInput?: unknown } | null | undefined): boolean {
  if (!tool || tool.kind !== "think") return false;
  const raw = tool.rawInput as { subagent_type?: unknown } | null | undefined;
  return typeof raw?.subagent_type === "string";
}

/** The canonical tool-result payload for a terminal tool_call update, or null when there is none. */
export function resultPayload(
  u: ToolCallFields,
  text: string,
  tool?: { kind?: ToolKind | null; rawInput?: unknown; payload?: unknown; rawOutput?: unknown },
): unknown | null {
  const diffs = diffContent(u.content);
  if (diffs) return diffs;
  // Google's Antigravity sends no content for a command: the output and exit
  // code ride on rawOutput instead (combinedOutput/formatted_output/output).
  if (u.kind === "execute") {
    const raw = rawOutputOf(u.rawOutput ?? tool?.rawOutput);
    const output = text || firstString(raw, ["combinedOutput", "formatted_output", "output"]);
    const exitCode = firstNumber(raw, ["exitCode", "exit_code"]);
    return { exitCode, output } satisfies RunResult;
  }
  // A write's tool-use payload carried its diff; the completed result repeats it.
  const carried = tool?.payload && typeof tool.payload === "object" && "diff" in (tool.payload as object) ? (tool.payload as EditResult).diff : null;
  if (carried && u.status === "completed") return { diff: carried };
  const rawOutput = rawOutputOf(u.rawOutput ?? tool?.rawOutput);
  const output = typeof rawOutput?.output === "string" ? rawOutput.output : "";
  // A subagent's output is the task envelope; its payload is the text inside it.
  if (isSubagent({ kind: u.kind ?? tool?.kind, rawInput: tool?.rawInput })) {
    const inner = taskResultText(output);
    if (inner) return inner;
  }
  if (output) return output;
  const error = typeof rawOutput?.error === "string" ? rawOutput.error : "";
  if (error) return error;
  return text || null;
}

/** The spawn args for a CLI at `major`: the newest `argsByMajor` entry at or below it, else `args`. */
export function argsFor(config: Pick<AcpAgentConfig, "args" | "argsByMajor">, major: number | null): string[] {
  if (major === null || !config.argsByMajor) return config.args;
  const keys = Object.keys(config.argsByMajor)
    .map(Number)
    .filter((k) => Number.isFinite(k) && k <= major)
    .sort((a, b) => b - a);
  return keys.length ? config.argsByMajor[String(keys[0])]! : config.args;
}
