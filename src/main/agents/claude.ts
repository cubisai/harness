import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import type { EffortLevel, HookCallback, ModelInfo, ModelUsage, Options, PermissionResult, SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { McpServerEntry, ModelOption, PermissionMode, PlanEntry, ThreadEvent } from "../../shared/types";
import { canonicalTool, clipSummary, type EditResult, type RunPayload, type RunResult } from "../../shared/tools";
import { diffSummary, unifiedDiff } from "../../shared/diff";
import type { ToolDiff } from "../../shared/tools";
import { forClaude } from "../mcp/servers";
import { checkCommand } from "../guard";
import type { InjectionPlan } from "../inject";
import { staleKeyNotice } from "../inject/claude";
import { normalizeUsage } from "../usage";
import { PLUGIN_NAME } from "../skills/plugin";
import { CLAUDE_CAPABILITIES } from "./capabilities";
import { claudeLimitsPatch, claudeUsagePatch, type ClaudeUsage, type LimitsListener, type LimitsPatch } from "./limits";
import { summarizeToolInput, summarizeToolResult } from "./summarize";
import type { AgentDriver, HarnessTool, ToolOutput, TurnInput } from "./types";

/** MCP server name for harness tools: they reach Claude as mcp__cubiq__<tool>. */
export const TOOL_SERVER = "cubiq";

function toCallToolResult(out: ToolOutput) {
  const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [
    { type: "text", text: out.text },
  ];
  if (out.imagePng) content.push({ type: "image", data: out.imagePng, mimeType: "image/png" });
  return { content, isError: out.isError };
}

/** Harness tools as an in-process MCP server, plus the names to auto-allow. */
export function harnessToolOptions(tools: HarnessTool[]): Pick<Options, "mcpServers" | "allowedTools"> {
  if (!tools.length) return {};
  const server = createSdkMcpServer({
    name: TOOL_SERVER,
    version: "1.0.0",
    tools: tools.map((t) => tool(t.name, t.description, t.input, async (args) => toCallToolResult(await t.run(args)))),
  });
  return {
    mcpServers: { [TOOL_SERVER]: server },
    allowedTools: tools.filter((t) => t.autoAllow).map((t) => `mcp__${TOOL_SERVER}__${t.name}`),
  };
}

/** The user's MCP servers next to the harness's own; Claude also keeps the ones in its own config. */
function withUserServers(opts: Pick<Options, "mcpServers" | "allowedTools">, servers: McpServerEntry[]): Pick<Options, "mcpServers" | "allowedTools"> {
  if (!servers.length) return opts;
  return { ...opts, mcpServers: { ...(forClaude(servers) as NonNullable<Options["mcpServers"]>), ...opts.mcpServers } };
}

// Aliases the SDK accepts; labels match the versioned names in each model's description.
const MODELS: ModelOption[] = [
  { id: "opus", label: "Opus 5.5" },
  { id: "sonnet", label: "Sonnet 5" },
  { id: "haiku", label: "Haiku 4.5" },
  { id: "claude-fable-5-1[1m]", label: "Fable 5.1" },
];

function fromSdk(list: ModelInfo[]): ModelOption[] {
  return list.filter((m) => m.value).map((m) => {
    // description: "Opus 5.5 · Best for everyday…" — displayName alone drops the version.
    const head = m.description.split(" · ")[0]?.trim() || m.displayName;
    const label = m.displayName.startsWith("Default")
      ? head === m.displayName
        ? m.displayName
        : `Default (${head})`
      : head.startsWith(m.displayName)
        ? head
        : m.displayName;
    return {
      id: m.value,
      label,
      ...(m.supportsEffort && m.supportedEffortLevels?.length ? { efforts: m.supportedEffortLevels } : {}),
    };
  });
}

export const SDK_MODE: Record<PermissionMode, Options["permissionMode"]> = {
  ask: "default",
  "auto-edit": "acceptEdits",
  full: "bypassPermissions",
};

/**
 * In a packaged app the SDK resolves its Claude Code binary to a path inside
 * app.asar, which can't be executed; electron-builder unpacks it beside the
 * archive (asarUnpack), so point the SDK there. Undefined in development,
 * where the SDK's own lookup works.
 */
export function resolvePackagedClaudeBinary(
  resolve: (id: string) => string = createRequire(import.meta.url).resolve,
  platform: string = process.platform,
  arch: string = process.arch,
): string | undefined {
  const exe = platform === "win32" ? "claude.exe" : "claude";
  const names =
    platform === "linux"
      ? [`claude-agent-sdk-linux-${arch}`, `claude-agent-sdk-linux-${arch}-musl`]
      : [`claude-agent-sdk-${platform}-${arch}`];
  for (const name of names) {
    let path: string;
    try {
      path = resolve(`@anthropic-ai/${name}/${exe}`);
    } catch {
      continue;
    }
    if (!/app\.asar[\\/]/.test(path)) return undefined;
    const unpacked = path.replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
    if (existsSync(unpacked)) return unpacked;
  }
  return undefined;
}

export interface ClaudeDriverConfig {
  /** The generated plugin carrying model-invoked skills for this turn's cwd, or null if none. */
  pluginDir?: (cwd: string) => string | null;
  /** Git guardrails script, if installed. */
  guardScript?: string;
  /** Plan rate limits, as Claude reports them during turns (claude.ai logins only). */
  onLimits?: LimitsListener;
  /** The credential plan for the next turn; absent = inherit process.env (tests). */
  injection?: () => InjectionPlan;
  /** The BYOK provider's models, or null on subscription. */
  byokModels?: () => ModelOption[] | null;
  /** The harness guide for this turn's cwd, appended to Claude Code's own system prompt. */
  guide?: (cwd: string) => string;
}

/**
 * Claude through the Agent SDK: Claude Code's own loop and tools, with the
 * user's Claude Code settings, CLAUDE.md, and login. One `query()` per turn,
 * resuming the thread's session so the conversation carries over.
 */
export function createClaudeDriver(config: ClaudeDriverConfig): AgentDriver {
  let models: ModelOption[] = MODELS;
  let refreshing: Promise<void> | null = null;
  /** Model value → whether it supports adaptive thinking, from the SDK's model list. */
  const adaptiveThinking = new Map<string, boolean>();
  // Both are once-per-driver, not once-per-turn: the same warning or the same
  // project does not need saying again on the next message.
  const shownWarnings = new Set<string>();
  const checkedProjects = new Set<string>();

  const refreshModels = (): Promise<void> => {
    if (models !== MODELS) return Promise.resolve();
    refreshing ??= (async () => {
      const controller = new AbortController();
      try {
        // Streaming input so control requests (supportedModels) are allowed.
        // The prompt never yields: we only need the control-plane list, then abort.
        const q = query({
          prompt: (async function* () {
            await new Promise<never>(() => {});
          })(),
          options: {
            abortController: controller,
            pathToClaudeCodeExecutable: resolvePackagedClaudeBinary(),
          },
        });
        const list = await Promise.race([
          q.supportedModels(),
          new Promise<ModelInfo[]>((_resolve, reject) => {
            const t = setTimeout(() => reject(new Error("timed out listing Claude models")), 15_000);
            controller.signal.addEventListener(
              "abort",
              () => {
                clearTimeout(t);
                reject(new Error("aborted"));
              },
              { once: true },
            );
          }),
        ]);
        const next = fromSdk(list);
        if (next.length) {
          models = next;
          adaptiveThinking.clear();
          for (const m of list) if (m.value) adaptiveThinking.set(m.value, Boolean(m.supportsAdaptiveThinking));
        }
      } catch {
        // Keep the static fallback list.
      } finally {
        controller.abort();
        refreshing = null;
      }
    })();
    return refreshing;
  };

  return {
    id: "claude",
    label: "Claude",
    defaultModel: "opus",
    capabilities: CLAUDE_CAPABILITIES,
    credentials: { byok: true, own: "login", injector: "claude" },
    skillsDelivery: CLAUDE_CAPABILITIES.skillsDelivery,
    skillCallPrefix: `${PLUGIN_NAME}:`,
    models: () => config.byokModels?.() ?? models,
    refreshModels,
    // Read plan limits on demand, the same control-plane probe as refreshModels:
    // a query with a prompt that never yields, aborted once the answer lands.
    readLimits: async (): Promise<LimitsPatch | "unsupported" | null> => {
      const controller = new AbortController();
      try {
        const q = query({
          prompt: (async function* () {
            await new Promise<never>(() => {});
          })(),
          options: {
            abortController: controller,
            pathToClaudeCodeExecutable: resolvePackagedClaudeBinary(),
          },
        });
        const usage = (
          q as unknown as {
            usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: (o: { skipBehaviors: boolean }) => Promise<ClaudeUsage>;
          }
        ).usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
        if (typeof usage !== "function") return null; // a CLI that predates the probe
        const res = await Promise.race([
          usage.call(q, { skipBehaviors: true }),
          new Promise<never>((_resolve, reject) => {
            const t = setTimeout(() => reject(new Error("timed out reading Claude limits")), 10_000);
            controller.signal.addEventListener(
              "abort",
              () => {
                clearTimeout(t);
                reject(new Error("aborted"));
              },
              { once: true },
            );
          }),
        ]);
        if (res.rate_limits_available === false) return "unsupported";
        const patch = claudeUsagePatch(res);
        // No windows means the CLI couldn't fetch them this time: a failure, so the refresher backs off.
        if (!patch.windows) throw new Error("Claude reported no plan limits this time");
        return patch;
      } finally {
        controller.abort();
      }
    },
    // The next turn resumes the session with the new model (spike S1).
    setModel: async () => "in-place",
    async runTurn(input: TurnInput): Promise<void> {
      const abortController = new AbortController();
      input.signal.addEventListener("abort", () => abortController.abort(), { once: true });

      const guard: HookCallback = async (hookInput) => {
        if (!config.guardScript) return {};
        if (hookInput.hook_event_name !== "PreToolUse") return {};
        const command = (hookInput.tool_input as { command?: unknown } | undefined)?.command;
        if (typeof command !== "string") return {};
        const verdict = await checkCommand(config.guardScript, hookInput.tool_name, command);
        if (!verdict.blocked) return {};
        input.onEvent({ kind: "notice", text: `Blocked by git guardrails: ${command}` });
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: verdict.reason,
          },
        };
      };

      const pluginPath = config.pluginDir?.(input.cwd);
      const plugins: { type: "local"; path: string }[] = pluginPath ? [{ type: "local", path: pluginPath }] : [];

      const plan = config.injection?.();
      if (plan?.error) {
        input.onEvent({ kind: "error", message: plan.error });
        return;
      }
      if (plan?.warning && !shownWarnings.has(plan.warning)) {
        shownWarnings.add(plan.warning);
        input.onEvent({ kind: "notice", text: plan.warning });
      }
      if (plan?.byok && !checkedProjects.has(input.cwd)) {
        checkedProjects.add(input.cwd);
        const stale = await staleKeyNotice(input.cwd);
        if (stale) input.onEvent({ kind: "notice", text: stale });
      }

      const guideText = config.guide?.(input.cwd) ?? "";
      const options: Options = {
        cwd: input.cwd,
        abortController,
        pathToClaudeCodeExecutable: resolvePackagedClaudeBinary(),
        model: input.model,
        resume: input.sessionId ?? undefined,
        permissionMode: SDK_MODE[input.permissionMode],
        allowDangerouslySkipPermissions: input.permissionMode === "full",
        includePartialMessages: true,
        // Effort guides how deep the model thinks; summarized adaptive thinking
        // returns the reasoning text instead of omitting it.
        ...(input.effort ? { effort: input.effort as EffortLevel } : {}),
        ...(adaptiveThinking.get(input.model) === true ? { thinking: { type: "adaptive" as const, display: "summarized" as const } } : {}),
        plugins,
        ...(guideText ? { systemPrompt: { type: "preset" as const, preset: "claude_code" as const, append: guideText } } : {}),
        ...(plan ? { env: plan.env } : {}),
        ...withUserServers(harnessToolOptions(input.tools), input.mcpServers),
        hooks: { PreToolUse: [{ matcher: "Bash", hooks: [guard] }] },
        canUseTool: async (toolName, toolInput, { suggestions }): Promise<PermissionResult> => {
          const decision = await input.requestPermission({
            toolName,
            summary: summarizeToolInput(toolName, toolInput),
            canAlwaysAllow: Boolean(suggestions?.length),
          });
          if (decision === "deny") return { behavior: "deny", message: "The user declined this action." };
          return {
            behavior: "allow",
            updatedInput: toolInput,
            updatedPermissions: decision === "allow-always" ? suggestions : undefined,
          };
        },
      };

      const turn = newTurnState();

      // One query() attempt. "aborted" means the turn was stopped (the caller returns);
      // "lost" means the stored session couldn't be reopened and the caller should seed a new one.
      let lost: string | null = null;
      const attempt = async (opts: Options, prompt: string): Promise<"done" | "lost" | "aborted"> => {
        try {
          for await (const message of query({ prompt, options: opts })) {
            if (message.type === "rate_limit_event") config.onLimits?.(claudeLimitsPatch(message.rate_limit_info));
            else if (
              input.sessionId &&
              message.type === "result" &&
              message.subtype !== "success" &&
              message.errors?.some((e) => /No conversation found with session ID/.test(e))
            ) {
              // The stored session is gone: skip this result and let the caller seed a new one.
              lost = message.errors.find((e) => /No conversation found with session ID/.test(e)) ?? "unknown error";
              break;
            } else handleMessage(message, input, turn);
          }
        } catch (err) {
          if (input.signal.aborted) {
            // Close any item the stream opened but never got a terminal frame for,
            // so its live text becomes stored history instead of dangling.
            for (const [itemId, p] of turn.pending) {
              if (p.kind === "text" && p.text.trim()) input.onEvent({ kind: "assistant-text", text: p.text, itemId });
              else if (p.kind === "thinking" && p.text.trim()) input.onEvent({ kind: "thinking", text: p.text, opaque: false, itemId });
            }
            input.onEvent({ kind: "notice", text: "Stopped." });
            return "aborted";
          }
          // The SDK throws after the error result we already identified; swallow that one.
          if (lost) return "lost";
          const text = err instanceof Error ? err.message : String(err);
          // The SDK closes a failed turn by throwing the message it already sent.
          if (turn.reportedError && text.includes(turn.reportedError.slice(0, 60))) return "done";
          input.onEvent({ kind: "error", message: text });
          return "done";
        }
        return lost ? "lost" : "done";
      };

      if ((await attempt(options, input.prompt)) === "aborted") return;
      if (lost) {
        // Cleared first, so a real error in the retry isn't swallowed as the lost session's throw.
        const reason: string = lost;
        lost = null;
        const seed = input.onSessionLost ? await input.onSessionLost(reason) : null;
        if (!input.onSessionLost) input.onEvent({ kind: "notice", text: `Claude couldn't reopen its earlier session (${reason}); this is a new one.` });
        // One retry only: a fresh session, with the seed's prefix ahead of the prompt.
        const prompt = seed && "promptPrefix" in seed ? `${seed.promptPrefix}\n---\n${input.prompt}` : input.prompt;
        await attempt({ ...options, resume: undefined }, prompt);
      }
    },
  };
}

