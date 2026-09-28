import { describe, expect, it, vi } from "vitest";
import type { ModelInfo, SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { createClaudeDriver, handleMessage, newTurnState, resolvePackagedClaudeBinary, turnEndFromResult } from "../src/main/agents/claude";
import type { TurnInput } from "../src/main/agents/types";
import type { ThreadEvent } from "../src/shared/types";

// The SDK's `query` is faked so the per-turn `options` (where the guide lands)
// can be read without launching Claude Code. Everything else is the real SDK.
const sdk = vi.hoisted(() => ({ calls: [] as { prompt: unknown; options: Record<string, unknown> }[], models: [] as ModelInfo[] }));
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return {
    ...actual,
    query: (args: { prompt: unknown; options: Record<string, unknown> }) => {
      sdk.calls.push(args);
      return {
        supportedModels: async () => sdk.models,
        [Symbol.asyncIterator]: async function* () {
          // No messages: runTurn has nothing to map.
        },
      };
    },
  };
});

/** A TurnInput that records nothing; just enough for runTurn to build its options. */
function turnInput(guideCwd = "/tmp/project"): { input: TurnInput; events: ThreadEvent[] } {
  const events: ThreadEvent[] = [];
  const input: TurnInput = {
    threadId: "t",
    cwd: guideCwd,
    prompt: "hi",
    sessionId: null,
    model: "opus",
    permissionMode: "ask",
    signal: new AbortController().signal,
    tools: [],
    mcpServers: [],
    onEvent: (e) => events.push(e),
    onTextDelta: () => {},
    onSession: () => {},
    requestPermission: async () => "allow-once",
  };
  return { input, events };
}

describe("resolvePackagedClaudeBinary", () => {
  it("leaves development installs to the SDK", () => {
    const resolve = (id: string) => `/repo/node_modules/${id}`;
    expect(resolvePackagedClaudeBinary(resolve, "darwin", "arm64")).toBeUndefined();
  });

  it("does not return a path that doesn't exist", () => {
    const resolve = (id: string) => `/Applications/UnSkilled.app/Contents/Resources/app.asar/node_modules/${id}`;
    expect(resolvePackagedClaudeBinary(resolve, "darwin", "arm64")).toBeUndefined();
  });

  it("skips platform packages that aren't installed", () => {
    const resolve = () => {
      throw new Error("not found");
    };
    expect(resolvePackagedClaudeBinary(resolve, "linux", "x64")).toBeUndefined();
  });
});

describe("Claude driver models", () => {
  it("starts with the static fallback list", () => {
    const d = createClaudeDriver({ pluginDir: () => "/tmp/plugin", guardScript: "/tmp/guard.py" });
    expect(d.models().map((m) => m.id)).toContain("opus");
    expect(d.models().find((m) => m.id === "opus")?.label).toBe("Opus 5.5");
    expect(d.defaultModel).toBe("opus");
  });

  it("refreshModels resolves and leaves a usable list even if the SDK fails", async () => {
    const d = createClaudeDriver({ pluginDir: () => "/tmp/plugin", guardScript: "/tmp/guard.py" });
    await d.refreshModels!();
    expect(d.models().length).toBeGreaterThan(0);
    expect(d.defaultModel).toBeTruthy();
    // When the SDK answers, labels carry the version (Opus 5.5, not bare Opus).
    const opus = d.models().find((m) => m.id === "opus");
    if (opus && opus.label !== "Opus 5.5") {
      // refresh fell back to the static list or an older SDK shape
      expect(opus.label).toMatch(/Opus/i);
    }
  }, 30_000);
});

describe("Claude driver guide", () => {
  it("appends the harness guide to the claude_code system prompt", async () => {
    sdk.calls.length = 0;
    const d = createClaudeDriver({ pluginDir: () => null, guide: () => "GUIDE" });
    const { input } = turnInput();
    await d.runTurn(input);
    expect(sdk.calls).toHaveLength(1);
    expect(sdk.calls[0]?.options.systemPrompt).toEqual({ type: "preset", preset: "claude_code", append: "GUIDE" });
  });

  it("leaves systemPrompt out when there's no guide", async () => {
    sdk.calls.length = 0;
    const d = createClaudeDriver({ pluginDir: () => null });
    const { input } = turnInput();
    await d.runTurn(input);
    expect(sdk.calls).toHaveLength(1);
    expect(sdk.calls[0]?.options).not.toHaveProperty("systemPrompt");
  });
});

