import type { McpServerEntry, ModelOption, PermissionDecision, PermissionMode, ThreadEvent } from "../../shared/types";
import type { RunPayload, RunResult, ToolDiff } from "../../shared/tools";
import { clipSummary } from "../../shared/tools";
import { diffSummary } from "../../shared/diff";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { forCodex, mcpChangeNotice } from "../mcp/servers";
import { withProject } from "../mcp-http";
import { normalizeUsage } from "../usage";
import type { InjectionPlan } from "../inject";
import { RpcError, StdioRpc } from "./rpc";
import { CODEX_CAPABILITIES } from "./capabilities";
import { codexLimitsPatch, codexReadPatch, type CodexRateLimits, type CodexRateLimitsRead, type LimitsListener, type LimitsPatch } from "./limits";
import { checkCommand } from "../guard";
import { summarizeToolInput, summarizeToolResult } from "./summarize";
import { MODEL_TTL_MS } from "./model-ttl";
import { binaryInfo, resolvedCommandAsync } from "./binaries";
import type { AgentDriver, HarnessTool, SessionSeed, TurnInput } from "./types";

// The slices of Codex's app-server protocol (`codex app-server generate-ts`) this driver uses.
type ThreadItem =
  | { type: "agentMessage"; id: string; text: string }
  | { type: "reasoning"; id: string; summary: string[]; content: string[] }
  | { type: "commandExecution"; id: string; command: string; status: string; aggregatedOutput: string | null; exitCode: number | null }
  | { type: "fileChange"; id: string; changes: { path: string; kind: unknown }[]; status: string }
  | {
      type: "mcpToolCall";
      id: string;
      server: string;
      tool: string;
      status: string;
      arguments?: unknown;
      result?: { content: unknown } | null;
      error?: { message: string } | null;
    }
  | { type: "webSearch"; id: string; query?: string }
  | { type: "plan"; id: string; text: string }
  // A parent thread's note that a subagent (a Codex child thread) started or ended.
  | { type: "subAgentActivity"; id: string; kind: "started" | "interacted" | "interrupted" | "completed"; agentThreadId: string; agentPath: string }
  | {
      type: "collabAgentToolCall";
      id: string;
      tool: string;
      status: string;
      senderThreadId: string;
      receiverThreadIds: string[];
      prompt: string | null;
      model: string | null;
      agentsStates: Record<string, { status: string; message?: string | null }>;
    }
  | { type: string; id: string };
interface Turn {
  id: string;
  status: "completed" | "interrupted" | "failed" | "inProgress";
  error: { message: string } | null;
  durationMs: number | null;
}
interface TokenBreakdown {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  cacheWriteInputTokens?: number;
  reasoningOutputTokens?: number;
  netNewInputTokens?: number;
}

export interface CodexConfig {
  command: string;
  args: string[];
  clientVersion: string;
  /** Model-invoked skills, registered as an extra skills root if present. */
  skillsDir?: () => string | null;
  /** The harness's tools over HTTP MCP (the browser pane's), attached per thread. */
  toolServer?: () => Promise<{ url: string; token: string }>;
  /** Plan rate limits, from the notifications Codex sends with its responses. */
  onLimits?: LimitsListener;
  /** The credential plan for the next app-server start; absent = inherit process.env (tests). */
  injection?: () => InjectionPlan;
  /** The BYOK provider's models, or null on subscription. */
  byokModels?: () => ModelOption[] | null;
  /** The git-guardrails script: command approvals are vetoed before the user is asked. */
  guardScript?: string;
  /** The harness guide for this turn's cwd, sent as developer instructions to Codex. */
  guide?: (cwd: string) => string;
  /** The skills listing and MCP tool schemas this project's new session carries, in estimated tokens (0 when deferred or not yet listed). */
  extensions?: (cwd: string, projectId: string | null) => { skills: number; mcp: number };
  /** The memory block for this project's new sessions (memoryPrompt output, may be ""), or null when CubiQ memory is off. */
  memory?: (projectId: string) => string | null;
}

/** The MCP server name the harness's tools go by, in Codex's config and its tool calls. */
export const CODEX_TOOL_SERVER = "cubiq";

/** Stored threads and agents that predate the rename still call the server "unskilled". */
const TOOL_SERVERS = new Set([CODEX_TOOL_SERVER, "unskilled"]);

export const CODEX_DEFAULT_MODEL = "default";

/** Ask / Auto-edit / Full as Codex approval policy and sandbox. */
export function codexPolicy(mode: PermissionMode): { approvalPolicy: string; sandbox: string } {
  switch (mode) {
    case "full":
      return { approvalPolicy: "never", sandbox: "danger-full-access" };
    case "auto-edit":
      return { approvalPolicy: "untrusted", sandbox: "workspace-write" };
    case "plan":
      // Investigation runs without asking, as in Claude's plan mode: the
      // read-only sandbox, not an approval prompt, is what stops writes.
      return { approvalPolicy: "never", sandbox: "read-only" };
    default:
      return { approvalPolicy: "untrusted", sandbox: "workspace-write" };
  }
}

/** Codex's per-turn sandbox policy, as the app-server schema spells it. */
type CodexSandboxPolicy =
  | { type: "dangerFullAccess" }
  | { type: "readOnly"; networkAccess: boolean }
  | { type: "workspaceWrite"; writableRoots: string[]; networkAccess: boolean; excludeTmpdirEnvVar: boolean; excludeSlashTmp: boolean };

/**
 * The sandbox each mode runs turns under. A plan-mode thread is started
 * read-only, so the implementing round must widen it back out.
 */