/** Per-turn state: turn-start fires once, on the turn's first main-thread frame. */
export interface TurnState {
  started: boolean;
  turnId: string;
  /** The latest main-thread stream message id, so stream items key the same as their terminal frames. */
  messageId: string | null;
  /** Stream content index → the tool_use id of the block starting at it. */
  toolIds: Map<number, string>;
  /** Thinking itemId → the signature its stream delivered. */
  signatures: Map<string, string>;
  /** Assistant message id → content blocks already emitted as terminal events. */
  blocksSeen: Map<string, number>;
  /** itemId → text streamed but not yet closed by a terminal event. */
  pending: Map<string, { kind: "text" | "thinking"; text: string }>;
  /** tool_use id → that call's canonical payload, so its result can be shaped the same way. */
  toolPayloads: Map<string, RunPayload | { diff: ToolDiff[] } | undefined>;
  /** tool_use ids of TodoWrite calls, whose plan replaced their tool rows; their results are skipped too. */
  planToolIds: Set<string>;
  /** tool_use ids of Agent (Task) calls, so a background launch can be told apart from a result. */
  agentIds: Set<string>;
  /** Agent calls running in the background: their row waits for the task_notification, not the placeholder result. */
  backgroundAgents: Set<string>;
  /** The error text already shown this turn, so the SDK's closing error doesn't repeat it. */
  reportedError: string | null;
  /** The last main-thread assistant call's context input (uncached + cached), or null. */
  contextInputTokens: number | null;
  /** The model the turn's main thread last reported, for the context window lookup. */
  model: string | null;
}

