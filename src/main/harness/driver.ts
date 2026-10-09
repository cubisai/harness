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
import { LlmError, type Effort, type HarnessProtocol, type LlmMessage, type LlmUsage } from "./llm/types";
import { runLoop, type Authorization, type LoopTool } from "./loop";
import { decide, refusal } from "./permissions";
import { systemPrompt } from "./prompt";
import { SessionStore, repairHistory } from "./session";
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
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Tests. */
  stream?: typeof streamLlm;
}

const EFFORTS = ["low", "medium", "high"];

const CAPABILITIES = withCapabilities(SAFE_DEFAULTS, {
  resume: true,
  interrupt: true,
  perMessageModel: true,
  vision: true,
  liveReasoning: true,
  preToolGuard: true,
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
    skillsDelivery: { mode: "none" },
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
  if (input.compact) {
    input.onEvent({ kind: "notice", text: "Compacting isn't available for this agent yet." });
    input.onEvent({ kind: "turn-end", costUsd: null, inputTokens: 0, outputTokens: 0, durationMs: Date.now() - started });
    return;
  }
  const entry = provider.models.find((m) => m.id === input.model) ?? provider.models[0];
  if (!entry) throw new Error(`${provider.label} has no models saved. Add one in Settings → Providers.`);
  const wire = wireIdOf(entry, entry.id);
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const route = routeFor(provider, protocol, wire, deps.secret(), deps.secretHeaders(), env);

  // The session: resume the stored history, or start one (seeded by a handoff when the old one is gone).
  let sessionId = input.sessionId;
  let history = sessionId ? deps.sessions.load(sessionId) : null;
  let prompt = input.prompt;
  if (!sessionId || !history) {
    const lostReason = sessionId ? "The session's history file is gone." : null;
    sessionId = deps.sessions.create();
    history = [];
    if (lostReason) {
      const seed = await input.onSessionLost?.(lostReason);
      if (seed && "promptPrefix" in seed) prompt = `${seed.promptPrefix}\n\n${prompt}`;
    }
    input.onSession(sessionId);
  }
  const messages = repairHistory(history);
  const sid = sessionId;
  const userMessage: LlmMessage = { role: "user", content: [{ type: "text", text: prompt }] };
  messages.push(userMessage);
  deps.sessions.append(sid, userMessage);

  const shell = shellFor(platform, env).name;
  const system = systemPrompt({
    cwd: input.cwd,
    platform,
    shell,
    model: entry.name ?? entry.id,
    guide: deps.guide(input.cwd, input.design),
    memory: input.projectId ? deps.memory(input.projectId) : null,
  });

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
  const tools = [
    ...nativeTools(wire).map((t) => nativeLoopTool(t, toolCtx, input)),
    ...[...input.tools, ...deps.mcpTools(input.projectId)].map((t) => appLoopTool(t, input)),
  ].filter((t, i, all) => all.findIndex((o) => o.definition.name === t.definition.name) === i);

  const authorize = async (tool: LoopTool, args: Record<string, unknown>, summary: string): Promise<Authorization> => {
    const verdict = decide(input.permissionMode, tool.access, tool.outside?.(args) ?? false);
    if (verdict === "allow") return { ok: true };
    if (verdict === "deny") return { ok: false, reason: refusal(input.permissionMode, "deny") };
    const decision = await input.requestPermission({ toolName: tool.displayName, summary, canAlwaysAllow: true });
    return decision === "deny" ? { ok: false, reason: refusal(input.permissionMode, "denied-by-user") } : { ok: true };
  };

  const contextSize = provider.contextWindowOverride ?? entry.contextWindow;
  const costOf = (u: LlmUsage): number | null =>
    entry.cost ? (u.inputTokens * entry.cost.input + (u.cacheReadTokens ?? 0) * (entry.cost.cacheRead ?? entry.cost.input) + (u.cacheWriteTokens ?? 0) * entry.cost.input + u.outputTokens * entry.cost.output) / 1e6 : null;
  const contextOf = (u: LlmUsage): number => u.inputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);

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
    ...(deps.stream ? { stream: deps.stream } : {}),
  });

  if (result.stop === "stopped") input.onEvent({ kind: "notice", text: "Stopped." });
  const usage = { ...normalizeUsage(result.usage), ...(result.last ? { contextUsed: contextOf(result.last) } : {}), contextSize };
  input.onEvent({ kind: "turn-end", costUsd: costOf(result.usage), inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, durationMs: Date.now() - started, usage });
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
