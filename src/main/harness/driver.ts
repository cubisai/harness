// One saved provider as its own agent ("TokenHarbor" next to Claude, Codex and
// OpenCode), run on CubiQ's own loop: the provider's models, our tools, the
// app's guide, memory, browser and MCP tools, and a JSONL session per thread.

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ModelOption, Provider } from "../../shared/types";
import { SAFE_DEFAULTS, withCapabilities } from "../agents/capabilities";
import type { AgentDriver, HarnessTool, TurnInput } from "../agents/types";
import { normalizeUsage } from "../usage";
import { wireIdOf } from "../providers";
import { routeFor, streamLlm } from "./llm/client";
import { emptyUsage, LlmError, type Effort, type HarnessProtocol, type LlmMessage, type LlmUsage } from "./llm/types";
import { runLoop, type Authorization, type LoopTool } from "./loop";
import { decide, refusal } from "./permissions";
import { systemPrompt } from "./prompt";
import { SessionStore, repairHistory } from "./session";
import { compactedHistory, splitForCompaction, summaryPrompt } from "./context/compact";
import { estimateMessages, estimateText } from "./context/estimate";
import { contextFiles } from "./context/files";
import { pruneToolOutputs } from "./context/prune";
import { nativeTools, shellFor, todosOf, type NativeTool, type ToolContext } from "./tools";
import { resolvePath } from "./tools/paths";

/** Agent ids of provider agents: `provider-<providerId>`. */
export const PROVIDER_AGENT_PREFIX = "provider-";
export const providerAgentId = (providerId: string): string => `${PROVIDER_AGENT_PREFIX}${providerId}`;

export interface ProviderDriverDeps {
  /** The provider as saved now (undefined once removed). */
  provider(): Provider | undefined;
  secret(): string | null;
  secretHeaders(): Record<string, string>;
  sessions: SessionStore;
  /** Where long tool output is saved for paging. */
  outputDir: string;
  guardScript: string;
  guide(cwd: string, design?: string): string | null;
  memory(projectId: string): string | null;
  /** The app's MCP router tools (search_tools / call_mcp_tool) for a project; empty when it has no servers. */
  mcpTools(projectId?: string): HarnessTool[];
  /** The model-invoked skills tool for this folder, or null when there are none. */
  skills?(cwd: string, design: boolean): HarnessTool | null;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Tests. */
  stream?: typeof streamLlm;
}

const EFFORTS = ["low", "medium", "high"];

/** Sum two usages, keeping "never reported" (null) distinct from zero. */
const addUsage = (a: LlmUsage, b: LlmUsage): LlmUsage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: a.cacheReadTokens === null && b.cacheReadTokens === null ? null : (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0),
  cacheWriteTokens: a.cacheWriteTokens === null && b.cacheWriteTokens === null ? null : (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0),
  reasoningTokens: a.reasoningTokens === null && b.reasoningTokens === null ? null : (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0),
});

const CAPABILITIES = withCapabilities(SAFE_DEFAULTS, {
  resume: true,
  interrupt: true,
  perMessageModel: true,
  vision: true,
  liveReasoning: true,
  preToolGuard: true,
  manualCompact: true,
  permissionGranularity: "perTool",
  guardEnforcement: { ask: "block", "auto-edit": "block", plan: "block", full: "block" },
  seeding: "first-message",
});

/** The protocol a provider's calls use; Gemini isn't spoken natively yet. */
function protocolOf(provider: Provider): HarnessProtocol | null {
  return provider.wireProtocol === "gemini" ? null : provider.wireProtocol;
}

export function createProviderDriver(providerId: string, deps: ProviderDriverDeps): AgentDriver {
  const id = providerAgentId(providerId);
  // Files read per session, kept across turns so an edit next turn needs no re-read (a restart forgets them).
  const readsBySession = new Map<string, Map<string, number>>();
  const current = (): Provider | undefined => deps.provider();

  const models = (): ModelOption[] =>
    (current()?.models ?? []).map((m) => ({
      id: m.id,
      label: m.name ?? m.id,
      contextWindow: current()?.contextWindowOverride ?? m.contextWindow,
      ...(m.capabilities.reasoning ? { efforts: EFFORTS } : {}),
      ...(m.cost ? { cost: m.cost } : {}),
    }));

  return {
    id,
    get label() {
      return current()?.label ?? providerId;
    },
    models,
    get defaultModel() {
      return current()?.models[0]?.id ?? "";
    },
    capabilities: CAPABILITIES,
    // No credential row: a provider agent always uses its own key.
    credentials: { byok: false, own: "config", injector: "acp" },
    skillsDelivery: { mode: "tool", prefix: "", reads: [] },
    skillCallPrefix: "",
    async runTurn(input) {
      const started = Date.now();
      const turnId = randomUUID();
      input.onEvent({ kind: "turn-start", turnId, agent: id, model: input.model });
      try {
        await runTurn(providerId, deps, input, turnId, started, readsBySession);
      } catch (err) {
        input.onEvent({ kind: "error", message: errorText(err) });
        input.onEvent({ kind: "turn-end", costUsd: null, inputTokens: 0, outputTokens: 0, durationMs: Date.now() - started });
      }
    },
  };
}