/** Fresh per-turn state for runTurn and for mapping a message stream in tests. */
export function newTurnState(): TurnState {
  return {
    started: false,
    turnId: randomUUID(),
    messageId: null,
    toolIds: new Map(),
    signatures: new Map(),
    blocksSeen: new Map(),
    pending: new Map(),
    toolPayloads: new Map(),
    planToolIds: new Set(),
    agentIds: new Set(),
    backgroundAgents: new Set(),
    reportedError: null,
    contextInputTokens: null,
    model: null,
  };
}

/**
 * The turn-end event for a `result` message. inputTokens is uncached (net-new)
 * only — folding cache reads in would make the hit-rate denominator unknowable.
 * `contextUsed` is the last main-thread assistant call's full input (cached
 * included), and `contextSize` the model's window.
 */
export function turnEndFromResult(message: SDKResultMessage, contextUsed?: number | null, model?: string | null): ThreadEvent {
  return {
    kind: "turn-end",
    costUsd: typeof message.total_cost_usd === "number" ? message.total_cost_usd : null,
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
    durationMs: message.duration_ms,
    usage: {
      ...normalizeUsage({
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        cacheReadTokens: message.usage.cache_read_input_tokens ?? null,
        cacheWriteTokens: message.usage.cache_creation_input_tokens ?? null,
      }),
      contextUsed: contextUsed ?? null,
      contextSize: contextWindowFor(message.modelUsage, model ?? null),
    },
  };
}

