// One saved provider as its own agent ("TokenHarbor" next to Claude, Codex and
// OpenCode), run on CubiQ's own loop: the provider's models, our tools, the
// app's guide, memory, browser and MCP tools, and a JSONL session per thread.

import { randomUUID } from "node:crypto";
import { CODE_HINT } from "../code-hint";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { CodeMode, ModelOption, PermissionMode, Provider } from "../../shared/types";
import { SAFE_DEFAULTS, withCapabilities } from "../agents/capabilities";
import type { AgentDriver, HarnessTool, TurnInput } from "../agents/types";
import { askUserTool } from "../questions";
import { normalizeUsage } from "../usage";
import { wireIdOf } from "../providers";
import { routeFor, streamLlm } from "./llm/client";
import { emptyUsage, LlmError, type Effort, type HarnessProtocol, type LlmMessage, type LlmRequest, type LlmUsage } from "./llm/types";
import { runLoop, type Authorization, type LoopTool } from "./loop";
import { decide, refusal } from "./permissions";
import { createProposePlanTool, PLAN_MODE_NOTE } from "./plan";
import { systemPrompt } from "./prompt";
import { SessionStore, repairHistory } from "./session";
import { createTaskTool } from "./subagent";
import { prefixKey, unbindThinking } from "./context/binding";
import { compactedHistory, splitForCompaction, summaryPrompt } from "./context/compact";
import { estimateMessages, estimateText } from "./context/estimate";
import { contextFiles } from "./context/files";
import { pruneToolOutputs, retentionFor } from "./context/prune";
import { nativeTools, shellFor, todosOf, type NativeTool, type ToolContext } from "./tools";
import { bound } from "./tools/bound";
import { createCodeTool } from "./tools/code";
import { createCodeBroker } from "./tools/code-broker";
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
  memory(projectId: string, threadId?: string, sessionKey?: string | null): string | null;
  /** The app's MCP router tools (search_tools / call_mcp_tool) for a project; empty when it has no servers. */
  mcpTools(projectId?: string): HarnessTool[];
  /** The model-invoked skills tool for this folder, or null when there are none; `threadId` adds that thread's expert's own skills. */
  skills?(cwd: string, design: boolean, threadId?: string): HarnessTool | null;
  /** The thread's code mode: "on" offers the `run_code` sandbox tool. */
  codeMode?: (threadId: string) => CodeMode;
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
  planMode: "native",
  permissionGranularity: "perTool",
  guardEnforcement: { ask: "block", "auto-edit": "block", plan: "block", full: "block" },
  seeding: "first-message",
  subagentTeams: true,
});

/** The protocol a provider's calls use; Gemini isn't spoken natively yet. */
function protocolOf(provider: Provider): HarnessProtocol | null {
  return provider.wireProtocol === "gemini" ? null : provider.wireProtocol;
}

export function createProviderDriver(providerId: string, deps: ProviderDriverDeps): AgentDriver {
  const id = providerAgentId(providerId);
  // Files read per session, kept across turns so an edit next turn needs no re-read (a restart forgets them).
  const readsBySession = new Map<string, Map<string, number>>();
  // run_code's store/load values, per session, the same way.
  const codeStateBySession = new Map<string, Map<string, string>>();
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
    // One hidden call with no tools, for background work (self-improve's lesson drafts).
    async oneShot(req) {
      const provider = current();
      if (!provider) throw new Error("This provider was removed in Settings.");
      const protocol = protocolOf(provider);
      if (!protocol) throw new Error(`${provider.label} speaks the Gemini protocol, which CubiQ's own agent doesn't support yet.`);
      const entry = provider.models.find((m) => m.id === req.model) ?? provider.models[0];
      if (!entry) throw new Error(`${provider.label} has no models saved.`);
      const wire = wireIdOf(entry, entry.id);
      const route = routeFor(provider, protocol, wire, deps.secret(), deps.secretHeaders(), deps.env ?? process.env);
      let text = "";
      for await (const e of (deps.stream ?? streamLlm)(
        route,
        { model: wire, system: [], messages: [{ role: "user", content: [{ type: "text", text: req.prompt }] }], tools: [], maxTokens: Math.min(entry.maxOutput ?? 4_000, 4_000), reasoning: false, cache: "none" },
        { signal: req.signal },
      )) {
        if (e.type === "finish") text = e.message.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
      }
      return text;
    },
    async runTurn(input) {
      const started = Date.now();
      const turnId = randomUUID();
      input.onEvent({ kind: "turn-start", turnId, agent: id, model: input.model });
      try {
        await runTurn(providerId, deps, input, turnId, started, readsBySession, codeStateBySession);
      } catch (err) {
        input.onEvent({ kind: "error", message: errorText(err) });
        input.onEvent({ kind: "turn-end", costUsd: null, inputTokens: 0, outputTokens: 0, durationMs: Date.now() - started });
      }
    },
  };
}

