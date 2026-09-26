import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import type { HookCallback, ModelInfo, Options, PermissionResult, SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { McpServerEntry, ModelOption, PermissionMode, ThreadEvent } from "../../shared/types";
import { forClaude } from "../mcp/servers";
import { checkCommand } from "../guard";
import type { InjectionPlan } from "../inject";
import { staleKeyNotice } from "../inject/claude";
import { normalizeUsage } from "../usage";
import { PLUGIN_NAME } from "../skills/plugin";
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
    return { id: m.value, label };
  });
}

const SDK_MODE: Record<PermissionMode, Options["permissionMode"]> = {
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
  /** The generated plugin carrying model-invoked skills, or null if none. */
  pluginDir?: () => string | null;
  /** Git guardrails script, if installed. */
  guardScript?: string;
  /** Plan rate limits, as Claude reports them during turns (claude.ai logins only). */
  onLimits?: LimitsListener;
  /** The credential plan for the next turn; absent = inherit process.env (tests). */
  injection?: () => InjectionPlan;
  /** The BYOK provider's models, or null on subscription. */
  byokModels?: () => ModelOption[] | null;
}

/**
 * Claude through the Agent SDK: Claude Code's own loop and tools, with the
 * user's Claude Code settings, CLAUDE.md, and login. One `query()` per turn,
 * resuming the thread's session so the conversation carries over.
 */
export function createClaudeDriver(config: ClaudeDriverConfig): AgentDriver {
  let models: ModelOption[] = MODELS;
  let refreshing: Promise<void> | null = null;
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
        if (next.length) models = next;
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
    skillCallPrefix: `${PLUGIN_NAME}:`,
    models: () => config.byokModels?.() ?? models,
    refreshModels,
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

      const pluginPath = config.pluginDir?.();
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

      const options: Options = {
        cwd: input.cwd,
        abortController,
        pathToClaudeCodeExecutable: resolvePackagedClaudeBinary(),
        model: input.model,
        resume: input.sessionId ?? undefined,
        permissionMode: SDK_MODE[input.permissionMode],
        allowDangerouslySkipPermissions: input.permissionMode === "full",
        includePartialMessages: true,
        plugins,
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

      const turn: TurnState = { started: false, turnId: randomUUID() };

      try {
        for await (const message of query({ prompt: input.prompt, options })) {
          if (message.type === "rate_limit_event") config.onLimits?.(claudeLimitsPatch(message.rate_limit_info));
          else handleMessage(message, input, turn);
        }
      } catch (err) {
        if (input.signal.aborted) {
          input.onEvent({ kind: "notice", text: "Stopped." });
          return;
        }
        input.onEvent({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}

/** Per-turn state: turn-start fires once, on the turn's first main-thread frame. */
interface TurnState {
  started: boolean;
  turnId: string;
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

function handleMessage(message: SDKMessage, input: TurnInput, turn: TurnState): void {
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
      }
      return;
    }
    case "stream_event": {
      if (message.parent_tool_use_id) return; // subagent chatter stays out of the main thread
      const ev = message.event;
      if (ev.type === "message_start") startTurn(turn, input, ev.message.model);
      if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") input.onTextDelta(ev.delta.text);
      return;
    }
    case "assistant": {
      if (message.parent_tool_use_id) return;
      startTurn(turn, input, message.message.model);
      if (message.error) {
        input.onEvent({ kind: "error", message: describeError(message.error) });
      }
      for (const block of message.message.content) {
        if (block.type === "text" && block.text.trim()) {
          input.onEvent({ kind: "assistant-text", text: block.text });
        } else if (block.type === "thinking" && block.thinking.trim()) {
          const signature = block.signature;
          input.onEvent({ kind: "thinking", text: block.thinking, opaque: false, ...(signature ? { signature } : {}) });
        } else if (block.type === "tool_use") {
          input.onEvent({
            kind: "tool-use",
            toolUseId: block.id,
            name: block.name,
            summary: summarizeToolInput(block.name, (block.input ?? {}) as Record<string, unknown>),
          });
        }
      }
      return;
    }
    case "user": {
      if (message.parent_tool_use_id) return;
      const content = message.message.content;
      if (!Array.isArray(content)) return;
      for (const block of content) {
        if (block.type === "tool_result") {
          input.onEvent({
            kind: "tool-result",
            toolUseId: block.tool_use_id,
            isError: Boolean(block.is_error),
            summary: summarizeToolResult(block.content),
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