function sandboxPolicyFor(mode: PermissionMode): CodexSandboxPolicy {
  switch (mode) {
    case "plan":
      return { type: "readOnly", networkAccess: false };
    case "full":
      return { type: "dangerFullAccess" };
    default:
      return { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
  }
}

/** A pre-set collaboration mode for turn/start; null developer instructions mean the mode's built-in ones. */
interface CollaborationMode {
  mode: "plan" | "default";
  settings: { model: string; reasoning_effort: string | null; developer_instructions: string | null };
}

/** The text inside a final message's <proposed_plan>…</proposed_plan>, or null when it isn't wrapped that way. */
function proposedPlanText(text: string): string | null {
  const m = /<proposed_plan>([\s\S]*?)<\/proposed_plan>/.exec(text);
  return m ? m[1]!.trim() || null : null;
}

/** Who is logged in to Codex (mode, account, key hash), so a token refresh — which rewrites auth.json — is not mistaken for a new login. */
export function codexAuthStamp(env: NodeJS.ProcessEnv = process.env): string | null {
  const file = join(env.CODEX_HOME || join(homedir(), ".codex"), "auth.json");
  try {
    const auth = JSON.parse(readFileSync(file, "utf8")) as { auth_mode?: string; OPENAI_API_KEY?: string; tokens?: { account_id?: string } };
    const key = auth.OPENAI_API_KEY ? createHash("sha256").update(auth.OPENAI_API_KEY).digest("hex").slice(0, 12) : "";
    return `${auth.auth_mode ?? ""}|${auth.tokens?.account_id ?? ""}|${key}`;
  } catch {
    // Missing file is null; an unreadable/unparsable one falls back to its mtime so a change still counts.
    try {
      return String(statSync(file).mtimeMs);
    } catch {
      return null;
    }
  }
}

export function codexDecision(d: PermissionDecision): "accept" | "acceptForSession" | "decline" {
  return d === "allow-always" ? "acceptForSession" : d === "allow-once" ? "accept" : "decline";
}

/** A no-op TurnInput for a hidden one-shot turn: its events, deltas and prompts go nowhere. */
function stubInput(over: { threadId: string; cwd: string; prompt: string; model: string; signal: AbortSignal }): TurnInput {
  return {
    threadId: over.threadId,
    cwd: over.cwd,
    prompt: over.prompt,
    sessionId: null,
    model: over.model,
    permissionMode: "plan",
    signal: over.signal,
    tools: [],
    mcpServers: [],
    onEvent: () => {},
    onTextDelta: () => {},
    onSession: () => {},
    requestPermission: async () => "deny",
    requestPlanDecision: async () => ({ keep: "" }),
  };
}

/**
 * Codex reports OpenAI-style input that *includes* cached tokens, so the
 * top-level `inputTokens` is net-new only. `netNewInputTokens`, when the
 * server sends it, is authoritative over the subtraction.
 */
export function turnEndFromUsage(usage: TokenBreakdown | undefined, durationMs: number, contextSize?: number | null): ThreadEvent {
  if (!usage) {
    return {
      kind: "turn-end",
      costUsd: null,
      inputTokens: 0,
      outputTokens: 0,
      durationMs,
      usage: { ...normalizeUsage({ inputTokens: 0, outputTokens: 0, provenance: "unavailable" }), contextUsed: null, contextSize: null },
    };
  }
  const netNew = usage.netNewInputTokens ?? Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  return {
    kind: "turn-end",
    costUsd: null,
    inputTokens: netNew,
    outputTokens: usage.outputTokens,
    durationMs,
    usage: {
      ...normalizeUsage({
        inputTokens: netNew,
        outputTokens: usage.outputTokens,
        reasoningTokens: usage.reasoningOutputTokens ?? null,
        cacheReadTokens: usage.cachedInputTokens ?? null,
        cacheWriteTokens: usage.cacheWriteInputTokens ?? null,
      }),
      // The raw input (cached included) is what occupies the context window.
      contextUsed: usage.inputTokens,
      contextSize: contextSize ?? null,
    },
  };
}

/**
 * The thread config that attaches MCP servers: the user's (mcp.json) and,
 * once the browser is open, the harness's own tool server. Safe harness
 * tools run without asking; the rest ask in Ask mode, through an MCP
 * elicitation. Returns undefined when there's nothing to attach.
 */
export function codexToolConfig(
  server: { url: string; token: string } | null,
  tools: HarnessTool[],
  mode: PermissionMode,
  userServers: McpServerEntry[] = [],
): Record<string, unknown> | undefined {
  const mcp: Record<string, unknown> = forCodex(userServers);
  if (server && tools.length) {
    const ask = tools.filter((t) => !t.autoAllow && mode === "ask");
    mcp[CODEX_TOOL_SERVER] = {
      url: server.url,
      http_headers: { Authorization: `Bearer ${server.token}` },
      default_tools_approval_mode: "approve",
      tools: Object.fromEntries(ask.map((t) => [t.name, { approval_mode: "prompt" }])),
    };
  }
  return Object.keys(mcp).length ? { mcp_servers: mcp } : undefined;
}

interface Elicitation {
  threadId: string;
  serverName: string;
  message?: string;
  _meta?: { codex_approval_kind?: string; tool_params_display?: { name: string; display_name?: string; value: unknown }[] } | null;
}

interface TurnState {
  input: TurnInput;
  threadId: string;
  turnId: string | null;
  deltas: Map<string, string>;
  /** Verbatim reasoning text per itemId; never mixed into `deltas` (that flushes as assistant text). */
  reasoning: Map<string, string>;
  usage: TokenBreakdown | null;
  /** The model's context window from thread/tokenUsage/updated, or null. */
  contextSize: number | null;
  /** Retrying errors already shown this turn, so each shows once. */
  retrying: Set<string>;
  /** A compaction was already emitted this turn (both notification paths can fire). */
  compacted: boolean;
  /** The text of a completed plan item (or a <proposed_plan> fallback), for the user's decision. */
  planText: string | null;
  /** The latest completed agent message's text, so a wrapped plan can be recovered from it. */
  agentText: string;
  done: (turn: Turn) => void;
  /** Set on a subagent (Codex child thread) state: the root turn it hangs under. */
  parent?: TurnState;
  /** The Agent row this child's events hang under (its toolUseId). */
  rowId?: string;
}

/**
 * Codex through `codex app-server`: one app-server process for every thread
 * (it runs many at once), threads resumed by id from Codex's own history.
 */
export function createCodexDriver(config: CodexConfig): AgentDriver {
  let rpc: StdioRpc | null = null;
  let ready: Promise<void> | null = null;
  /** Codex's login file as it was when the running app-server started. */
  let authStamp: string | null = null;
  /** A replaced app-server's exit, while it's still under way. */
  let exiting: Promise<unknown> | null = null;
  let models: ModelOption[] = [];
  /** When the current model list was last fetched; 0 = never. */
  let listedAt = 0;
  const turns = new Map<string, TurnState>(); // by Codex thread id
  /** Codex child threads (subagents), by child thread id: their items hang under their Agent row. */
  const children = new Map<string, TurnState>();
  /** Agent rows already closed, so a duplicate completion emits one tool-result. */
  const closedRows = new Set<string>();
  /** spawnAgent rows whose child thread ids only arrive with item/completed. */
  const spawnWait = new Map<string, string>();
  /** Threads loaded in the running app-server, and the MCP config they were loaded with. */
  const loaded = new Map<string, string>();
  /** The memory block a new session first carried, frozen by Codex thread id (prompt-cache reads). */
  const frozenMemory = new Map<string, string>();
  /** MCP tools the user chose "always allow" for, by thread. */
  const alwaysAllowed = new Map<string, Set<string>>();
  /** configWarning summaries from the current app-server, reset at each start. */
  let startWarnings: string[] = [];

  const emitCompaction = (t: TurnState) => {
    if (t.compacted) return;
    t.compacted = true;
    t.input.onEvent({ kind: "compaction", trigger: "auto", preTokens: null, postTokens: null });
  };

  /** The turn state for a Codex thread id: a root thread's, or a subagent child's. */
  const stateFor = (id: string): TurnState | undefined => turns.get(id) ?? children.get(id);

  /** The last non-empty segment of a subagent's agentPath, e.g. "/root/multiply" -> "multiply". */
  const agentName = (agentPath: string | undefined): string => {
    const parts = (agentPath ?? "").split("/").filter(Boolean);
    return parts[parts.length - 1] ?? "subagent";
  };

  /**
   * Register a Codex child thread and emit the Agent row its items hang under.
   * The child's events go through the root's onEvent with this row's id as
   * parentId; its own approvals use the root's requestPermission.
   */
  const registerChild = (parent: TurnState, childThreadId: string, rowId: string, agent: { prompt: string; subagent: string }) => {
    const child: TurnState = {
      input: { ...parent.input, onEvent: (e) => parent.input.onEvent({ ...e, parentId: rowId }) },
      threadId: childThreadId,
      turnId: null,
      deltas: new Map(),
      reasoning: new Map(),
      usage: null,
      contextSize: null,
      retrying: new Set(),
      compacted: false,
      planText: null,
      agentText: "",
      done: () => {},
      parent,
      rowId,
    };
    children.set(childThreadId, child);
    // A spawnAgent call can name several children: its Agent row is emitted once.
    for (const other of children.values()) if (other !== child && other.rowId === rowId) return;
    parent.input.onEvent({ kind: "tool-use", toolUseId: rowId, name: "Agent", summary: clipSummary(agent.subagent), payload: { prompt: agent.prompt, subagent_type: agent.subagent } });
  };

  /** Close one Agent row once: its child thread ended with the given kind. */
  const closeChild = (parent: TurnState, childThreadId: string, interrupted: boolean) => {
    const child = children.get(childThreadId);
    if (!child) return;
    children.delete(childThreadId);
    if (!child.rowId || closedRows.has(child.rowId)) return;
    closedRows.add(child.rowId);
    parent.input.onEvent({
      kind: "tool-result",
      toolUseId: child.rowId,
      isError: interrupted,
      summary: clipSummary(child.agentText) || (interrupted ? "Interrupted" : "Done"),
    });
  };

  /** Close any Agent rows still open when a root turn ends. */
  const closeRootChildren = (root: TurnState, interrupted: boolean) => {
    for (const [childThreadId, child] of children) {
      if (child.parent !== root) continue;
      children.delete(childThreadId);
      if (!child.rowId || closedRows.has(child.rowId)) continue;
      closedRows.add(child.rowId);
      root.input.onEvent({ kind: "tool-result", toolUseId: child.rowId, isError: interrupted, summary: interrupted ? "Stopped" : "Done" });
    }
  };

  const onNotification = (method: string, params: unknown) => {
    if (method === "configWarning") {
      const w = params as { summary?: string; details?: string | null };
      startWarnings.push(`${w.summary ?? "config warning"}${w.details ? ": " + w.details : ""}`);
      return;
    }
    if (method === "account/rateLimits/updated") {
      // Account-wide, sent as responses come in; never asked for with account/rateLimits/read.
      config.onLimits?.(codexLimitsPatch((params as { rateLimits: CodexRateLimits }).rateLimits));
      return;
    }
    const p = params as {
      threadId?: string;
      turnId?: string;
      itemId?: string;
      delta?: string;
      contentIndex?: number;
      summaryIndex?: number;
      item?: ThreadItem;
      turn?: Turn;
    };
    const t = p.threadId ? stateFor(p.threadId) : undefined;
    if (!t) return;
    // A Codex child thread's notifications are the subagent's own: only its
    // messages and tool calls surface, under the Agent row that spawned it.
    // Its turn lifecycle, usage, reasoning and errors stay out of the root.
    if (t.parent) {
      switch (method) {
        case "item/started":
          if (p.item) onItemStarted(t, p.item);
          return;
        case "item/completed":
          if (p.item) onItemCompleted(t, p.item);
          return;
        case "item/agentMessage/delta":
          if (p.itemId && p.delta) t.deltas.set(p.itemId, (t.deltas.get(p.itemId) ?? "") + p.delta);
          return;
        default:
          return;
      }
    }
    switch (method) {
      case "item/agentMessage/delta":
        if (p.itemId && p.delta) {
          t.deltas.set(p.itemId, (t.deltas.get(p.itemId) ?? "") + p.delta);
          t.input.onTextDelta(p.delta, p.itemId);
        }
        return;
      case "item/reasoning/textDelta":
        if (p.itemId && p.delta) {
          t.reasoning.set(p.itemId, (t.reasoning.get(p.itemId) ?? "") + p.delta);
          t.input.onReasoningDelta?.({ itemId: p.itemId, text: p.delta, opaque: false });
        }
        return;
      case "item/reasoning/summaryTextDelta":
        if (p.itemId && p.delta) t.input.onReasoningSummary?.({ itemId: p.itemId, index: p.summaryIndex ?? 0, text: p.delta });
        return;
      case "item/reasoning/summaryPartAdded":
        // No state to keep: the next summaryTextDelta carries its own summaryIndex.
        return;
      case "item/commandExecution/outputDelta":
        if (p.itemId && p.delta) t.input.onToolOutputDelta?.({ toolUseId: p.itemId, text: p.delta });
        return;
      case "item/started":
        if (p.item) onItemStarted(t, p.item);
        return;
      case "item/completed":
        if (p.item) onItemCompleted(t, p.item);
        return;
      case "thread/tokenUsage/updated": {
        const tokenUsage = (params as { tokenUsage: { last: TokenBreakdown; modelContextWindow?: number | null } }).tokenUsage;
        const last = tokenUsage.last;
        const contextSize = typeof tokenUsage.modelContextWindow === "number" ? tokenUsage.modelContextWindow : null;
        t.usage = last;
        t.contextSize = contextSize;
        t.input.onUsageUpdate?.({
          inputTokens: last.inputTokens,
          outputTokens: last.outputTokens,
          cacheReadTokens: last.cachedInputTokens ?? null,
          contextUsed: last.inputTokens,
          ...(contextSize !== null ? { contextSize } : {}),
        });
        return;
      }
      case "turn/plan/updated": {
        const plan = (params as { plan: { step: string; status: "pending" | "inProgress" | "completed" }[] }).plan;
        t.input.onEvent({
          kind: "plan",
          entries: plan.map((e) => ({ content: e.step, status: e.status === "inProgress" ? "in_progress" : e.status })),
        });
        return;
      }
      case "thread/compacted":
        emitCompaction(t);
        return;
      case "turn/started": {
        const turn = (params as { turn: Turn }).turn;
        t.turnId = turn.id;
        t.input.onEvent({ kind: "turn-start", turnId: turn.id, agent: "codex", model: t.input.model });
        return;
      }
      case "turn/completed":
        if (p.turn) t.done(p.turn);
        return;
      case "error": {
        const e = params as { error: { message: string }; willRetry: boolean };
        if (!e.willRetry) t.input.onEvent({ kind: "error", message: `Codex: ${e.error.message}` });
        else if (!t.retrying.has(e.error.message)) {
          // Often a missing login: say so instead of spinning silently.
          t.retrying.add(e.error.message);
          t.input.onEvent({ kind: "notice", text: `Codex hit an error and is retrying: ${e.error.message}` });
        }
        return;
      }
      default:
        return;
    }
  };

  const onItemStarted = (t: TurnState, item: ThreadItem) => {
    // A root thread's subagent bookkeeping: the Agent row its child thread's
    // items hang under. Once registered, a later subAgentActivity says nothing.
    if (!t.parent) {
      if (item.type === "subAgentActivity") {
        const a = item as { kind: string; agentThreadId: string; agentPath: string };
        if (a.kind === "started" && !children.has(a.agentThreadId)) registerChild(t, a.agentThreadId, item.id, { prompt: "", subagent: agentName(a.agentPath) });
        return;
      }
      if (item.type === "collabAgentToolCall") {
        const c = item as { id: string; tool: string; receiverThreadIds: string[]; prompt: string | null };
        if (c.tool === "spawnAgent") {
          // The child ids can arrive on item/completed instead; emit the row then.
          if (!c.receiverThreadIds.length) spawnWait.set(c.id, c.prompt ?? "");
          for (const id of c.receiverThreadIds) if (!children.has(id)) registerChild(t, id, c.id, { prompt: c.prompt ?? "", subagent: "subagent" });
        }
        return;
      }
    }
    const tool = toolFor(item);
    if (tool) t.input.onEvent({ kind: "tool-use", toolUseId: item.id, ...tool });
  };
  const onItemCompleted = (t: TurnState, item: ThreadItem) => {
    // Root-only subagent lifecycle: a subagent finishing closes its Agent row.
    if (!t.parent) {
      if (item.type === "subAgentActivity") {
        const a = item as { kind: string; agentThreadId: string };
        if (a.kind === "completed" || a.kind === "interrupted") closeChild(t, a.agentThreadId, a.kind === "interrupted");
        return;
      }
      if (item.type === "collabAgentToolCall") {
        const c = item as { id: string; tool: string; receiverThreadIds: string[]; prompt: string | null };
        if (c.tool === "spawnAgent" && spawnWait.has(c.id)) {
          const prompt = spawnWait.get(c.id) ?? "";
          spawnWait.delete(c.id);
          for (const id of c.receiverThreadIds) if (!children.has(id)) registerChild(t, id, c.id, { prompt: c.prompt ?? prompt, subagent: "subagent" });
        }
        // Other collaboration tools (wait, closeAgent, ...) emit nothing.
        return;
      }
    }
    if (item.type === "contextCompaction") {
      if (!t.parent) emitCompaction(t);
      return;
    }
    if (item.type === "plan") {
      // A plan is a proposal, not assistant prose: keep it for the decision.
      if (t.parent) return;
      t.planText = (item as { text: string }).text;
      return;
    }
    if (item.type === "agentMessage") {
      const text = (item as { text: string }).text || t.deltas.get(item.id) || "";
      t.deltas.delete(item.id);
      t.agentText = text;
      if (text.trim()) t.input.onEvent({ kind: "assistant-text", text, itemId: item.id });
      return;
    }
    if (item.type === "reasoning") {
      if (t.parent) return;
      const r = item as { summary: string[] };
      const text = r.summary.join("\n\n").trim() || t.reasoning.get(item.id)?.trim() || "";
      if (text) t.input.onEvent({ kind: "thinking", text, itemId: item.id });
      t.reasoning.delete(item.id);
      return;
    }
    if (!toolFor(item)) return;
    const status = (item as { status?: string }).status ?? "completed";
    const failed = status === "failed" || status === "declined";
    let summary = failed ? "Failed" : "Done";
    if (item.type === "commandExecution") {
      const c = item as { command: string; aggregatedOutput: string | null; exitCode: number | null };
      // Full mode runs without an approval callback, so the guard can only warn.
      if (t.input.permissionMode === "full" && config.guardScript) {
        void checkCommand(config.guardScript, "Bash", c.command).then((verdict) => {
          if (verdict.blocked) {
            t.input.onEvent({
              kind: "notice",
              text: `Guardrail warning: this command would have been blocked in Ask or Auto-edit mode: ${c.command}`,
            });
          }
        });
      }
      summary = summarizeToolResult(c.aggregatedOutput ?? "") || (c.exitCode !== null ? `exit ${c.exitCode}` : summary);
    } else if (item.type === "mcpToolCall") {
      const m = item as { error?: { message: string } | null; result?: { content: unknown } | null };
      if (m.error) summary = m.error.message;
      else if (m.result) summary = summarizeToolResult(m.result.content) || summary;
    }
    const payload = resultPayloadFor(item);
    const diff = !failed && item.type === "fileChange" ? (payload as { diff: ToolDiff[] }).diff : [];
    if (diff.length) summary = diffSummary(diff);
    t.input.onEvent({ kind: "tool-result", toolUseId: item.id, isError: failed, summary, ...(payload !== null ? { payload } : {}) });
  };

  const onRequest = async (method: string, params: unknown): Promise<unknown> => {
    const p = params as { threadId: string; command?: string | null; reason?: string | null; itemId: string };
    const t = stateFor(p.threadId);
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
      if (!t) return { decision: "decline" };
      const isCommand = method === "item/commandExecution/requestApproval";
      // The git guardrail comes first: a blocked command is declined without
      // asking, and never reaches the model's approval prompt.
      if (isCommand && config.guardScript && typeof p.command === "string") {
        const verdict = await checkCommand(config.guardScript, "Bash", p.command);
        if (verdict.blocked) {
          t.input.onEvent({ kind: "notice", text: `Blocked by git guardrails: ${p.command}` });
          return { decision: "decline" };
        }
      }
      // Auto-edit auto-approves edits, like Claude's acceptEdits; commands still ask.
      if (!isCommand && t.input.permissionMode === "auto-edit") return { decision: "accept" };
      const decision = await t.input.requestPermission({
        toolName: isCommand ? "Run" : "Edit",
        summary: (isCommand ? p.command : p.reason) ?? (isCommand ? "a command" : "file changes"),
        canAlwaysAllow: true,
      });
      return { decision: codexDecision(decision) };
    }
    if (method === "mcpServer/elicitation/request") return onElicitation(params as Elicitation);
    throw new RpcError(-32601, `${method} is not supported by this client`);
  };

  // Codex asks before an MCP tool call as a form elicitation tagged
  // mcp_tool_call. Other elicitations (an MCP server asking the user for
  // input) have no UI here, so they're declined.
  const onElicitation = async (p: Elicitation): Promise<{ action: "accept" | "decline"; content: null }> => {
    const t = stateFor(p.threadId);
    if (!t || p._meta?.codex_approval_kind !== "mcp_tool_call") return { action: "decline", content: null };
    const tool = /tool "([^"]+)"/.exec(p.message ?? "")?.[1] ?? "a tool";
    // A subagent shares the root thread's "always allow" set.
    const owner = t.parent?.threadId ?? t.threadId;
    const allowed = alwaysAllowed.get(owner);
    if (allowed?.has(`${p.serverName}/${tool}`)) return { action: "accept", content: null };
    const decision = await t.input.requestPermission({
      toolName: TOOL_SERVERS.has(p.serverName) ? tool : `${p.serverName} · ${tool}`,
      summary: (p._meta.tool_params_display ?? []).map((d) => `${d.display_name ?? d.name}: ${String(d.value)}`).join(", ") || tool,
      canAlwaysAllow: true,
    });
    if (decision === "allow-always") {
      if (!allowed) alwaysAllowed.set(owner, new Set([`${p.serverName}/${tool}`]));
      else allowed.add(`${p.serverName}/${tool}`);
    }
    return { action: decision === "deny" ? "decline" : "accept", content: null };
  };

  const liveReady = (): Promise<void> | null => (rpc?.alive && ready ? ready : null);

  /** Ask the running app-server for its model list; keep the last one on failure. */
  const listModels = async (conn: StdioRpc): Promise<void> => {
    const list = await conn
      .request<{
        data: {
          id: string;
          displayName: string;
          hidden: boolean;
          supportedReasoningEfforts?: { reasoningEffort: string; description: string }[];
          defaultReasoningEffort?: string;
        }[];
      }>("model/list", {})
      .catch(() => null);
    if (!list) return;
    models = list.data.filter((m) => !m.hidden).map((m) => ({
      id: m.id,
      label: m.displayName,
      ...(m.supportedReasoningEfforts?.length ? { efforts: m.supportedReasoningEfforts.map((e) => e.reasoningEffort) } : {}),
      ...(m.defaultReasoningEffort ? { defaultEffort: m.defaultReasoningEffort } : {}),
    }));
    listedAt = Date.now();
  };

  const start = async (cwd: string): Promise<void> => {
    // A caller arriving while a replaced app-server exits waits for it too, so only one successor spawns.
    if (exiting) await exiting;
    let plan = config.injection?.();
    if (rpc?.alive && ready) {
      // app-server reads the login once. After `codex login` (or a logout) it keeps
      // using the old one and answers 401, so start a fresh one when nothing is running.
      if (codexAuthStamp(plan?.env ?? process.env) === authStamp || turns.size > 0) return ready;
      const old = rpc;
      rpc = null;
      ready = null;
      loaded.clear();
      old.close();
      // Codex allows one writer per thread: let the old app-server exit before the new one resumes anything.
      exiting = Promise.race([old.closed(), new Promise((r) => setTimeout(r, 5000))]).finally(() => {
        exiting = null;
      });
      await exiting;
      // Another waiter may have spawned the successor already (read through a call: the await can change it).
      const successor = liveReady();
      if (successor) return successor;
      plan = config.injection?.();
    }
    if (plan?.error) return Promise.reject(new Error(plan.error));
    authStamp = codexAuthStamp(plan?.env ?? process.env);
    startWarnings = [];
    // A bare command is resolved to its newest installed copy at spawn time.
    const command = config.command.includes("/") || config.command.includes("\\") ? config.command : await resolvedCommandAsync(config.command);
    const conn: StdioRpc = StdioRpc.spawn(command, [...config.args, ...(plan?.args ?? [])], { cwd, env: plan?.env ?? process.env }, {
      onNotification,
      onRequest,
      onExit: () => {
        // A process replaced after a login change exits later: leave its successor alone.
        if (rpc !== conn) return;
        for (const t of turns.values()) t.done({ id: t.turnId ?? "", status: "failed", error: { message: "Codex exited." }, durationMs: null });
        rpc = null;
        ready = null;
        loaded.clear();
      },
    });
    rpc = conn;
    ready = (async () => {
      await conn.request("initialize", {
        clientInfo: { name: "cubiq", title: "CubiQ", version: config.clientVersion },
        // Plan mode rides Codex's experimental collaboration modes (0.157).
        capabilities: { experimentalApi: true },
      });
      conn.notify("initialized");
      if (config.skillsDir) {
        const dir = config.skillsDir();
        if (dir) await conn.request("skills/extraRoots/set", { extraRoots: [dir] }).catch(() => {});
      }
      await listModels(conn);
      if (plan?.byok && startWarnings.length) throw new Error(`Codex rejected the provider config: ${startWarnings.join("; ")}`);
    })();
    ready.catch(() => {
      rpc?.close();
      rpc = null;
      ready = null;
    });
    return ready;
  };

  let refreshing: Promise<void> | null = null;
  const refreshModels = (opts?: { force?: boolean }): Promise<void> => {
    // model/list is per account (a free plan lists fewer models): after a new login, ask again.
    const loginChanged = models.length > 0 && codexAuthStamp(config.injection?.()?.env ?? process.env) !== authStamp;
    // A list within the TTL is trusted; a stale one is re-asked, and force
    // skips the TTL (after a provider or credential change).
    if (!opts?.force && models.length && !loginChanged && Date.now() - listedAt < MODEL_TTL_MS) return Promise.resolve();
    refreshing ??= (async () => {
      // A running app-server answers a fresh model/list in place, no restart.
      if (models.length && !loginChanged && rpc?.alive) {
        await listModels(rpc);
        return;
      }
      // start() already runs model/list (restarting a stale app-server first) and keeps the process for later turns.
      await start(homedir());
    })()
      .catch(() => {})
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  };

  const openThread = async (
    input: Pick<TurnInput, "threadId" | "projectId" | "cwd" | "model" | "permissionMode" | "sessionId" | "tools" | "mcpServers" | "onEvent" | "onSession" | "onSessionRebuilt" | "onSessionLost">,
  ): Promise<{ threadId: string; model: string | null }> => {
    const policy = codexPolicy(input.permissionMode);
    const model = input.model === CODEX_DEFAULT_MODEL ? null : input.model;
    await start(input.cwd);
    const conn = rpc!;
    const withTools = input.tools.length > 0 && Boolean(config.toolServer);
    const server = withTools ? await config.toolServer!() : null;
    let threadConfig = codexToolConfig(server ? { ...server, url: withProject(server.url, input.projectId) } : null, input.tools, input.permissionMode, input.mcpServers);
    const memory = input.projectId ? config.memory?.(input.projectId) ?? null : null;
    // CubiQ memory is on: Codex's own memories would duplicate it, so turn them off.
    if (memory !== null) threadConfig = { ...(threadConfig ?? {}), memories: { use_memories: false, generate_memories: false } };
    const guideText = config.guide?.(input.cwd) ?? "";
    const signature = JSON.stringify(threadConfig ?? null);
    let threadId = "";
    let threadModel: string | null = null;
    let seed: SessionSeed | null = null;
    if (input.sessionId) {
      // The MCP servers changed mid-conversation (the user opened the
      // browser, or edited their servers): unload the thread so the
      // resume below loads it again with the new config.
      const was = loaded.get(input.sessionId);
      if (was !== undefined && was !== signature) {
        const servers = (json: string) => ((JSON.parse(json) as { mcp_servers?: Record<string, unknown> } | null)?.mcp_servers ?? {});
        const notice = mcpChangeNotice(servers(was), servers(signature), true, "Codex");
        if (notice) input.onEvent({ kind: "notice", text: notice });
        await conn.request("thread/unsubscribe", { threadId: input.sessionId }).catch(() => {});
        loaded.delete(input.sessionId);
        input.onSessionRebuilt?.();
      }
      try {
        // The block a session first carried is frozen: later turns pay cache reads, not writes.
        const memText = frozenMemory.get(input.sessionId) ?? memory ?? "";
        const developerInstructions = [guideText, memText].filter(Boolean).join("\n\n");
        const res = await conn.request<{ thread: { id: string }; model?: string }>("thread/resume", {
          threadId: input.sessionId,
          cwd: input.cwd,
          model,
          ...policy,
          config: threadConfig,
          ...(developerInstructions ? { developerInstructions } : {}),
        });
        threadId = res.thread.id;
        threadModel = res.model ?? null;
        if (memText && !frozenMemory.has(threadId)) frozenMemory.set(threadId, memText);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        if (input.onSessionLost) seed = await input.onSessionLost(reason);
        else input.onEvent({ kind: "notice", text: `Codex couldn't resume the earlier conversation (${reason}); this is a fresh thread.` });
      }
    }
    if (!threadId) {
      const memText = memory ?? "";
      const developerInstructions = [guideText, memText].filter(Boolean).join("\n\n");
      const res = await conn.request<{ thread: { id: string }; model?: string }>("thread/start", {
        cwd: input.cwd,
        model,
        ...policy,
        config: threadConfig,
        ...(developerInstructions ? { developerInstructions } : {}),
      });
      threadId = res.thread.id;
      threadModel = res.model ?? null;
      if (memText && !frozenMemory.has(threadId)) frozenMemory.set(threadId, memText);
      // A new thread catches up with the seed's history items; Codex only ever gets the inject shape.
      if (seed && "inject" in seed) {
        await seed.inject(threadId, (items) => conn.request("thread/inject_items", { threadId, items }).then(() => undefined));
      }
    }
    // A resume of a thread that's already loaded keeps its config, so only a first load decides.
    if (!loaded.has(threadId)) loaded.set(threadId, signature);
    input.onSession(threadId);
    return { threadId, model: threadModel };
  };

  return {
    id: "codex",
    label: "Codex",
    defaultModel: CODEX_DEFAULT_MODEL,
    capabilities: CODEX_CAPABILITIES,
    credentials: { byok: true, own: "login", injector: "codex" },
    skillsDelivery: CODEX_CAPABILITIES.skillsDelivery,
    skillCallPrefix: "",
    /** The Codex copy a bare command resolves to at spawn time, and the others found. */
    binary: () => (config.command.includes("/") || config.command.includes("\\") ? undefined : (binaryInfo(config.command) ?? undefined)),
    models: () => {
      const byok = config.byokModels?.();
      return byok ?? [{ id: CODEX_DEFAULT_MODEL, label: "Codex default" }, ...models];
    },
    refreshModels,
    // Read account limits on demand. Never starts the app-server just to
    // probe: with none running there is nothing to ask, so return null.
    readLimits: async (): Promise<LimitsPatch | "unsupported" | null> => {
      if (!rpc?.alive) return null;
      const conn = rpc;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const res = await Promise.race([
          conn.request<CodexRateLimitsRead>("account/rateLimits/read", null),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("timed out reading Codex rate limits")), 3_000);
          }),
        ]);
        return codexReadPatch(res ?? {});
      } finally {
        clearTimeout(timer);
      }
    },
    // turn/start carries the model and it sticks (spike S4); back to the
    // default sends model null, which keeps the old model, so that needs a
    // new thread.
    setModel: async ({ to }) => (to === CODEX_DEFAULT_MODEL ? "new-session" : "in-place"),
    /**
     * One hidden prompt on a throwaway, read-only, ephemeral thread in a
     * scratch cwd, for background work (memory extraction). Its events go
     * nowhere; only the final assistant text comes back.
     */
    async oneShot(req) {
      const cwd = join(tmpdir(), "cubiq-oneshot");
      mkdirSync(cwd, { recursive: true });
      const model = req.model === CODEX_DEFAULT_MODEL ? null : req.model;
      await start(cwd);
      const conn = rpc!;
      const opened = await conn.request<{ thread: { id: string } }>("thread/start", {
        cwd,
        model,
        ...codexPolicy("plan"),
        ephemeral: true,
        config: { memories: { use_memories: false, generate_memories: false } },
      });
      const threadId = opened.thread.id;
      let resolveTurn!: (t: Turn) => void;
      const finished = new Promise<Turn>((r) => (resolveTurn = r));
      const signal = req.signal ?? new AbortController().signal;
      const state: TurnState = {
        input: stubInput({ threadId, cwd, prompt: req.prompt, model: req.model ?? CODEX_DEFAULT_MODEL, signal }),
        threadId,
        turnId: null,
        deltas: new Map(),
        reasoning: new Map(),
        usage: null,
        contextSize: null,
        retrying: new Set(),
        compacted: false,
        planText: null,
        agentText: "",
        done: resolveTurn,
      };
      turns.set(threadId, state);
      const onAbort = () => {
        if (state.turnId) void conn.request("turn/interrupt", { threadId, turnId: state.turnId }).catch(() => {});
      };
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        const startedTurn = await conn.request<{ turn: Turn }>("turn/start", {
          threadId,
          input: [{ type: "text", text: req.prompt, text_elements: [] }],
          model,
          approvalPolicy: "never",
          summary: "none",
          ...(req.effort ? { effort: req.effort } : {}),
        });
        state.turnId ??= startedTurn.turn.id;
        if (signal.aborted) onAbort();
        const turn = await finished;
        if (turn.status === "failed") throw new Error(`Codex: ${turn.error?.message ?? "the background turn failed."}`);
        return state.agentText || [...state.deltas.values()].join("");
      } finally {
        signal.removeEventListener("abort", onAbort);
        turns.delete(threadId);
        // Awaited, so the hidden thread is released before the caller moves on.
        await conn.request("thread/unsubscribe", { threadId }).catch(() => {});
      }
    },
    async seed(req) {
      const events: ThreadEvent[] = []; // notices from opening the thread are dropped here; the Service reports the seed itself
      const { threadId } = await openThread({ threadId: req.threadId, projectId: req.projectId, cwd: req.cwd, model: req.model, permissionMode: req.permissionMode, sessionId: req.sessionId, tools: req.tools, mcpServers: req.mcpServers, onEvent: (e) => events.push(e), onSession: req.onSession });
      const conn = rpc!;
      const { sent } = await req.inject(threadId, (items) => conn.request("thread/inject_items", { threadId, items }).then(() => undefined));
      return { mode: "seeded", sessionId: threadId, sent };
    },
    async runTurn(input) {
      const model = input.model === CODEX_DEFAULT_MODEL ? null : input.model;
      // A brand-new session's first turn pays to write the guide and tool schemas into the prompt cache.
      const fresh = !input.sessionId;
      // Warm the extensions estimate (MCP tool listings) so the breakdown at the end of this turn has it.
      if (fresh) config.extensions?.(input.cwd, input.projectId ?? null);
      let opened: { threadId: string; model: string | null };
      try {
        opened = await openThread(input);
      } catch (err) {
        input.onEvent({ kind: "error", message: `Codex failed to start: ${err instanceof Error ? err.message : String(err)}` });
        return;
      }
      const threadId = opened.threadId;
      // The model a collaboration mode names: the picked one, else the thread's
      // own (thread/start resumes report it), else the newest listing, and only
      // then a stand-in so the settings object is never empty.
      const modeModel =
        input.model !== CODEX_DEFAULT_MODEL
          ? input.model
          : (opened.model ?? models[models.length - 1]?.id ?? "gpt-5.6-sol"); // TODO: last resort; thread/start and model/list should name a real model.

      const conn = rpc!;
      const started = Date.now();
      // Accumulated across runOne rounds (the assignments happen inside the
      // closure, so a holder keeps the compiler from narrowing these to null).
      const last: { usage?: TokenBreakdown; contextSize?: number | null; turn?: Turn } = {};
      /** Whether the previous runOne ran in plan mode, so leaving it re-sends a default collaboration mode. */
      let previousPlan = false;

      const runOne = async (prompt: string, mode: PermissionMode): Promise<{ turn: Turn; planText: string | null }> => {
        const policy = codexPolicy(mode);
        // Plan mode is a native collaboration mode; leaving it must say so
        // explicitly, since the mode sticks to the thread between turns.
        const collaborationMode: CollaborationMode | undefined =
          mode === "plan" || previousPlan
            ? {
                mode: mode === "plan" ? "plan" : "default",
                settings: { model: modeModel, reasoning_effort: input.effort ?? null, developer_instructions: null },
              }
            : undefined;
        previousPlan = mode === "plan";

        let resolveTurn!: (t: Turn) => void;
        const finished = new Promise<Turn>((r) => (resolveTurn = r));
        const state: TurnState = { input, threadId, turnId: null, deltas: new Map(), reasoning: new Map(), usage: null, contextSize: null, retrying: new Set(), compacted: false, planText: null, agentText: "", done: resolveTurn };
        turns.set(threadId, state);
        const onAbort = () => {
          if (state.turnId) void conn.request("turn/interrupt", { threadId, turnId: state.turnId }).catch(() => {});
        };
        input.signal.addEventListener("abort", onAbort, { once: true });
        let interrupted = input.signal.aborted;
        try {
          const res = await conn.request<{ turn: Turn }>("turn/start", {
            threadId,
            input: [{ type: "text", text: prompt, text_elements: [] }],
            model,
            approvalPolicy: policy.approvalPolicy,
            // Summarized reasoning streams back as `summary: "auto"`.
            summary: "auto",
            ...(input.effort ? { effort: input.effort } : {}),
            // Only a plan round (or the implementing round leaving it) overrides
            // the thread's sandbox: a plan reads only, the round that follows
            // widens the read-only thread back out.
            ...(collaborationMode ? { collaborationMode, sandboxPolicy: sandboxPolicyFor(mode) } : {}),
          });
          state.turnId ??= res.turn.id;
          if (input.signal.aborted) onAbort();
          const turn = await finished;
          interrupted = turn.status === "interrupted";
          // Flush what the terminal events didn't: thinking first, then assistant
          // text, both before the interrupted-turn notice.
          for (const [itemId, text] of state.reasoning) if (text.trim()) input.onEvent({ kind: "thinking", text, itemId });
          for (const [itemId, text] of state.deltas) if (text.trim()) input.onEvent({ kind: "assistant-text", text, itemId });
          if (turn.status === "interrupted") input.onEvent({ kind: "notice", text: "Stopped." });
          else if (turn.status === "failed") input.onEvent({ kind: "error", message: `Codex: ${turn.error?.message ?? "the turn failed."}` });
          last.usage = state.usage ?? undefined;
          last.contextSize = state.contextSize;
          last.turn = turn;
          return { turn, planText: state.planText ?? proposedPlanText(state.agentText) };
        } finally {
          input.signal.removeEventListener("abort", onAbort);
          // A subagent still open when the root turn ends closes with it.
          closeRootChildren(state, interrupted);
          turns.delete(threadId);
        }
      };

      try {
        // A plan round hands its proposal to the user; their answer either
        // switches to an implementing round or asks for a refined plan.
        let mode: PermissionMode = input.permissionMode;
        let prompt = input.prompt;
        for (let round = 0; round < 6; round++) {
          // A Stop between rounds must end the run, never start another round.
          if (round > 0 && input.signal.aborted) break;
          const r = await runOne(prompt, mode);
          const alreadyStopped = r.turn.status === "interrupted";
          if (mode !== "plan" || !r.planText || r.turn.status !== "completed" || input.signal.aborted) break;
          const d = await input.requestPlanDecision({ plan: r.planText });
          // Stop while the plan card was up: the abort resolves the decision as
          // { keep: "" }, which must not be read as "keep planning".
          if (input.signal.aborted) {
            if (!alreadyStopped) input.onEvent({ kind: "notice", text: "Stopped." });
            break;
          }
          if (d === "auto" || d === "manual") {
            mode = d === "auto" ? "auto-edit" : "ask";
            prompt = "Implement the plan.";
          } else {
            prompt = d.keep.trim() || "Refine the plan.";
          }
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
          const ext = config.extensions?.(input.cwd, input.projectId ?? null);
          const rows = [
            { label: "Harness tools", tokens: Math.ceil(serializedTools.length / 4) },
            { label: "Harness guide", tokens: Math.ceil((config.guide?.(input.cwd) ?? "").length / 4) },
            { label: "Memory index", tokens: Math.ceil((frozenMemory.get(threadId) ?? "").length / 4) },
            { label: "Skills", tokens: ext?.skills ?? 0 },
            { label: "MCP tools", tokens: ext?.mcp ?? 0 },
          ]
            .filter((r) => r.tokens > 0)
            .sort((a, b) => b.tokens - a.tokens);
          if (rows.length) input.onEvent({ kind: "context-breakdown", rows, total: last.usage?.inputTokens ?? null, estimated: true });
        }
        // One turn-end for the whole runTurn, on the last round's usage.
        input.onEvent(turnEndFromUsage(last.usage, last.turn?.durationMs ?? Date.now() - started, last.contextSize));
      } catch (err) {
        input.onEvent({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      }
    },
    dispose() {
      rpc?.close();
      rpc = null;
      ready = null;
      loaded.clear();
    },
  };
}