/** One line of text for a thread row: the first line, trimmed to a summary length. */
const oneLine = (text: string, max = 160): string => {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

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
  codeStateBySession: Map<string, Map<string, string>>,
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
  const guide = input.expert ? [deps.guide(input.cwd, input.design), input.expert].filter(Boolean).join("\n\n") : deps.guide(input.cwd, input.design);
  const files = contextFiles(input.cwd);

  const contextSize = provider.contextWindowOverride ?? entry.contextWindow;
  const priceOf = (e: typeof entry, u: LlmUsage): number | null =>
    e.cost ? (u.inputTokens * e.cost.input + (u.cacheReadTokens ?? 0) * (e.cost.cacheRead ?? e.cost.input) + (u.cacheWriteTokens ?? 0) * e.cost.input + u.outputTokens * e.cost.output) / 1e6 : null;
  const costOf = (u: LlmUsage): number | null => priceOf(entry, u);
  const contextOf = (u: LlmUsage): number => u.inputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
  // The summary call's usage, folded into the turn's reported usage and cost.
  let extraUsage = emptyUsage();
  // Subagents' usage and cost, each priced on the model it ran on (a member may name its own); null once one is unpriced.
  let childUsage = emptyUsage();
  let childCost: number | null = 0;
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

  // The session's date is frozen when it starts, so the prompt doesn't change at midnight.
  let meta = deps.sessions.meta(sid);
  if (!meta.startedOn) {
    meta = { ...meta, startedOn: new Date().toISOString().slice(0, 10) };
    deps.sessions.setMeta(sid, meta);
  }
  // Read after the session id is settled so the block is frozen per session:
  // resuming a session gets the same block it first saw, a new one computes it.
  const memory = input.projectId ? deps.memory(input.projectId, input.threadId, sid) : null;
  // Fixed for a thread at creation, so the hint below keeps the cache prefix stable.
  const codeMode = deps.codeMode?.(input.threadId) ?? "off";
  const system = systemPrompt({
    cwd: input.cwd,
    platform,
    shell,
    model: entry.name ?? entry.id,
    modelId: wire,
    guide,
    memory,
    contextFiles: files,
    date: new Date(`${meta.startedOn}T00:00:00Z`),
  });
  // Code mode: one fixed line on when a run_code script beats the shell.
  if (codeMode !== "off") system.push(CODE_HINT);
  // Plan mode's note goes last, after the environment, so the stable parts keep their cache prefix.
  if (input.permissionMode === "plan") system.push(PLAN_MODE_NOTE);

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

  // One request object for the whole turn: the loop spreads it per step, so the
  // `system` array is shared and plan approval can splice its note out in place.
  const request: Omit<LlmRequest, "messages" | "tools"> = {
    model: wire,
    system,
    ...(entry.maxOutput ? { maxTokens: entry.maxOutput } : {}),
    reasoning: entry.capabilities.reasoning,
    ...(entry.capabilities.reasoning && input.effort ? { effort: input.effort as Effort } : {}),
    cacheKey: sid,
  };
  // The subagent shares the turn's route and sampling options but writes its own
  // system prompt, so its request is this one without `system`.
  const { system: _system, ...subagentRequest } = request;

  let reads = readsBySession.get(sid);
  if (!reads) readsBySession.set(sid, (reads = new Map<string, number>()));
  const toolCtx = (callId: string, signal: AbortSignal, onOutput: (t: string) => void, script?: boolean): ToolContext => ({
    ...(script ? { script } : {}),
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
  // The turn's live mode: plan mode's propose_plan flips it once the user approves.
  let mode: PermissionMode = input.permissionMode;
  const planLoop = input.permissionMode === "plan" ? createProposePlanTool({ mode: () => mode, decide: (plan) => input.requestPlanDecision({ plan }), signal: input.signal, onApproved: (m) => {
    mode = m;
    // The note goes out of the shared array so later calls in the turn no longer
    // tell the model editing is off.
    const i = system.indexOf(PLAN_MODE_NOTE);
    if (i >= 0) system.splice(i, 1);
  } }) : null;
  const appTools = [...input.tools, ...deps.mcpTools(input.projectId)].map((t) => appLoopTool(t, input, deps.outputDir));
  const askLoop = input.requestUserInput ? appLoopTool(askUserTool((_threadId, questions) => input.requestUserInput!(questions)), input, deps.outputDir) : null;
  const skill = deps.skills?.(input.cwd, Boolean(input.design), input.threadId) ?? null;
  const skillLoop = skill ? appLoopTool(skill, input, deps.outputDir) : null;
  // The task tool is read-only and runs in every mode; it hands its children the
  // three read-only native tools only, never the app's tools or propose_plan. A
  // team thread's members also get the team channel tools (team_write and co).
  const taskLoop = createTaskTool({
    route,
    request: subagentRequest,
    tools: () => nativeLoop.filter((t) => ["read", "glob", "grep"].includes(t.definition.name)),
    cwd: input.cwd,
    emit: (e) => input.onEvent(e),
    live: {
      text: (text, itemId, parentId) => input.onTextDelta(text, itemId, parentId),
      reasoning: (itemId, text, parentId) => input.onReasoningDelta?.({ itemId, text, opaque: false, parentId }),
      toolOutput: (toolUseId, text, parentId) => input.onToolOutputDelta?.({ toolUseId, text, parentId }),
    },
    onUsage: (u, cost) => {
      childUsage = addUsage(childUsage, u);
      const c = cost === undefined ? costOf(u) : cost;
      childCost = childCost === null || c === null ? null : childCost + c;
    },
    costOf: (u, wire) => priceOf(provider.models.find((m) => wireIdOf(m, m.id) === wire) ?? entry, u),
    ...(deps.stream ? { stream: deps.stream } : {}),
    ...(input.team?.length
      ? {
          team: input.team,
          memberTools: () => appTools.filter((t) => t.definition.name.startsWith("team_")),
          // A member's own model, resolved the way the lead's was: the provider's
          // entry for that id, its wire id and whether it reasons.
          routeFor: (modelId: string) => {
            const entry = provider.models.find((m) => m.id === modelId);
            if (!entry) return null;
            const memberWire = wireIdOf(entry, entry.id);
            return { route: routeFor(provider, protocol, memberWire, deps.secret(), deps.secretHeaders(), env), model: memberWire, reasoning: entry.capabilities.reasoning };
          },
        }
      : {}),
  });
  // Code mode: one sandboxed script can chain the other tools. Every call the
  // script makes goes back through authorize, so ask mode still asks and the
  // thread still shows each call.
  let codeState = codeStateBySession.get(sid);
  if (!codeState) codeStateBySession.set(sid, (codeState = new Map<string, string>()));
  const codeLoop: LoopTool | null =
    codeMode !== "off"
      ? createCodeTool({
          tools: () => scriptable,
          outputDir: deps.outputDir,
          state: codeState,
          broker: createCodeBroker({ tools: () => scriptable, emit: (e) => input.onEvent(e), authorize: (tool, args, summary) => authorize(tool, args, summary), outputDir: deps.outputDir }),
        })
      : null;
  const scriptable: LoopTool[] = [...nativeLoop, ...appTools, ...(skillLoop ? [skillLoop] : []), ...(planLoop ? [planLoop] : []), ...(askLoop ? [askLoop] : []), taskLoop, ...(codeLoop ? [codeLoop] : [])].filter((t, i, all) => all.findIndex((o) => o.definition.name === t.definition.name) === i);
  const tools: LoopTool[] = scriptable;

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
    push("Tools", estimateText(JSON.stringify([...nativeLoop, taskLoop].map((t) => t.definition))));
    push("App tools", estimateText(JSON.stringify(appTools.map((t) => t.definition))));
    push("Skills", skillLoop ? estimateText(JSON.stringify(skillLoop.definition)) : 0);
    input.onEvent({ kind: "context-breakdown", rows, total: rows.reduce((n, r) => n + r.tokens, 0), estimated: true });
  }

  const authorize = async (tool: LoopTool, args: Record<string, unknown>, summary: string): Promise<Authorization> => {
    const verdict = decide(mode, tool.access, tool.outside?.(args) ?? false);
    if (verdict === "allow") return { ok: true };
    if (verdict === "deny") return { ok: false, reason: refusal(mode, "deny") };
    const decision = await input.requestPermission({ toolName: tool.displayName, summary, canAlwaysAllow: true });
    return decision === "deny" ? { ok: false, reason: refusal(mode, "denied-by-user") } : { ok: true };
  };

  // Auto-compaction: keep the real context under this cap by pruning, then summarising.
  const definitions = tools.map((t) => t.definition);
  const overhead = estimateText(system.join("\n")) + estimateText(JSON.stringify(definitions));
  const limit = contextSize > 0 ? Math.max(Math.floor(contextSize * 0.75), contextSize - 20_000) : null;
  let prunedThisTurn = 0;
  const shrink = async (msgs: LlmMessage[], last: LlmUsage | null, cap: number): Promise<void> => {
    // The previous call's real context is only good for deciding whether to
    // act: it was measured before pruning, so it can't judge the result.
    if (Math.max(estimateMessages(msgs) + overhead, last ? contextOf(last) : 0) <= cap) return;
    // Keep the full text of a pruned result on disk so the marker can name it.
    const pruned = pruneToolOutputs(msgs, {
      ...retentionFor(contextSize),
      save: (r) => {
        try {
          const path = join(deps.outputDir, `${r.callId.replace(/[^\w.-]/g, "_")}.pruned.txt`);
          mkdirSync(deps.outputDir, { recursive: true });
          writeFileSync(path, r.text);
          return path;
        } catch {
          return null;
        }
      },
    });
    if (pruned.pruned > 0) {
      prunedThisTurn += pruned.pruned;
      msgs.splice(0, msgs.length, ...pruned.messages);
      deps.sessions.replace(sid, msgs);
    }
    if (estimateMessages(msgs) + overhead <= cap) return;
    // Don't auto-compact again until the history grows past the last summary.
    if (compactedAt !== null && estimateMessages(msgs) < compactedAt + Math.floor(cap * 0.2)) return;
    await compact("auto", null);
  };
  // When the system prompt or tool list differs from the last request (new memory,
  // the plan note leaving, a guide edit), earlier signed thinking is bound to the
  // old prefix and must not be replayed (binding.ts). A session with no recorded
  // key (one from before this check) counts as changed.
  const guardPrefix = (msgs: LlmMessage[]): void => {
    const key = prefixKey(system, definitions);
    if (meta.prefixKey === key) return;
    const next = unbindThinking(msgs);
    if (next !== msgs) {
      msgs.splice(0, msgs.length, ...next);
      deps.sessions.replace(sid, msgs);
    }
    meta = { ...meta, prefixKey: key };
    deps.sessions.setMeta(sid, meta);
  };
  const prepare = async (msgs: LlmMessage[], last: LlmUsage | null): Promise<void> => {
    if (limit !== null) await shrink(msgs, last, limit);
    guardPrefix(msgs);
  };

  const result = await runLoop({
    route,
    request,
    messages,
    tools,
    signal: input.signal,
    turnId,
    authorize,
    nudges: input.nudges === true,
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
    prepare,
    onOverflow: () => compact("auto", null),
    ...(deps.stream ? { stream: deps.stream } : {}),
  });

  if (result.stop === "stopped") input.onEvent({ kind: "notice", text: "Stopped." });
  const ownUsage = addUsage(result.usage, extraUsage);
  const totalUsage = addUsage(ownUsage, childUsage);
  const usage = { ...normalizeUsage(totalUsage), ...(result.last ? { contextUsed: contextOf(result.last) } : {}), contextSize };
  const ownCost = costOf(ownUsage);
  const costUsd = ownCost === null || childCost === null ? null : ownCost + childCost;
  input.onEvent({ kind: "turn-end", costUsd, inputTokens: totalUsage.inputTokens, outputTokens: totalUsage.outputTokens, durationMs: Date.now() - started, usage, steps: result.steps, pruned: prunedThisTurn });
}

/** A built-in tool in the loop; TodoWrite also updates the thread's plan. */
function nativeLoopTool(tool: NativeTool, ctxFor: (callId: string, signal: AbortSignal, onOutput: (t: string) => void, script?: boolean) => ToolContext, input: TurnInput): LoopTool {
  return {
    definition: { name: tool.name, description: tool.description, parameters: tool.parameters },
    ...(tool.returns ? { returns: tool.returns } : {}),
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
      const result = await tool.run(args, ctxFor(call.id, call.signal, call.onOutput, call.script));
      if (tool.name === "todowrite") input.onEvent({ kind: "plan", entries: todosOf(args) });
      return result;
    },
  };
}

