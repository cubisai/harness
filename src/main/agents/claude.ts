import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import type { EffortLevel, HookCallback, ModelInfo, Options, PermissionResult, SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { McpServerEntry, ModelOption, PermissionMode, ThreadEvent } from "../../shared/types";
import { canonicalTool, type EditResult, type RunPayload, type RunResult } from "../../shared/tools";
import { diffSummary, unifiedDiff } from "../../shared/diff";
import type { ToolDiff } from "../../shared/tools";
import { forClaude } from "../mcp/servers";
import { checkCommand } from "../guard";
import type { InjectionPlan } from "../inject";
import { staleKeyNotice } from "../inject/claude";
import { normalizeUsage } from "../usage";
import { PLUGIN_NAME } from "../skills/plugin";
import { CLAUDE_CAPABILITIES } from "./capabilities";
import { claudeLimitsPatch, type LimitsListener } from "./limits";
import { summarizeToolInput, summarizeToolResult } from "./summarize";
import type { AgentDriver, HarnessTool, ToolOutput, TurnInput } from "./types";

/** MCP server name for harness tools: they reach Claude as mcp__unskilled__<tool>. */
export const TOOL_SERVER = "unskilled";

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

      try {
        for await (const message of query({ prompt: input.prompt, options })) {
          if (message.type === "rate_limit_event") config.onLimits?.(claudeLimitsPatch(message.rate_limit_info));
          else handleMessage(message, input, turn);
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
          return;
        }
        const text = err instanceof Error ? err.message : String(err);
        // The SDK closes a failed turn by throwing the message it already sent.
        if (turn.reportedError && text.includes(turn.reportedError.slice(0, 60))) return;
        input.onEvent({ kind: "error", message: text });
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
  /** The error text already shown this turn, so the SDK's closing error doesn't repeat it. */
  reportedError: string | null;
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
    reportedError: null,
  };
}

/**
 * The turn-end event for a `result` message. inputTokens is uncached (net-new)
 * only — folding cache reads in would make the hit-rate denominator unknowable.
 */
export function turnEndFromResult(message: SDKResultMessage): ThreadEvent {
  return {
    kind: "turn-end",
    costUsd: typeof message.total_cost_usd === "number" ? message.total_cost_usd : null,
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
    durationMs: message.duration_ms,
    usage: normalizeUsage({
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      cacheReadTokens: message.usage.cache_read_input_tokens ?? null,
      cacheWriteTokens: message.usage.cache_creation_input_tokens ?? null,
    }),
  };
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
      if (message.parent_tool_use_id) return;
      startTurn(turn, input, message.message.model);
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
      const id = message.message.id;
      let k = turn.blocksSeen.get(id) ?? 0;
      for (const block of message.message.content) {
        const itemId = `${id}:${k}`;
        k += 1;
        if (block.type === "text" && block.text.trim()) {
          turn.pending.delete(itemId);
          input.onEvent({ kind: "assistant-text", text: block.text, itemId });
        } else if (block.type === "thinking") {
          const signature = block.signature || turn.signatures.get(itemId);
          if (block.thinking.trim()) {
            turn.pending.delete(itemId);
            input.onEvent({ kind: "thinking", text: block.thinking, opaque: false, itemId, ...(signature ? { signature } : {}) });
          } else if (signature) {
            // Opaque reasoning: the signature is the only thing keeping the block alive.
            turn.pending.delete(itemId);
            input.onEvent({ kind: "thinking", text: "", signature, opaque: true, itemId });
          }
        } else if (block.type === "tool_use") {
          turn.pending.delete(itemId);
          const toolInput = (block.input ?? {}) as Record<string, unknown>;
          // The canonical name plus, for commands and file edits, a payload
          // every adapter emits the same way.
          const name = canonicalTool(block.name);
          let payload: RunPayload | { diff: ToolDiff[] } | undefined;
          if (block.name === "Bash" && typeof toolInput.command === "string") {
            payload = { command: toolInput.command };
          } else if (block.name === "Edit" && typeof toolInput.file_path === "string" && typeof toolInput.old_string === "string" && typeof toolInput.new_string === "string") {
            payload = {
              ...toolInput,
              diff: [{ path: toolInput.file_path, unified: unifiedDiff(toolInput.file_path, toolInput.old_string, toolInput.new_string) }],
            };
          } else if (block.name === "Write" && typeof toolInput.file_path === "string" && typeof toolInput.content === "string") {
            payload = {
              ...toolInput,
              diff: [{ path: toolInput.file_path, unified: unifiedDiff(toolInput.file_path, "", toolInput.content) }],
            };
          }
          input.onEvent({
            kind: "tool-use",
            toolUseId: block.id,
            name,
            summary: summarizeToolInput(block.name, toolInput),
            itemId,
            ...(payload ? { payload } : {}),
          });
          turn.toolPayloads.set(block.id, payload);
        }
      }
      turn.blocksSeen.set(id, k);
      return;
    }
    case "user": {
      if (message.parent_tool_use_id) return;
      const content = message.message.content;
      if (!Array.isArray(content)) return;
      for (const block of content) {
        if (block.type === "tool_result") {
          const isError = Boolean(block.is_error);
          // Shape the result like the other adapters: a Run carries its output,
          // an Edit carries the diff its call described (with a +/− stat).
          const used = turn.toolPayloads.get(block.tool_use_id);
          turn.toolPayloads.delete(block.tool_use_id);
          let payload: RunResult | EditResult | undefined;
          let summary = summarizeToolResult(block.content);
          if (used && "command" in used) {
            payload = { exitCode: null, output: resultText(block.content) };
          } else if (used && "diff" in used && used.diff.length && !isError) {
            payload = { diff: used.diff };
            summary = diffSummary(used.diff);
          }
          input.onEvent({
            kind: "tool-result",
            toolUseId: block.tool_use_id,
            isError,
            summary,
            ...(payload ? { payload } : {}),
          });
        }
      }
      return;
    }
    case "result": {
      input.onEvent(turnEndFromResult(message));
      if (message.subtype !== "success") {
        input.onEvent({ kind: "error", message: `The turn ended early (${message.subtype}).` });
      }
      return;
    }
    default:
      return;
  }
}

/** A tool_result's full text, joined the way summarizeToolResult joins it. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => (b && typeof b === "object" && "text" in b && typeof b.text === "string" ? b.text : "")).join(" ");
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