/** The name, summary, and canonical payload of one tool item, for tool-use events. */
export function toolFor(item: ThreadItem): { name: string; summary: string; payload?: unknown } | null {
  switch (item.type) {
    case "commandExecution": {
      const c = item as { command: string };
      return { name: "Run", summary: clipSummary(c.command), payload: { command: c.command } satisfies RunPayload };
    }
    case "fileChange": {
      const f = item as { changes: { path: string }[] };
      return { name: "Edit", summary: clipSummary(f.changes.map((c) => c.path).join(", ")), payload: { changes: f.changes } };
    }
    case "mcpToolCall": {
      const m = item as { server: string; tool: string; arguments?: unknown };
      const args = m.arguments && typeof m.arguments === "object" ? (m.arguments as Record<string, unknown>) : {};
      // The harness's own tools read as themselves, like Claude's browser_* calls.
      return {
        name: TOOL_SERVERS.has(m.server) ? m.tool : `${m.server} · ${m.tool}`,
        summary: summarizeToolInput(m.tool, args),
        ...(Object.keys(args).length ? { payload: args } : {}),
      };
    }
    case "webSearch": {
      const query = (item as { query?: string }).query;
      return {
        name: "Search",
        summary: clipSummary(query ?? ""),
        ...(typeof query === "string" && query ? { payload: { query } } : {}),
      };
    }
    default:
      return null;
  }
}

/** The canonical tool-result payload for a completed item, or null when the item has none. */
export function resultPayloadFor(item: ThreadItem): unknown | null {
  if (item.type === "commandExecution") {
    const c = item as { aggregatedOutput: string | null; exitCode: number | null };
    return { exitCode: c.exitCode, output: c.aggregatedOutput ?? "" } satisfies RunResult;
  }
  if (item.type === "fileChange") {
    const f = item as { changes: { path: string; diff?: unknown; unified_diff?: unknown; kind?: { unified_diff?: unknown } }[] };
    const diff: ToolDiff[] = f.changes
      .map((c) => {
        const unified =
          typeof c.diff === "string" ? c.diff : typeof c.unified_diff === "string" ? c.unified_diff : typeof c.kind?.unified_diff === "string" ? c.kind.unified_diff : "";
        return { path: c.path, unified };
      })
      .filter((d) => d.unified);
    return { diff };
  }
  if (item.type === "mcpToolCall") {
    const m = item as { result?: { content: unknown } | null; error?: { message: string } | null };
    return m.error ?? m.result ?? null;
  }
  return null;
}
