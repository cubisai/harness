import type { McpServerEntry, ModelOption, PermissionDecision, PermissionMode, ThreadEvent } from "../../shared/types";
import type { RunPayload, RunResult, ToolDiff } from "../../shared/tools";
import { clipSummary } from "../../shared/tools";
import { diffSummary } from "../../shared/diff";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { forCodex, mcpChangeNotice } from "../mcp/servers";
import { normalizeUsage } from "../usage";
import type { InjectionPlan } from "../inject";
import { RpcError, StdioRpc } from "./rpc";
import { CODEX_CAPABILITIES } from "./capabilities";
import { codexLimitsPatch, type CodexRateLimits, type LimitsListener } from "./limits";
import { checkCommand } from "../guard";
import { summarizeToolInput, summarizeToolResult } from "./summarize";
import type { AgentDriver, HarnessTool, TurnInput } from "./types";

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
}

/** The MCP server name the harness's tools go by, in Codex's config and its tool calls. */
export const CODEX_TOOL_SERVER = "unskilled";

export const CODEX_DEFAULT_MODEL = "default";

/** Ask / Auto-edit / Full as Codex approval policy and sandbox. */
export function codexPolicy(mode: PermissionMode): { approvalPolicy: string; sandbox: string } {
  switch (mode) {
    case "full":
      return { approvalPolicy: "never", sandbox: "danger-full-access" };
    case "auto-edit":
      return { approvalPolicy: "untrusted", sandbox: "workspace-write" };
    default:
      return { approvalPolicy: "untrusted", sandbox: "workspace-write" };
  }
}

/** When Codex's login file (`$CODEX_HOME/auth.json`, default ~/.codex) last changed, or null without one. */
export function codexAuthStamp(env: NodeJS.ProcessEnv = process.env): number | null {
  try {
    return statSync(join(env.CODEX_HOME || join(homedir(), ".codex"), "auth.json")).mtimeMs;
  } catch {
    return null;
  }
}

export function codexDecision(d: PermissionDecision): "accept" | "acceptForSession" | "decline" {
  return d === "allow-always" ? "acceptForSession" : d === "allow-once" ? "accept" : "decline";
}

/**
 * Codex reports OpenAI-style input that *includes* cached tokens, so the
 * top-level `inputTokens` is net-new only. `netNewInputTokens`, when the
 * server sends it, is authoritative over the subtraction.
 */