/** The window for the turn's model in the result's per-model usage; the max when unmatched, else null. */
function contextWindowFor(modelUsage: Record<string, ModelUsage> | undefined, model: string | null): number | null {
  if (!modelUsage) return null;
  const exact = model ? modelUsage[model] : undefined;
  if (typeof exact?.contextWindow === "number") return exact.contextWindow;
  const windows = Object.values(modelUsage)
    .map((m) => m.contextWindow)
    .filter((n): n is number => typeof n === "number");
  return windows.length ? Math.max(...windows) : null;
}

/** Emit the once-per-turn turn-start, stamped with the model that arrived. */
function startTurn(turn: TurnState, input: TurnInput, model: string | undefined): void {
  if (turn.started) return;
  turn.started = true;
  input.onEvent({ kind: "turn-start", turnId: turn.turnId, agent: "claude", model: model || input.model });
}

export function handleMessage(message: SDKMessage, input: TurnInput, turn: TurnState): void {
  switch (message.type) {
    case "system": {
      if (message.subtype === "init") input.onSession(message.session_id);
      else if (message.subtype === "compact_boundary") {
        const meta = message.compact_metadata;
        input.onEvent({
          kind: "compaction",
          trigger: meta.trigger === "manual" || meta.trigger === "auto" ? meta.trigger : "unknown",
          preTokens: meta.pre_tokens ?? null,
          postTokens: meta.post_tokens ?? null,
        });
      } else if (message.subtype === "thinking_tokens") input.onThinkingProgress?.({ estimatedTokens: message.estimated_tokens });
      else if (message.subtype === "task_started") {
        if (message.tool_use_id && message.is_backgrounded) turn.backgroundAgents.add(message.tool_use_id);
      } else if (message.subtype === "task_notification") {
        // A background Agent's real result: close its row with the subagent's summary.
        const id = message.tool_use_id;
        if (id && turn.backgroundAgents.delete(id)) {
          const failed = message.status !== "completed";
          input.onEvent({
            kind: "tool-result",
            toolUseId: id,
            isError: failed,
            summary: summarizeToolResult(message.summary) || (message.status === "stopped" ? "Stopped" : failed ? "Failed" : "Done"),
            ...(message.summary ? { payload: message.summary } : {}),
          });
        }
      }
      return;
    }
    case "stream_event": {
      if (message.parent_tool_use_id) return; // subagent chatter stays out of the main thread
      const ev = message.event;
      if (ev.type === "message_start") {
        turn.messageId = ev.message.id;
        startTurn(turn, input, ev.message.model);
        return;
      }
      if (ev.type === "content_block_start" && ev.content_block.type === "tool_use") {
        turn.toolIds.set(ev.index, ev.content_block.id);
        return;
      }
      if (ev.type === "content_block_delta") {
        const itemId = `${turn.messageId ?? "m"}:${ev.index}`;
        switch (ev.delta.type) {
          case "text_delta": {
            input.onTextDelta(ev.delta.text, itemId);
            const prev = turn.pending.get(itemId);
            turn.pending.set(itemId, { kind: "text", text: (prev?.text ?? "") + ev.delta.text });
            return;
          }
          case "thinking_delta": {
            input.onReasoningDelta?.({ itemId, text: ev.delta.thinking, opaque: false });
            const prev = turn.pending.get(itemId);
            turn.pending.set(itemId, { kind: "thinking", text: (prev?.text ?? "") + ev.delta.thinking });
            return;
          }
          case "signature_delta":
            turn.signatures.set(itemId, ev.delta.signature);
            return;
          case "input_json_delta":
            input.onToolInputDelta?.({ toolUseId: turn.toolIds.get(ev.index) ?? itemId, text: ev.delta.partial_json });
            return;
          default:
            return;
        }
      }
      return;
    }
    case "assistant": {
      const parentId = message.parent_tool_use_id ?? undefined;
      // A subagent's message carries no turn-start or account error: those belong
      // to the main thread, and usage/turn bookkeeping is not ours to touch here.
      if (!parentId) {
        startTurn(turn, input, message.message.model);
        // Remember the last main-thread API call's full context input (cached
        // included) and its model, for the turn-end event's context figures.
        const usage = message.message.usage;
        turn.model = message.message.model;
        if (usage) {
          turn.contextInputTokens =
            (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
          input.onUsageUpdate?.({ contextUsed: turn.contextInputTokens });
        }
        if (message.error) {
          // Claude Code explains account limits (a spend cap, a plan limit) in a synthetic
          // assistant message: show that text as the error, not as a reply and not as a
          // generic code. "rate_limit" also covers a spend cap, so the text is the truth.
          const said = message.message.content
            .map((b) => (b.type === "text" ? b.text : ""))
            .join(" ")
            .trim();
          turn.reportedError = said || describeError(message.error);
          input.onEvent({ kind: "error", message: turn.reportedError });
          if (said) return;
        }
      }
      const id = message.message.id;
      let k = turn.blocksSeen.get(id) ?? 0;
      for (const block of message.message.content) {
        const itemId = `${id}:${k}`;
        k += 1;
        emitAssistantBlock(block, itemId, input, turn, parentId);
      }
      turn.blocksSeen.set(id, k);
      return;
    }
    case "user": {
      const parentId = message.parent_tool_use_id ?? undefined;
      const content = message.message.content;
      if (!Array.isArray(content)) return;
      for (const block of content) {
        if (block.type === "tool_result") {
          // A TodoWrite call already showed up as a plan event; its result is not a tool row.
          if (turn.planToolIds.has(block.tool_use_id)) {
            turn.planToolIds.delete(block.tool_use_id);
            continue;
          }
          const isError = Boolean(block.is_error);
          // A background Agent's immediate result is launch metadata, not its answer:
          // keep the row open for the task_notification instead of showing it.
          if (turn.agentIds.has(block.tool_use_id) && !isError && (turn.backgroundAgents.has(block.tool_use_id) || resultText(block.content).startsWith("Async agent launched"))) {
            turn.backgroundAgents.add(block.tool_use_id);
            continue;
          }
          // Shape the result like the other adapters: a Run carries its output,
          // an Edit carries the diff its call described (with a +/− stat).
          const used = turn.toolPayloads.get(block.tool_use_id);
          turn.toolPayloads.delete(block.tool_use_id);
          let payload: RunResult | EditResult | string | undefined;
          let summary = summarizeToolResult(block.content);
          if (used && "command" in used) {
            payload = { exitCode: null, output: resultText(block.content) };
          } else if (used && "diff" in used && used.diff.length && !isError) {
            payload = { diff: used.diff };
            summary = diffSummary(used.diff);
          } else {
            // Any other tool's result keeps its text, so the row's Output has it.
            const text = resultText(block.content);
            if (text) payload = text;
          }
          input.onEvent({
            kind: "tool-result",
            toolUseId: block.tool_use_id,
            isError,
            summary,
            ...(parentId ? { parentId } : {}),
            ...(payload ? { payload } : {}),
          });
        }
      }
      return;
    }
    case "result": {
      input.onEvent(turnEndFromResult(message, turn.contextInputTokens, turn.model));
      if (message.subtype !== "success") {
        input.onEvent({ kind: "error", message: `The turn ended early (${message.subtype}).` });
      }
      return;
    }
    default:
      return;
  }
}

/** One assistant content block, as the SDK types it. */
type AssistantBlock = Extract<SDKMessage, { type: "assistant" }>["message"]["content"][number];

/**
 * Emit one assistant content block. A subagent's block carries its parent
 * tool-use id and skips reasoning and plans, which belong to the main thread.
 */
function emitAssistantBlock(block: AssistantBlock, itemId: string, input: TurnInput, turn: TurnState, parentId: string | undefined): void {
  if (block.type === "text" && block.text.trim()) {
    turn.pending.delete(itemId);
    input.onEvent({ kind: "assistant-text", text: block.text, itemId, ...(parentId ? { parentId } : {}) });
    return;
  }
  if (block.type === "thinking") {
    // A subagent's reasoning is not the thread's history; its tool rows are.
    if (parentId) return;
    const signature = block.signature || turn.signatures.get(itemId);
    if (block.thinking.trim()) {
      turn.pending.delete(itemId);
      input.onEvent({ kind: "thinking", text: block.thinking, opaque: false, itemId, ...(signature ? { signature } : {}) });
    } else if (signature) {
      // Opaque reasoning: the signature is the only thing keeping the block alive.
      turn.pending.delete(itemId);
      input.onEvent({ kind: "thinking", text: "", signature, opaque: true, itemId });
    }
    return;
  }
  if (block.type !== "tool_use") return;
  turn.pending.delete(itemId);
  const toolInput = (block.input ?? {}) as Record<string, unknown>;
  // TodoWrite is a plan, not a tool: emit plan entries and skip both its row and
  // (below) its tool_result. A subagent's todo list is not the thread's plan.
  if (block.name === "TodoWrite" && Array.isArray(toolInput.todos)) {
    const entries = todoPlanEntries(toolInput.todos);
    if (entries) {
      turn.planToolIds.add(block.id);
      if (!parentId) input.onEvent({ kind: "plan", entries });
      return;
    }
  }
  // The canonical name plus, for commands and file edits, a payload
  // every adapter emits the same way.
  const isAgent = block.name === "Task" || block.name === "Agent";
  if (isAgent) turn.agentIds.add(block.id);
  const name = isAgent ? "Agent" : canonicalTool(block.name);
  let payload: RunPayload | { diff: ToolDiff[] } | undefined;
  let eventPayload: unknown;
  if (block.name === "Bash" && typeof toolInput.command === "string") {
    payload = { command: toolInput.command };
    eventPayload = payload;
  } else if (block.name === "Edit" && typeof toolInput.file_path === "string" && typeof toolInput.old_string === "string" && typeof toolInput.new_string === "string") {
    payload = {
      ...toolInput,
      diff: [{ path: toolInput.file_path, unified: unifiedDiff(toolInput.file_path, toolInput.old_string, toolInput.new_string) }],
    };
    eventPayload = payload;
  } else if (block.name === "Write" && typeof toolInput.file_path === "string" && typeof toolInput.content === "string") {
    payload = {
      ...toolInput,
      diff: [{ path: toolInput.file_path, unified: unifiedDiff(toolInput.file_path, "", toolInput.content) }],
    };
    eventPayload = payload;
  } else if (Object.keys(toolInput).length) {
    // Any other tool keeps its input as the payload, so its row shows
    // the arguments instead of "No details recorded."
    eventPayload = toolInput;
  }
  const summary =
    isAgent && typeof toolInput.description === "string" && typeof toolInput.subagent_type === "string"
      ? clipSummary(`${toolInput.description} · ${toolInput.subagent_type}`)
      : summarizeToolInput(block.name, toolInput);
  input.onEvent({
    kind: "tool-use",
    toolUseId: block.id,
    name,
    summary,
    itemId,
    ...(parentId ? { parentId } : {}),
    ...(eventPayload !== undefined ? { payload: eventPayload } : {}),
  });
  // Only shaped payloads drive the result shape below; a generic input
  // must not be mistaken for a Run command or an Edit diff.
  turn.toolPayloads.set(block.id, payload);
}

/** A tool_result's full text, joined the way summarizeToolResult joins it. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => (b && typeof b === "object" && "text" in b && typeof b.text === "string" ? b.text : "")).join(" ");
}

/** A TodoWrite's todos as canonical plan entries, or null when the list isn't one. */
function todoPlanEntries(todos: unknown[]): PlanEntry[] | null {
  const entries: PlanEntry[] = [];
  for (const item of todos) {
    if (!item || typeof item !== "object") return null;
    const { content, status } = item as { content?: unknown; status?: unknown };
    if (typeof content !== "string" || typeof status !== "string") return null;
    if (status !== "pending" && status !== "in_progress" && status !== "completed") continue;
    entries.push({ content, status });
  }
  return entries;
}

function describeError(code: string): string {
  switch (code) {
    case "authentication_failed":
      return "Claude isn't signed in. Run `claude` once in a terminal to log in, or set ANTHROPIC_API_KEY, then try again.";
    case "rate_limit":
      return "Rate limited. Wait a moment and send again.";
    case "overloaded":
      return "Claude is overloaded right now. Try again shortly.";
    default:
      return `Claude reported an error: ${code}.`;
  }
}
