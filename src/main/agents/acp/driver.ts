import type { ModelOption, PermissionDecision, PermissionMode, PlanEntry } from "../../../shared/types";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { summarizeToolResult } from "../summarize";
import type { AgentDriver, TurnInput } from "../types";
import { forAcp } from "../../mcp/servers";
import { RpcError, StdioRpc } from "../rpc";
import { normalizeUsage } from "../../usage";
import type { InjectionPlan } from "../../inject";

/** An ACP agent the app can drive: deepseek-harness, Cursor, or any agent that speaks ACP over stdio. */
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
  /** How to install the agent, shown in the Library when it isn't installed. */
  install?: string;
  homepage?: string;
}

// The slices of the ACP schema this driver reads (protocol version 1).
type ToolKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "switch_mode" | "other";
interface ToolCallFields {
  toolCallId: string;
  title?: string | null;
  kind?: ToolKind | null;
  status?: "pending" | "in_progress" | "completed" | "failed" | null;
  rawInput?: unknown;
  content?: { type: string; content?: { type: string; text?: string } }[] | null;
}
type SessionUpdate =
  | { sessionUpdate: "agent_message_chunk" | "agent_thought_chunk" | "user_message_chunk"; content: { type: string; text?: string } }
  | ({ sessionUpdate: "tool_call" | "tool_call_update" } & ToolCallFields)
  | { sessionUpdate: "usage_update"; used: number; size: number; cost?: { amount: number; currency: string } | null }
  | { sessionUpdate: "plan"; entries: { content: string; priority: "high" | "medium" | "low"; status: "pending" | "in_progress" | "completed" }[] }
  | { sessionUpdate: "config_option_update"; configOptions: ConfigOption[] }
  | { sessionUpdate: string };
interface ConfigOption {
  id: string;
  name: string;
  type: "select" | "boolean";
  category?: string | null;
  currentValue: string | boolean;
  options?: ({ value: string; name: string } | { group: string; name: string; options: { value: string; name: string }[] })[];
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
}

export const DEFAULT_MODEL = "default";

/** Tool kinds that only read, or edit files: allowed without asking in Auto-edit. */
const AUTO_EDIT_KINDS = new Set<ToolKind>(["read", "search", "think", "fetch", "edit", "move"]);