function errorText(err: unknown): string {
  if (err instanceof LlmError && err.kind === "overflow") return `${err.message} The conversation is longer than the model's context window; start a new thread or switch to a model with a larger one.`;
  if (err instanceof LlmError && err.kind === "auth") return `${err.message} Check the provider's key in Settings → Providers.`;
  return err instanceof Error ? err.message : String(err);
}

async function runTurn(
  providerId: string,
  deps: ProviderDriverDeps,
  input: TurnInput,
  turnId: string,
  started: number,
  readsBySession: Map<string, Map<string, number>>,
): Promise<void> {
  const provider = deps.provider();
  if (!provider) throw new Error("This provider was removed in Settings. Pick another agent for this thread.");
  const protocol = protocolOf(provider);
  if (!protocol) throw new Error(`${provider.label} speaks the Gemini protocol, which CubiQ's own agent doesn't support yet.`);
  const entry = provider.models.find((m) => m.id === input.model) ?? provider.models[0];
  if (!entry) throw new Error(`${provider.label} has no models saved. Add one in Settings → Providers.`);
  const wire = wireIdOf(entry, entry.id);
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const route = routeFor(provider, protocol, wire, deps.secret(), deps.secretHeaders(), env);
  const shell = shellFor(platform, env).name;
  const guide = deps.guide(input.cwd, input.design);
  const memory = input.projectId ? deps.memory(input.projectId) : null;
  const files = contextFiles(input.cwd);
  const system = systemPrompt({
    cwd: input.cwd,
    platform,
    shell,
    model: entry.name ?? entry.id,
    modelId: wire,
    guide,
    memory,
    contextFiles: files,
  });

  const contextSize = provider.contextWindowOverride ?? entry.contextWindow;
  const costOf = (u: LlmUsage): number | null =>
    entry.cost ? (u.inputTokens * entry.cost.input + (u.cacheReadTokens ?? 0) * (entry.cost.cacheRead ?? entry.cost.input) + (u.cacheWriteTokens ?? 0) * entry.cost.input + u.outputTokens * entry.cost.output) / 1e6 : null;
  const contextOf = (u: LlmUsage): number => u.inputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
  // The summary call's usage, folded into the turn's reported usage and cost.
  let extraUsage = emptyUsage();
  // The estimate right after the last auto compaction, so a turn doesn't compact
  // again until the history has grown meaningfully past that point.
  let compactedAt: number | null = null;

  // /compact works on an existing session; a normal turn resumes one or starts a new one.
  let sid: string;
  let messages: LlmMessage[];
  let createdNew = false;
  if (input.compact) {
    const loaded = input.sessionId ? deps.sessions.load(input.sessionId) : null;
    if (!input.sessionId || !loaded || loaded.length === 0) {
      input.onEvent({ kind: "notice", text: "Nothing to compact yet." });
      input.onEvent({ kind: "turn-end", costUsd: null, inputTokens: 0, outputTokens: 0, durationMs: Date.now() - started });
      return;
    }
    sid = input.sessionId;
    messages = repairHistory(loaded);
  } else {
    let sessionId = input.sessionId;
    let history = sessionId ? deps.sessions.load(sessionId) : null;
    let prompt = input.prompt;
    if (!sessionId || !history) {
      const lostReason = sessionId ? "The session's history file is gone." : null;
      sessionId = deps.sessions.create();
      history = [];
      createdNew = true;
      if (lostReason) {
        const seed = await input.onSessionLost?.(lostReason);
        if (seed && "promptPrefix" in seed) prompt = `${seed.promptPrefix}\n\n${prompt}`;
      }
      input.onSession(sessionId);
    }
    sid = sessionId;
    messages = repairHistory(history);
    const userMessage: LlmMessage = { role: "user", content: [{ type: "text", text: prompt }] };
    messages.push(userMessage);
    deps.sessions.append(sid, userMessage);
  }

  // Summarise the head of the history into one message, keep the tail verbatim.
  const compact = async (trigger: "manual" | "auto" | "unknown", focus: string | null): Promise<boolean> => {
    const { head, tail } = splitForCompaction(messages);
    if (head.length === 0) return false;
    const p = summaryPrompt(head, { focus, maxTokens: contextSize ? Math.floor(contextSize * 0.6) : 60_000 });
    const preTokens = estimateMessages(messages);
    let summary = "";
    for await (const e of (deps.stream ?? streamLlm)(
      route,
      {
        model: wire,
        system: [p.system],
        messages: [{ role: "user", content: [{ type: "text", text: p.user }] }],
        tools: [],
        maxTokens: Math.min(entry.maxOutput ?? 8_000, 8_000),
        reasoning: false,
        cacheKey: sid,
      },
      { signal: input.signal },
    )) {
      if (e.type === "finish") {
        summary = e.message.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
        extraUsage = addUsage(extraUsage, e.usage);
      }
    }
    if (!summary.trim()) throw new Error("Compacting failed: the model returned an empty summary.");
    const next = compactedHistory(summary, tail);
    messages.splice(0, messages.length, ...next);
    deps.sessions.replace(sid, messages);
    if (trigger === "auto") compactedAt = estimateMessages(messages);
    input.onEvent({ kind: "compaction", trigger, preTokens, postTokens: estimateMessages(messages) });
    return true;
  };

  if (input.compact) {
    const ok = await compact("manual", input.compact.focus);
    if (!ok) input.onEvent({ kind: "notice", text: "The conversation is too short to compact." });
    input.onEvent({ kind: "turn-end", costUsd: costOf(extraUsage), inputTokens: extraUsage.inputTokens, outputTokens: extraUsage.outputTokens, durationMs: Date.now() - started });
    return;
  }

  let reads = readsBySession.get(sid);
  if (!reads) readsBySession.set(sid, (reads = new Map<string, number>()));
  const toolCtx = (callId: string, signal: AbortSignal, onOutput: (t: string) => void): ToolContext => ({
    cwd: input.cwd,
    signal,
    outputDir: deps.outputDir,
    callId,
    reads,
    guardScript: deps.guardScript,
    onOutput,
    env,
    platform,
  });
  const nativeLoop = nativeTools(wire).map((t) => nativeLoopTool(t, toolCtx, input));
  const appTools = [...input.tools, ...deps.mcpTools(input.projectId)].map((t) => appLoopTool(t, input));
  const skill = deps.skills?.(input.cwd, Boolean(input.design)) ?? null;
  const skillLoop = skill ? appLoopTool(skill, input) : null;
  const tools = [...nativeLoop, ...appTools, ...(skillLoop ? [skillLoop] : [])].filter((t, i, all) => all.findIndex((o) => o.definition.name === t.definition.name) === i);

  // A brand-new session's first turn gets a one-line token breakdown of what it starts with.
  if (createdNew) {
    const rows: { label: string; tokens: number }[] = [];
    const push = (label: string, tokens: number): void => {
      if (tokens > 0) rows.push({ label, tokens });
    };
    push("System prompt", estimateText(system[0] ?? ""));
    push("Guide", estimateText(guide ?? ""));
    push("Project files", files.reduce((n, f) => n + estimateText(f.text), 0));
    push("Memory", estimateText(memory ?? ""));
    push("Tools", estimateText(JSON.stringify(nativeLoop.map((t) => t.definition))));
    push("App tools", estimateText(JSON.stringify(appTools.map((t) => t.definition))));
    push("Skills", skillLoop ? estimateText(JSON.stringify(skillLoop.definition)) : 0);
    input.onEvent({ kind: "context-breakdown", rows, total: rows.reduce((n, r) => n + r.tokens, 0), estimated: true });
  }

  const authorize = async (tool: LoopTool, args: Record<string, unknown>, summary: string): Promise<Authorization> => {
    const verdict = decide(input.permissionMode, tool.access, tool.outside?.(args) ?? false);
    if (verdict === "allow") return { ok: true };
    if (verdict === "deny") return { ok: false, reason: refusal(input.permissionMode, "deny") };
    const decision = await input.requestPermission({ toolName: tool.displayName, summary, canAlwaysAllow: true });
    return decision === "deny" ? { ok: false, reason: refusal(input.permissionMode, "denied-by-user") } : { ok: true };
  };

  // Auto-compaction: keep the real context under this cap by pruning, then summarising.
  const definitions = tools.map((t) => t.definition);
  const overhead = estimateText(system.join("\n")) + estimateText(JSON.stringify(definitions));
  const limit = contextSize > 0 ? Math.max(Math.floor(contextSize * 0.75), contextSize - 20_000) : null;
  const prepareFor = (cap: number) =>
    async (msgs: LlmMessage[], last: LlmUsage | null): Promise<void> => {
      // The previous call's real context is only good for deciding whether to
      // act: it was measured before pruning, so it can't judge the result.
      if (Math.max(estimateMessages(msgs) + overhead, last ? contextOf(last) : 0) <= cap) return;
      const pruned = pruneToolOutputs(msgs);
      if (pruned.pruned > 0) {
        msgs.splice(0, msgs.length, ...pruned.messages);
        deps.sessions.replace(sid, msgs);
      }
      if (estimateMessages(msgs) + overhead <= cap) return;
      // Don't auto-compact again until the history grows past the last summary.
      if (compactedAt !== null && estimateMessages(msgs) < compactedAt + Math.floor(cap * 0.2)) return;
      await compact("auto", null);
    };

  const result = await runLoop({
    route,
    request: {
      model: wire,
      system,
      ...(entry.maxOutput ? { maxTokens: entry.maxOutput } : {}),
      reasoning: entry.capabilities.reasoning,
      ...(entry.capabilities.reasoning && input.effort ? { effort: input.effort as Effort } : {}),
      cacheKey: sid,
    },
    messages,
    tools,
    signal: input.signal,
    turnId,
    authorize,
    emit: {
      event: (e) => input.onEvent(e),
      textDelta: (text, itemId) => input.onTextDelta(text, itemId),
      reasoningDelta: (itemId, text) => input.onReasoningDelta?.({ itemId, text, opaque: false }),
      toolInputDelta: (toolUseId, text) => input.onToolInputDelta?.({ toolUseId, text }),
      toolOutputDelta: (toolUseId, text) => input.onToolOutputDelta?.({ toolUseId, text }),
      usage: (u) =>
        input.onUsageUpdate?.({
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          cacheReadTokens: u.cacheReadTokens,
          cacheWriteTokens: u.cacheWriteTokens,
          reasoningTokens: u.reasoningTokens,
          costUsd: costOf(u),
          contextSize,
        }),
    },
    onMessage: (m) => deps.sessions.append(sid, m),
    ...(limit !== null ? { prepare: prepareFor(limit) } : {}),
    onOverflow: () => compact("auto", null),
    ...(deps.stream ? { stream: deps.stream } : {}),
  });

  if (result.stop === "stopped") input.onEvent({ kind: "notice", text: "Stopped." });
  const totalUsage = addUsage(result.usage, extraUsage);
  const usage = { ...normalizeUsage(totalUsage), ...(result.last ? { contextUsed: contextOf(result.last) } : {}), contextSize };
  input.onEvent({ kind: "turn-end", costUsd: costOf(totalUsage), inputTokens: totalUsage.inputTokens, outputTokens: totalUsage.outputTokens, durationMs: Date.now() - started, usage });
}