describe("Claude driver effort", () => {
  it("passes effort and asks for summarized adaptive thinking on a model that supports it", async () => {
    sdk.calls.length = 0;
    sdk.models = [
      {
        value: "opus",
        displayName: "Opus 5.5",
        description: "Opus 5.5 · Best for everyday work",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
        supportsAdaptiveThinking: true,
      },
    ];
    try {
      const d = createClaudeDriver({ pluginDir: () => null });
      await d.refreshModels!();
      expect(d.models().find((m) => m.id === "opus")?.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
      sdk.calls.length = 0;
      const { input } = turnInput();
      input.model = "opus";
      input.effort = "high";
      await d.runTurn(input);
      expect(sdk.calls[0]?.options.effort).toBe("high");
      expect(sdk.calls[0]?.options.thinking).toEqual({ type: "adaptive", display: "summarized" });
    } finally {
      sdk.models = [];
    }
  });

  it("leaves effort and thinking off when neither was chosen or supported", async () => {
    sdk.calls.length = 0;
    sdk.models = [{ value: "haiku", displayName: "Haiku 4.5", description: "Haiku 4.5 · Fast", supportsAdaptiveThinking: false }];
    try {
      const d = createClaudeDriver({ pluginDir: () => null });
      await d.refreshModels!();
      sdk.calls.length = 0;
      const { input } = turnInput();
      input.model = "haiku";
      await d.runTurn(input);
      expect(sdk.calls[0]?.options).not.toHaveProperty("effort");
      expect(sdk.calls[0]?.options).not.toHaveProperty("thinking");
    } finally {
      sdk.models = [];
    }
  });
});

describe("Claude stream mapping", () => {
  const stream = (event: unknown, parentToolUseId: string | null = null) =>
    ({ type: "stream_event", parent_tool_use_id: parentToolUseId, event }) as unknown as SDKMessage;

  const recorder = () => {
    const textDeltas: { text: string; itemId?: string }[] = [];
    const reasoningDeltas: { itemId: string; text: string; opaque: boolean }[] = [];
    const toolInputDeltas: { toolUseId: string; text: string }[] = [];
    const thinkingProgress: { estimatedTokens: number }[] = [];
    const events: ThreadEvent[] = [];
    const input = {
      onEvent: (e: ThreadEvent) => events.push(e),
      onTextDelta: (text: string, itemId?: string) => textDeltas.push({ text, itemId }),
      onReasoningDelta: (d: { itemId: string; text: string; opaque: boolean }) => reasoningDeltas.push(d),
      onToolInputDelta: (d: { toolUseId: string; text: string }) => toolInputDeltas.push(d),
      onThinkingProgress: (p: { estimatedTokens: number }) => thinkingProgress.push(p),
    } as unknown as TurnInput;
    return { input, textDeltas, reasoningDeltas, toolInputDeltas, thinkingProgress, events };
  };

  it("maps streamed text, reasoning, and an empty thinking block's signature", () => {
    const { input, textDeltas, reasoningDeltas, events } = recorder();
    const turn = newTurnState();
    handleMessage(stream({ type: "message_start", message: { id: "m1", model: "claude-x" } }), input, turn);
    handleMessage(stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } }), input, turn);
    handleMessage(stream({ type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "hmm" } }), input, turn);
    handleMessage(stream({ type: "content_block_delta", index: 1, delta: { type: "signature_delta", signature: "sig1" } }), input, turn);
    handleMessage(
      {
        type: "assistant",
        parent_tool_use_id: null,
        message: { id: "m1", model: "claude-x", content: [{ type: "text", text: "Hi" }, { type: "thinking", thinking: "", signature: "" }] },
      } as unknown as SDKMessage,
      input,
      turn,
    );

    expect(textDeltas).toEqual([{ text: "Hi", itemId: "m1:0" }]);
    expect(reasoningDeltas).toEqual([{ itemId: "m1:1", text: "hmm", opaque: false }]);
    expect(events).toContainEqual({ kind: "assistant-text", text: "Hi", itemId: "m1:0" });
    expect(events).toContainEqual({ kind: "thinking", text: "", opaque: true, signature: "sig1", itemId: "m1:1" });
  });

  it("shows an account limit's own text as the one error, not a generic code or a reply", () => {
    const { input, events } = recorder();
    const limit = "You've hit your monthly spend limit. Switch to another model, or manage usage credits at claude.ai/settings/usage.";
    handleMessage(
      {
        type: "assistant",
        parent_tool_use_id: null,
        error: "rate_limit",
        message: { id: "m9", model: "<synthetic>", content: [{ type: "text", text: limit }] },
      } as unknown as SDKMessage,
      input,
      newTurnState(),
    );
    expect(events.filter((e) => e.kind === "error")).toEqual([{ kind: "error", message: limit }]);
    expect(events.some((e) => e.kind === "assistant-text")).toBe(false);
  });

  it("keys streamed tool input to the tool_use id from content_block_start", () => {
    const { input, toolInputDeltas } = recorder();
    const turn = newTurnState();
    handleMessage(stream({ type: "message_start", message: { id: "m1", model: "claude-x" } }), input, turn);
    handleMessage(stream({ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "tu1", name: "Bash", input: {} } }), input, turn);
    handleMessage(stream({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"a":' } }), input, turn);
    expect(toolInputDeltas).toEqual([{ toolUseId: "tu1", text: '{"a":' }]);
  });

  it("reports thinking token progress", () => {
    const { input, thinkingProgress } = recorder();
    handleMessage(
      { type: "system", subtype: "thinking_tokens", estimated_tokens: 42, estimated_tokens_delta: 42 } as unknown as SDKMessage,
      input,
      newTurnState(),
    );
    expect(thinkingProgress).toEqual([{ estimatedTokens: 42 }]);
  });

  it("keeps subagent stream frames out of the main thread", () => {
    const { input, textDeltas, reasoningDeltas, events } = recorder();
    handleMessage(stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "nope" } }, "x"), input, newTurnState());
    expect(textDeltas).toEqual([]);
    expect(reasoningDeltas).toEqual([]);
    expect(events).toEqual([]);
  });

  const feed = (input: TurnInput, turn: ReturnType<typeof newTurnState>, message: unknown) => handleMessage(message as SDKMessage, input, turn);

  it("folds TodoWrite into a plan and skips its tool row and result", () => {
    const { input, events } = recorder();
    const turn = newTurnState();
    feed(input, turn, {
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        id: "m1",
        model: "claude-x",
        content: [
          {
            type: "tool_use",
            id: "td1",
            name: "TodoWrite",
            input: {
              todos: [
                { content: "one", status: "completed", activeForm: "Doing one" },
                { content: "two", status: "pending" },
                { content: "drop", status: "cancelled" },
              ],
            },
          },
        ],
      },
    });
    feed(input, turn, { type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "td1", content: "ok" }] } });
    expect(events.filter((e) => e.kind === "plan")).toEqual([
      { kind: "plan", entries: [{ content: "one", status: "completed" }, { content: "two", status: "pending" }] },
    ]);
    expect(events.some((e) => e.kind === "tool-use" || e.kind === "tool-result")).toBe(false);
  });

  it("keeps a generic tool's input as its payload and its result text", () => {
    const { input, events } = recorder();
    const turn = newTurnState();
    feed(input, turn, {
      type: "assistant",
      parent_tool_use_id: null,
      message: { id: "m1", model: "claude-x", content: [{ type: "tool_use", id: "g1", name: "Grep", input: { pattern: "foo", path: "src" } }] },
    });
    feed(input, turn, { type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "g1", content: "src/a.ts:1:foo" }] } });
    expect(events.find((e) => e.kind === "tool-use")).toMatchObject({ kind: "tool-use", toolUseId: "g1", name: "Search", payload: { pattern: "foo", path: "src" } });
    expect(events.find((e) => e.kind === "tool-result")).toMatchObject({ kind: "tool-result", toolUseId: "g1", payload: "src/a.ts:1:foo" });
  });

  it("names a Task call Agent and summarises description · subagent", () => {
    const { input, events } = recorder();
    feed(input, newTurnState(), {
      type: "assistant",
      parent_tool_use_id: null,
      message: { id: "m1", model: "claude-x", content: [{ type: "tool_use", id: "a1", name: "Task", input: { description: "Find the bug", subagent_type: "Explore", prompt: "go" } }] },
    });
    expect(events.find((e) => e.kind === "tool-use")).toMatchObject({ kind: "tool-use", name: "Agent", summary: "Find the bug · Explore" });
  });

  it("keeps a background Agent's row open until its task_notification", () => {
    const { input, events } = recorder();
    const turn = newTurnState();
    feed(input, turn, {
      type: "assistant",
      parent_tool_use_id: null,
      message: { id: "m1", model: "claude-x", content: [{ type: "tool_use", id: "a1", name: "Agent", input: { description: "Look", subagent_type: "general-purpose", prompt: "go" } }] },
    });
    feed(input, turn, { type: "system", subtype: "task_started", task_id: "t1", tool_use_id: "a1", description: "Look", is_backgrounded: true });
    feed(input, turn, { type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "a1", content: "Async agent launched successfully. agentId: x" }] } });
    expect(events.some((e) => e.kind === "tool-result")).toBe(false);
    feed(input, turn, { type: "system", subtype: "task_notification", task_id: "t1", tool_use_id: "a1", status: "completed", output_file: "", summary: "Found add and sub" });
    expect(events.filter((e) => e.kind === "tool-result")).toEqual([{ kind: "tool-result", toolUseId: "a1", isError: false, summary: "Found add and sub", payload: "Found add and sub" }]);
  });

  it("nests a subagent's text and tool-use under its parent Agent, with no turn side effects", () => {
    const { input, events } = recorder();
    feed(input, newTurnState(), {
      type: "assistant",
      parent_tool_use_id: "tu-agent",
      message: {
        id: "m2",
        model: "claude-x",
        content: [
          { type: "text", text: "Looking around" },
          { type: "tool_use", id: "g1", name: "Grep", input: { pattern: "foo", path: "src" } },
        ],
      },
    });
    expect(events).toContainEqual({ kind: "assistant-text", text: "Looking around", itemId: "m2:0", parentId: "tu-agent" });
    expect(events.find((e) => e.kind === "tool-use")).toMatchObject({ kind: "tool-use", toolUseId: "g1", name: "Search", parentId: "tu-agent" });
    expect(events.some((e) => e.kind === "turn-start")).toBe(false);
  });

  it("nests a subagent's tool result under its parent Agent", () => {
    const { input, events } = recorder();
    const turn = newTurnState();
    feed(input, turn, {
      type: "assistant",
      parent_tool_use_id: "tu-agent",
      message: { id: "m2", model: "claude-x", content: [{ type: "tool_use", id: "g1", name: "Grep", input: { pattern: "foo" } }] },
    });
    feed(input, turn, { type: "user", parent_tool_use_id: "tu-agent", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "g1", content: "src/a.ts:1:foo" }] } });
    expect(events.find((e) => e.kind === "tool-result")).toMatchObject({ kind: "tool-result", toolUseId: "g1", parentId: "tu-agent" });
  });

  it("keeps a top-level tool-use without a parentId", () => {
    const { input, events } = recorder();
    feed(input, newTurnState(), {
      type: "assistant",
      parent_tool_use_id: null,
      message: { id: "m1", model: "claude-x", content: [{ type: "tool_use", id: "g1", name: "Grep", input: { pattern: "foo" } }] },
    });
    expect(events.find((e) => e.kind === "tool-use")).not.toHaveProperty("parentId");
    expect(events.some((e) => e.kind === "turn-start")).toBe(true);
  });
});