export function pickPermission(
  mode: PermissionMode,
  kind: ToolKind | null | undefined,
): "allow" | "ask" {
  if (mode === "full") return "allow";
  if (mode === "auto-edit" && kind && AUTO_EDIT_KINDS.has(kind)) return "allow";
  return "ask";
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

interface Live {
  conn: StdioRpc;
  init: InitializeResult;
  sessionId: string | null;
  configOptions: ConfigOption[];
  /** Whether this session was opened with the harness's tool server attached. */
  /** The MCP servers the session was opened with, to notice when they change. */
  mcpSignature: string;
  /** The turn currently receiving this connection's updates. */
  turn: TurnState | null;
  idleTimer?: NodeJS.Timeout;
}

interface TurnState {
  input: TurnInput;
  text: string;
  thought: string;
  tools: Map<string, { name: string; done: boolean }>;
  usage: { used: number; costUsd: number | null };
}

const IDLE_MS = 10 * 60_000;

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
    toolServer?: () => Promise<{ url: string; token: string }>;
    /** The credential plan for the next agent process; absent = inherit process.env. */
    injection?: () => InjectionPlan;
  },
): AgentDriver {
  const live = new Map<string, Live>();
  let knownModels: ModelOption[] = [];
  // Once-per-driver, like Claude: the same feature-loss notice isn't repeated.
  const shownNotices = new Set<string>();

  const flushText = (t: TurnState) => {
    if (t.thought.trim()) t.input.onEvent({ kind: "thinking", text: t.thought });
    if (t.text.trim()) t.input.onEvent({ kind: "assistant-text", text: t.text });
    t.text = "";
    t.thought = "";
  };

  const onUpdate = (l: Live, update: SessionUpdate) => {
    const t = l.turn;
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = (update as { content: { text?: string } }).content.text ?? "";
        if (t && text) {
          t.text += text;
          t.input.onTextDelta(text);
        }
        return;
      }
      case "agent_thought_chunk":
        if (t) t.thought += (update as { content: { text?: string } }).content.text ?? "";
        return;
      case "tool_call":
      case "tool_call_update": {
        if (!t) return;
        const u = update as ToolCallFields & { sessionUpdate: string };
        let tool = t.tools.get(u.toolCallId);
        if (!tool) {
          flushText(t);
          tool = { name: u.title ?? u.kind ?? "tool", done: false };
          t.tools.set(u.toolCallId, tool);
          t.input.onEvent({ kind: "tool-use", toolUseId: u.toolCallId, name: kindLabel(u.kind), summary: u.title ?? "" });
        }
        if (!tool.done && (u.status === "completed" || u.status === "failed")) {
          tool.done = true;
          const text = (u.content ?? []).map((c) => c.content?.text ?? "").join(" ");
          t.input.onEvent({
            kind: "tool-result",
            toolUseId: u.toolCallId,
            isError: u.status === "failed",
            summary: summarizeToolResult(text) || (u.status === "failed" ? "Failed" : "Done"),
          });
        }
        return;
      }
      case "usage_update": {
        const u = update as { used: number; cost?: { amount: number; currency: string } | null };
        if (t) {
          t.usage.used = u.used;
          if (u.cost?.currency === "USD") t.usage.costUsd = u.cost.amount;
        }
        return;
      }
      case "plan":
        if (t) t.input.onEvent({ kind: "plan", entries: (update as { entries: PlanEntry[] }).entries });
        return;
      case "config_option_update":
        l.configOptions = (update as { configOptions: ConfigOption[] }).configOptions;
        knownModels = modelsFrom(l.configOptions) ?? knownModels;
        return;
      default:
        return;
    }
  };

  const connect = async (threadKey: string, input: TurnInput): Promise<Live> => {
    const existing = live.get(threadKey);
    if (existing?.conn.alive) return existing;

    const plan = deps.injection?.();
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
    // eslint-disable-next-line prefer-const
    let l: Live;
    const conn = StdioRpc.spawn(config.command, config.args, { cwd: input.cwd, env }, {
      onNotification: (method, params) => {
        if (method === "session/update") onUpdate(l, (params as { update: SessionUpdate }).update);
      },
      onRequest: async (method, params) => {
        if (method !== "session/request_permission") throw new RpcError(-32601, `${method} is not supported by this client`);
        const p = params as { toolCall: ToolCallFields; options: PermissionOption[] };
        const t = l.turn;
        const choose = async (): Promise<PermissionDecision> => {
          if (!t) return "deny";
          if (pickPermission(t.input.permissionMode, p.toolCall.kind) === "allow") return "allow-once";
          // The harness's own safe tools (browser snapshot, click, ...) run without asking.
          const title = `${p.toolCall.title ?? ""}`;
          if (t.input.tools.some((tool) => tool.autoAllow && title.includes(tool.name))) return "allow-once";
          return t.input.requestPermission({
            toolName: kindLabel(p.toolCall.kind),
            summary: p.toolCall.title ?? JSON.stringify(p.toolCall.rawInput ?? {}),
            canAlwaysAllow: p.options.some((o) => o.kind === "allow_always"),
          });
        };
        const optionId = optionFor(p.options, await choose());
        return optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } };
      },
      onExit: () => {
        if (live.get(threadKey) === l) live.delete(threadKey);
      },
    });
    const init = await conn.request<InitializeResult>("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "unskilled", version: deps.clientVersion },
    });
    l = { conn, init, sessionId: null, configOptions: [], mcpSignature: "[]", turn: null };
    const auth = init.authMethods?.[0];
    if (auth) await conn.request("authenticate", { methodId: auth.id }).catch(() => {});
    live.set(threadKey, l);
    return l;
  };

  const mcpServersFor = async (l: Live, input: TurnInput) => {
    const http = Boolean(l.init.agentCapabilities?.mcpCapabilities?.http);
    const servers: unknown[] = forAcp(input.mcpServers, http);
    if (input.tools.length && deps.toolServer && http) {
      const { url, token } = await deps.toolServer();
      servers.push({ type: "http", name: "unskilled", url, headers: [{ name: "Authorization", value: `Bearer ${token}` }] });
    }
    return servers;
  };

  const openSession = async (l: Live, input: TurnInput) => {
    const caps = l.init.agentCapabilities;
    const mcpServers = await mcpServersFor(l, input);
    const signature = JSON.stringify(mcpServers);
    if (l.sessionId) {
      // The MCP servers changed mid-conversation (the user opened the
      // browser, or edited their servers): reopen the same session with them.
      if (signature === l.mcpSignature || !caps?.sessionCapabilities?.resume || !caps.sessionCapabilities.close) return;
      await l.conn.request("session/close", { sessionId: l.sessionId }).catch(() => {});
      const res = await l.conn.request<{ configOptions?: ConfigOption[] }>("session/resume", { cwd: input.cwd, mcpServers, sessionId: l.sessionId });
      if (res?.configOptions) l.configOptions = res.configOptions;
      l.mcpSignature = signature;
      return;
    }
    const params = { cwd: input.cwd, mcpServers };
    l.mcpSignature = signature;
    if (input.sessionId && caps?.sessionCapabilities?.resume) {
      try {
        const res = await l.conn.request<{ configOptions?: ConfigOption[] }>("session/resume", { ...params, sessionId: input.sessionId });
        l.sessionId = input.sessionId;
        l.configOptions = res?.configOptions ?? [];
        return;
      } catch {
        // fall through to a new session
      }
    } else if (input.sessionId && caps?.loadSession) {
      try {
        const res = await l.conn.request<{ configOptions?: ConfigOption[] }>("session/load", { ...params, sessionId: input.sessionId });
        l.sessionId = input.sessionId;
        l.configOptions = res?.configOptions ?? [];
        return;
      } catch {
        // fall through
      }
    }
    if (input.sessionId) input.onEvent({ kind: "notice", text: `${config.label} couldn't resume the earlier conversation; this is a fresh session.` });
    const res = await l.conn.request<{ sessionId: string; configOptions?: ConfigOption[] }>("session/new", params);
    l.sessionId = res.sessionId;
    l.configOptions = res.configOptions ?? [];
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
    if (res?.configOptions) l.configOptions = res.configOptions;
  };

  let refreshing: Promise<void> | null = null;
  const refreshModels = (): Promise<void> => {
    if (knownModels.length) return Promise.resolve();
    // Checked outside the memoized refresh, so a fixed provider refreshes next time.
    // The turn surfaces the error; there's no process to start.
    const plan = deps.injection?.();
    if (plan?.error) return Promise.resolve();
    refreshing ??= (async () => {
      // One throwaway process: initialize + session/new, read the model
      // config option, then exit. Real threads spawn their own later.
      const env: NodeJS.ProcessEnv = { ...(plan?.env ?? process.env), ...config.env };
      if (config.skillsDirEnv && deps.skillsDir) {
        const dir = deps.skillsDir();
        if (dir) env[config.skillsDirEnv] = dir;
      }
      const cwd = homedir();
      const conn = StdioRpc.spawn(config.command, config.args, { cwd, env }, {
        onNotification: () => {},
        onRequest: async (method) => {
          throw new RpcError(-32601, `${method} is not supported during model refresh`);
        },
      });
      try {
        const init = await conn.request<InitializeResult>("initialize", {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: "unskilled", version: deps.clientVersion },
        });
        const auth = init.authMethods?.[0];
        if (auth) await conn.request("authenticate", { methodId: auth.id }).catch(() => {});
        const res = await conn.request<{ configOptions?: ConfigOption[] }>("session/new", { cwd, mcpServers: [] });
        knownModels = modelsFrom(res.configOptions) ?? knownModels;
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
    skillCallPrefix: "",
    models: () => [{ id: DEFAULT_MODEL, label: "Agent default" }, ...knownModels],
    refreshModels,
    async runTurn(input) {
      const key = input.threadId;
      let l: Live;
      try {
        l = await connect(key, input);
        await openSession(l, input);
        knownModels = modelsFrom(l.configOptions) ?? knownModels;
        input.onSession(l.sessionId!);
        await applyModel(l, input.model);
      } catch (err) {
        input.onEvent({ kind: "error", message: `${config.label} failed to start: ${err instanceof Error ? err.message : String(err)}` });
        live.get(key)?.conn.close();
        live.delete(key);
        return;
      }
      clearTimeout(l.idleTimer);
      const turn: TurnState = { input, text: "", thought: "", tools: new Map(), usage: { used: 0, costUsd: null } };
      l.turn = turn;
      const started = Date.now();
      const onAbort = () => l.conn.notify("session/cancel", { sessionId: l.sessionId });
      input.signal.addEventListener("abort", onAbort, { once: true });
      try {
        // The user may have aborted while the agent was still starting up; the
        // listener above missed it, so stop before sending the prompt.
        if (input.signal.aborted) {
          input.onEvent({ kind: "notice", text: "Stopped." });
          return;
        }
        input.onEvent({ kind: "turn-start", turnId: randomUUID(), agent: config.id, model: input.model });
        const res = await l.conn.request<{
          stopReason: string;
          usage?: { inputTokens?: number; outputTokens?: number; cachedReadTokens?: number; cachedWriteTokens?: number } | null;
        }>("session/prompt", { sessionId: l.sessionId, prompt: [{ type: "text", text: input.prompt }] });
        flushText(turn);
        if (res.stopReason === "cancelled") input.onEvent({ kind: "notice", text: "Stopped." });
        else if (res.stopReason === "refusal") input.onEvent({ kind: "error", message: `${config.label} declined this request.` });
        else if (res.stopReason === "max_tokens" || res.stopReason === "max_turn_requests") {
          input.onEvent({ kind: "notice", text: `${config.label} stopped early (${res.stopReason.replace(/_/g, " ")}).` });
        }
        // `usage_update.used` is context-window occupancy, not per-turn input:
        // only the prompt response's usage is a real input count.
        const usage = res.usage
          ? normalizeUsage({
              inputTokens: res.usage.inputTokens ?? 0,
              outputTokens: res.usage.outputTokens ?? 0,
              cacheReadTokens: res.usage.cachedReadTokens ?? null,
              cacheWriteTokens: res.usage.cachedWriteTokens ?? null,
              provenance: "reported",
            })
          : normalizeUsage({ inputTokens: 0, outputTokens: 0, provenance: "unavailable" });
        input.onEvent({
          kind: "turn-end",
          costUsd: turn.usage.costUsd,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          durationMs: Date.now() - started,
          usage,
        });
      } catch (err) {
        flushText(turn);
        input.onEvent({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
        input.signal.removeEventListener("abort", onAbort);
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
    },
  };
}

function kindLabel(kind: ToolKind | null | undefined): string {
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