/** A built-in tool in the loop; TodoWrite also updates the thread's plan. */
function nativeLoopTool(tool: NativeTool, ctxFor: (callId: string, signal: AbortSignal, onOutput: (t: string) => void) => ToolContext, input: TurnInput): LoopTool {
  return {
    definition: { name: tool.name, description: tool.description, parameters: tool.parameters },
    displayName: tool.displayName,
    access: tool.access,
    summarize: (args) => tool.summarize(args),
    ...(tool.displayName === "Bash" ? { inputPayload: (args: Record<string, unknown>) => ({ command: String(args.command ?? "") }) } : {}),
    outside: (args) => {
      if (tool.access !== "edit" || typeof args.path !== "string") return false;
      try {
        return resolvePath(input.cwd, args.path).outside;
      } catch {
        return false;
      }
    },
    run: async (args, call) => {
      const result = await tool.run(args, ctxFor(call.id, call.signal, call.onOutput));
      if (tool.name === "todowrite") input.onEvent({ kind: "plan", entries: todosOf(args) });
      return result;
    },
  };
}

/** One of the app's tools (browser, memory, design, MCP router) in the loop. */
function appLoopTool(tool: HarnessTool, input: TurnInput): LoopTool {
  let parameters: Record<string, unknown>;
  try {
    const { $schema: _schema, ...schema } = z.toJSONSchema(z.object(tool.input), { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
    parameters = schema;
  } catch {
    parameters = { type: "object", properties: {} };
  }
  return {
    definition: { name: tool.name, description: tool.description, parameters },
    displayName: tool.name,
    // Safe tools run in any mode; the rest ask in "ask" mode, like an edit.
    access: tool.autoAllow ? "read" : "edit",
    summarize: (args) => {
      const first = Object.values(args).find((v) => typeof v === "string");
      return typeof first === "string" ? first : tool.name;
    },
    run: async (args, call) => {
      const parsed = z.object(tool.input).safeParse(args);
      if (!parsed.success) return { text: `Invalid arguments for ${tool.name}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`, isError: true };
      const out = await tool.run(parsed.data as never, { ...(input.projectId ? { projectId: input.projectId } : {}), threadId: input.threadId, signal: call.signal });
      return { text: out.text, ...(out.isError ? { isError: true } : {}), ...(out.imagePng ? { imagePng: out.imagePng } : {}) };
    },
  };
}