export function turnEndFromUsage(usage: TokenBreakdown | undefined, durationMs: number): ThreadEvent {
  if (!usage) {
    return {
      kind: "turn-end",
      costUsd: null,
      inputTokens: 0,
      outputTokens: 0,
      durationMs,
      usage: normalizeUsage({ inputTokens: 0, outputTokens: 0, provenance: "unavailable" }),
    };
  }
  const netNew = usage.netNewInputTokens ?? Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  return {
    kind: "turn-end",
    costUsd: null,
    inputTokens: netNew,
    outputTokens: usage.outputTokens,
    durationMs,
    usage: normalizeUsage({
      inputTokens: netNew,
      outputTokens: usage.outputTokens,
      reasoningTokens: usage.reasoningOutputTokens ?? null,
      cacheReadTokens: usage.cachedInputTokens ?? null,
      cacheWriteTokens: usage.cacheWriteInputTokens ?? null,
    }),
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
  /** Retrying errors already shown this turn, so each shows once. */
  retrying: Set<string>;
  /** A compaction was already emitted this turn (both notification paths can fire). */
  compacted: boolean;
  done: (turn: Turn) => void;
}

/**
 * Codex through `codex app-server`: one app-server process for every thread
 * (it runs many at once), threads resumed by id from Codex's own history.
 */
export function createCodexDriver(config: CodexConfig): AgentDriver {
  let rpc: StdioRpc | null = null;
  let ready: Promise<void> | null = null;
  /** Codex's login file as it was when the running app-server started. */
  let authStamp: number | null = null;
  let models: ModelOption[] = [];
  const turns = new Map<string, TurnState>(); // by Codex thread id
  /** Threads loaded in the running app-server, and the MCP config they were loaded with. */
  const loaded = new Map<string, string>();
  /** MCP tools the user chose "always allow" for, by thread. */
  const alwaysAllowed = new Map<string, Set<string>>();
  /** configWarning summaries from the current app-server, reset at each start. */
  let startWarnings: string[] = [];

  const emitCompaction = (t: TurnState) => {
    if (t.compacted) return;
    t.compacted = true;
    t.input.onEvent({ kind: "compaction", trigger: "auto", preTokens: null, postTokens: null });
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
    const t = p.threadId ? turns.get(p.threadId) : undefined;
    if (!t) return;
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
        const last = (params as { tokenUsage: { last: TokenBreakdown } }).tokenUsage.last;
        t.usage = last;
        t.input.onUsageUpdate?.({ inputTokens: last.inputTokens, outputTokens: last.outputTokens, cacheReadTokens: last.cachedInputTokens ?? null });
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
    const tool = toolFor(item);
    if (tool) t.input.onEvent({ kind: "tool-use", toolUseId: item.id, ...tool });
  };
  const onItemCompleted = (t: TurnState, item: ThreadItem) => {
    if (item.type === "contextCompaction") {
      emitCompaction(t);
      return;
    }
    if (item.type === "agentMessage") {
      const text = (item as { text: string }).text || t.deltas.get(item.id) || "";
      t.deltas.delete(item.id);
      if (text.trim()) t.input.onEvent({ kind: "assistant-text", text, itemId: item.id });
      return;
    }
    if (item.type === "reasoning") {
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
    const t = turns.get(p.threadId);
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
    const t = turns.get(p.threadId);
    if (!t || p._meta?.codex_approval_kind !== "mcp_tool_call") return { action: "decline", content: null };
    const tool = /tool "([^"]+)"/.exec(p.message ?? "")?.[1] ?? "a tool";
    const allowed = alwaysAllowed.get(p.threadId);
    if (allowed?.has(`${p.serverName}/${tool}`)) return { action: "accept", content: null };
    const decision = await t.input.requestPermission({
      toolName: p.serverName === CODEX_TOOL_SERVER ? tool : `${p.serverName} · ${tool}`,
      summary: (p._meta.tool_params_display ?? []).map((d) => `${d.display_name ?? d.name}: ${String(d.value)}`).join(", ") || tool,
      canAlwaysAllow: true,
    });
    if (decision === "allow-always") {
      if (!allowed) alwaysAllowed.set(p.threadId, new Set([`${p.serverName}/${tool}`]));
      else allowed.add(`${p.serverName}/${tool}`);
    }
    return { action: decision === "deny" ? "decline" : "accept", content: null };
  };

  const start = (cwd: string): Promise<void> => {
    const plan = config.injection?.();
    if (rpc?.alive && ready) {
      // app-server reads the login once. After `codex login` (or a logout) it keeps
      // using the old one and answers 401, so start a fresh one when nothing is running.
      if (codexAuthStamp(plan?.env ?? process.env) === authStamp || turns.size > 0) return ready;
      rpc.close();
      rpc = null;
      ready = null;
      loaded.clear();
    }
    if (plan?.error) return Promise.reject(new Error(plan.error));
    authStamp = codexAuthStamp(plan?.env ?? process.env);
    startWarnings = [];
    const conn: StdioRpc = StdioRpc.spawn(config.command, [...config.args, ...(plan?.args ?? [])], { cwd, env: plan?.env ?? process.env }, {
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
        clientInfo: { name: "unskilled", title: "UnSkilled", version: config.clientVersion },
        capabilities: null,
      });
      conn.notify("initialized");
      if (config.skillsDir) {
        const dir = config.skillsDir();
        if (dir) await conn.request("skills/extraRoots/set", { extraRoots: [dir] }).catch(() => {});
      }
      const list = await conn.request<{ data: { id: string; displayName: string; hidden: boolean }[] }>("model/list", {}).catch(() => null);
      if (list) models = list.data.filter((m) => !m.hidden).map((m) => ({ id: m.id, label: m.displayName }));
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
  const refreshModels = (): Promise<void> => {
    // model/list is per account (a free plan lists fewer models): after a new login, ask again.
    if (models.length && codexAuthStamp(config.injection?.()?.env ?? process.env) === authStamp) return Promise.resolve();
    // start() already runs model/list (restarting a stale app-server first) and keeps the process for later turns.
    refreshing ??= start(homedir()).catch(() => {}).finally(() => {
      refreshing = null;
    });
    return refreshing;
  };

  const openThread = async (
    input: Pick<TurnInput, "cwd" | "model" | "permissionMode" | "sessionId" | "tools" | "mcpServers" | "onEvent" | "onSession" | "onSessionRebuilt">,
  ): Promise<string> => {
    const policy = codexPolicy(input.permissionMode);
    const model = input.model === CODEX_DEFAULT_MODEL ? null : input.model;
    await start(input.cwd);
    const conn = rpc!;
    const withTools = input.tools.length > 0 && Boolean(config.toolServer);
    const threadConfig = codexToolConfig(withTools ? await config.toolServer!() : null, input.tools, input.permissionMode, input.mcpServers);
    const guideText = config.guide?.(input.cwd) ?? "";
    const signature = JSON.stringify(threadConfig ?? null);
    let threadId = "";
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
        const res = await conn.request<{ thread: { id: string } }>("thread/resume", {
          threadId: input.sessionId,
          cwd: input.cwd,
          model,
          ...policy,
          config: threadConfig,
          ...(guideText ? { developerInstructions: guideText } : {}),
        });
        threadId = res.thread.id;
      } catch {
        input.onEvent({ kind: "notice", text: "Codex couldn't resume the earlier conversation; this is a fresh thread." });
      }
    }
    if (!threadId) {
      const res = await conn.request<{ thread: { id: string } }>("thread/start", {
        cwd: input.cwd,
        model,
        ...policy,
        config: threadConfig,
        ...(guideText ? { developerInstructions: guideText } : {}),
      });
      threadId = res.thread.id;
    }
    // A resume of a thread that's already loaded keeps its config, so only a first load decides.
    if (!loaded.has(threadId)) loaded.set(threadId, signature);
    input.onSession(threadId);
    return threadId;
  };

  return {
    id: "codex",
    label: "Codex",
    defaultModel: CODEX_DEFAULT_MODEL,
    capabilities: CODEX_CAPABILITIES,
    credentials: { byok: true, own: "login", injector: "codex" },
    skillsDelivery: CODEX_CAPABILITIES.skillsDelivery,
    skillCallPrefix: "",
    models: () => {
      const byok = config.byokModels?.();
      return byok ?? [{ id: CODEX_DEFAULT_MODEL, label: "Codex default" }, ...models];
    },
    refreshModels,
    // turn/start carries the model and it sticks (spike S4); back to the
    // default sends model null, which keeps the old model, so that needs a
    // new thread.
    setModel: async ({ to }) => (to === CODEX_DEFAULT_MODEL ? "new-session" : "in-place"),
    async seed(req) {
      const events: ThreadEvent[] = []; // notices from opening the thread are dropped here; the Service reports the seed itself
      const threadId = await openThread({ cwd: req.cwd, model: req.model, permissionMode: req.permissionMode, sessionId: req.sessionId, tools: req.tools, mcpServers: req.mcpServers, onEvent: (e) => events.push(e), onSession: req.onSession });
      const conn = rpc!;
      const { sent } = await req.inject(threadId, (items) => conn.request("thread/inject_items", { threadId, items }).then(() => undefined));
      return { mode: "seeded", sessionId: threadId, sent };
    },
    async runTurn(input) {
      const policy = codexPolicy(input.permissionMode);
      const model = input.model === CODEX_DEFAULT_MODEL ? null : input.model;
      let threadId: string;
      try {
        threadId = await openThread(input);
      } catch (err) {
        input.onEvent({ kind: "error", message: `Codex failed to start: ${err instanceof Error ? err.message : String(err)}` });
        return;
      }

      const conn = rpc!;
      const started = Date.now();
      let resolveTurn!: (t: Turn) => void;
      const finished = new Promise<Turn>((r) => (resolveTurn = r));
      const state: TurnState = { input, threadId, turnId: null, deltas: new Map(), reasoning: new Map(), usage: null, retrying: new Set(), compacted: false, done: resolveTurn };
      turns.set(threadId, state);
      const onAbort = () => {
        if (state.turnId) void conn.request("turn/interrupt", { threadId, turnId: state.turnId }).catch(() => {});
      };
      input.signal.addEventListener("abort", onAbort, { once: true });
      try {
        const res = await conn.request<{ turn: Turn }>("turn/start", {
          threadId,
          input: [{ type: "text", text: input.prompt, text_elements: [] }],
          model,
          approvalPolicy: policy.approvalPolicy,
        });
        state.turnId ??= res.turn.id;
        if (input.signal.aborted) onAbort();
        const turn = await finished;
        // Flush what the terminal events didn't: thinking first, then assistant
        // text, both before the interrupted-turn notice.
        for (const [itemId, text] of state.reasoning) if (text.trim()) input.onEvent({ kind: "thinking", text, itemId });
        for (const [itemId, text] of state.deltas) if (text.trim()) input.onEvent({ kind: "assistant-text", text, itemId });
        if (turn.status === "interrupted") input.onEvent({ kind: "notice", text: "Stopped." });
        else if (turn.status === "failed") input.onEvent({ kind: "error", message: `Codex: ${turn.error?.message ?? "the turn failed."}` });
        input.onEvent(turnEndFromUsage(state.usage ?? undefined, turn.durationMs ?? Date.now() - started));
      } catch (err) {
        input.onEvent({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
        input.signal.removeEventListener("abort", onAbort);
        turns.delete(threadId);
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
        name: m.server === CODEX_TOOL_SERVER ? m.tool : `${m.server} · ${m.tool}`,
        summary: summarizeToolInput(m.tool, args),
      };
    }
    case "webSearch":
      return { name: "Search", summary: clipSummary((item as { query?: string }).query ?? "") };
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