/** One of the app's tools (browser, memory, design, MCP router) in the loop, or in a script (code mode). */
export function appLoopTool(tool: HarnessTool, input: Pick<TurnInput, "projectId" | "threadId">, outputDir: string): LoopTool {
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
    // Permission and scheduling are separate: a tool may be safe to run without asking yet still change state.
    parallel: tool.effect ? tool.effect === "read" : tool.autoAllow,
    summarize: (args) => {
      if (tool.summarize) return tool.summarize(args);
      const first = Object.values(args).find((v) => typeof v === "string");
      return typeof first === "string" ? first : tool.name;
    },
    run: async (args, call) => {
      const parsed = z.object(tool.input).safeParse(args);
      if (!parsed.success) return { text: `Invalid arguments for ${tool.name}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`, isError: true };
      const out = await tool.run(parsed.data as never, { ...(input.projectId ? { projectId: input.projectId } : {}), threadId: input.threadId, signal: call.signal });
      // A skill's body is instructions, not output: it reaches the model whole. Anything else is bounded like a native tool's result.
      const text = tool.name === "skill" ? out.text : bound(out.text, { outputDir, callId: call.id });
      return { text, ...(out.isError ? { isError: true } : {}), ...(out.imagePng ? { imagePng: out.imagePng } : {}) };
    },
  };
}