describe("turnEndFromResult", () => {
  const result = (usage: Record<string, number>) =>
    ({ type: "result", subtype: "success", duration_ms: 1200, total_cost_usd: 0.42, usage }) as unknown as SDKResultMessage;

  const turnEnd = (event: ThreadEvent) => {
    if (event.kind !== "turn-end") throw new Error(`expected turn-end, got ${event.kind}`);
    return event;
  };

  it("keeps cached tokens out of inputTokens and reports a hit rate", () => {
    const event = turnEnd(
      turnEndFromResult(
        result({ input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 8000, cache_creation_input_tokens: 2000 }),
      ),
    );
    expect(event.inputTokens).toBe(1000);
    expect(event.outputTokens).toBe(50);
    expect(event.costUsd).toBe(0.42);
    expect(event.durationMs).toBe(1200);
    expect(event.usage?.cacheReadTokens).toBe(8000);
    expect(event.usage?.cacheWriteTokens).toBe(2000);
    expect(event.usage?.hitRate).toBe(8000 / 11000);
    expect(event.usage?.provenance).toBe("reported");
  });

  it("reports cache usage unavailable when the vendor omits it", () => {
    const event = turnEnd(turnEndFromResult(result({ input_tokens: 1000, output_tokens: 50 })));
    expect(event.inputTokens).toBe(1000);
    expect(event.usage?.cacheReadTokens).toBeNull();
    expect(event.usage?.hitRate).toBeNull();
    expect(event.usage?.provenance).toBe("unavailable");
  });
});
