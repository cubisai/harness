import { describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelInfo, SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { bundledClaudeVersion, createClaudeDriver, FIRST_RELIST_MS, fromSdk, handleMessage, harnessToolOptions, newTurnState, pickClaudeExecutable, priceUsage, resolvePackagedClaudeBinary, TOOL_SERVER, turnEndFromResult } from "../src/main/agents/claude";
import { MODEL_TTL_MS } from "../src/main/agents/model-ttl";
import { MEMORY_READ_TOOL, MEMORY_WRITE_TOOL } from "../src/main/memory/tool";
import type { HarnessTool, ToolContext, TurnInput } from "../src/main/agents/types";
import type { ThreadEvent } from "../src/shared/types";
import { tempDir } from "./helpers";

// The SDK's `query` is faked so the per-turn `options` (where the guide lands)
// can be read without launching Claude Code. Everything else is the real SDK.
const sdk = vi.hoisted(() => ({
  calls: [] as { prompt: unknown; options: Record<string, unknown> }[],
  models: [] as ModelInfo[],
  // The shape getContextUsage() resolves with; set per test that reads it.
  contextUsage: null as unknown,
  // Each queued attempt is a stream of messages, optionally ending in a throw
  // (the SDK's shape when a query fails after emitting its result).
  attempts: [] as { messages: unknown[]; error?: string }[],
}));
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return {
    ...actual,
    query: (args: { prompt: unknown; options: Record<string, unknown> }) => {
      sdk.calls.push(args);
      const attempt = sdk.attempts.shift();
      // Mirrors the real SDK: the query is closed once its result is yielded,
      // so getContextUsage() after that rejects.
      let closed = false;
      return {
        supportedModels: async () => sdk.models,
        getContextUsage: async () => {
          if (closed) throw new Error("Query closed before response received");
          return sdk.contextUsage;
        },
        [Symbol.asyncIterator]: async function* () {
          if (!attempt) return;
          for (const message of attempt.messages) {
            if ((message as { type?: string }).type === "result") closed = true;
            yield message as SDKMessage;
          }
          if (attempt.error) throw new Error(attempt.error);
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
    requestPlanDecision: async () => ({ keep: "" }),
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

describe("pickClaudeExecutable", () => {
  it("prefers a newer installed CLI over the SDK's bundled binary", () => {
    const installed = { path: "/usr/local/bin/claude", version: "2.1.284" };
    expect(pickClaudeExecutable({ bundledVersion: "2.1.281", installed, packaged: undefined })).toBe(installed.path);
  });

  it("prefers the packaged binary when the installed CLI is older", () => {
    const installed = { path: "/usr/local/bin/claude", version: "2.1.200" };
    expect(pickClaudeExecutable({ bundledVersion: "2.1.281", installed, packaged: "/app/claude" })).toBe("/app/claude");
  });

  it("falls back to the packaged binary when no CLI is installed", () => {
    expect(pickClaudeExecutable({ bundledVersion: "2.1.281", installed: null, packaged: "/app/claude" })).toBe("/app/claude");
  });

  it("prefers the installed CLI when the SDK reports no bundled version", () => {
    const installed = { path: "/usr/local/bin/claude", version: "2.1.284" };
    expect(pickClaudeExecutable({ bundledVersion: null, installed, packaged: "/app/claude" })).toBe(installed.path);
  });

  it("treats an equal version as current, and an unreadable one as not", () => {
    expect(pickClaudeExecutable({ bundledVersion: "2.1.281", installed: { path: "/c", version: "2.1.281" }, packaged: "/app/claude" })).toBe("/c");
    expect(pickClaudeExecutable({ bundledVersion: "2.1.281", installed: { path: "/c", version: "unknown" }, packaged: "/app/claude" })).toBe("/app/claude");
  });
});

describe("bundledClaudeVersion", () => {
  it("reads the SDK's bundled claudeCodeVersion from this repo's node_modules", () => {
    expect(bundledClaudeVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("fromSdk", () => {
  it("reads the newer format's versioned displayName", () => {
    const list: ModelInfo[] = [{ value: "sonnet", displayName: "Sonnet 5.5", description: "Most efficient for simpler tasks" }];
    expect(fromSdk(list)).toEqual([{ id: "sonnet", label: "Sonnet 5.5" }]);
  });

  it("keeps the older format's versioned description head", () => {
    const list: ModelInfo[] = [{ value: "opus", displayName: "Opus", description: "Opus 5.5 · Best for everyday work" }];
    expect(fromSdk(list)).toEqual([{ id: "opus", label: "Opus 5.5" }]);
  });

  it("keeps the Default (…) handling for the older format", () => {
    const list: ModelInfo[] = [{ value: "sonnet", displayName: "Default", description: "Sonnet 5.5 · Best for everyday work" }];
    expect(fromSdk(list)).toEqual([{ id: "sonnet", label: "Default (Sonnet 5.5)" }]);
  });

  it("keeps the efforts mapping", () => {
    const list: ModelInfo[] = [
      { value: "opus", displayName: "Opus 5.5", description: "Best for everyday work", supportsEffort: true, supportedEffortLevels: ["low", "high"] },
    ];
    expect(fromSdk(list)).toEqual([{ id: "opus", label: "Opus 5.5", efforts: ["low", "high"] }]);
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

  it("re-lists quickly once after the first listing, then only on the model TTL", async () => {
    let clock = 1_000_000_000;
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    sdk.calls.length = 0;
    sdk.models = [{ value: "sonnet", displayName: "Sonnet 5.5", description: "Most efficient for simpler tasks" }];
    try {
      const d = createClaudeDriver({ pluginDir: () => null });
      await d.refreshModels!();
      expect(sdk.calls).toHaveLength(1);
      expect(d.models().find((m) => m.id === "sonnet")?.label).toBe("Sonnet 5.5");
      // Within the quick re-list window the list is trusted: no second listing.
      await d.refreshModels!();
      expect(sdk.calls).toHaveLength(1);
      // The CLI can serve a stale cached list first, so one quick re-list is
      // allowed after FIRST_RELIST_MS.
      clock += FIRST_RELIST_MS;
      sdk.models = [{ value: "sonnet", displayName: "Sonnet 6", description: "Newest" }];
      await d.refreshModels!();
      expect(sdk.calls).toHaveLength(2);
      expect(d.models().find((m) => m.id === "sonnet")?.label).toBe("Sonnet 6");
      // That was the one quick re-list; now only the full TTL asks again.
      await d.refreshModels!();
      expect(sdk.calls).toHaveLength(2);
      clock += MODEL_TTL_MS;
      sdk.models = [{ value: "sonnet", displayName: "Sonnet 7", description: "Newest" }];
      await d.refreshModels!();
      expect(sdk.calls).toHaveLength(3);
      expect(d.models().find((m) => m.id === "sonnet")?.label).toBe("Sonnet 7");
    } finally {
      now.mockRestore();
      sdk.models = [];
    }
  });
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

  it("appends the expert block between the guide and the memory", async () => {
    sdk.calls.length = 0;
    const d = createClaudeDriver({ pluginDir: () => null, guide: () => "GUIDE" });
    const { input } = turnInput();
    input.expert = "<expert>Be terse.</expert>";
    await d.runTurn(input);
    expect(sdk.calls).toHaveLength(1);
    expect(sdk.calls[0]?.options.systemPrompt).toEqual({ type: "preset", preset: "claude_code", append: "GUIDE\n\n<expert>Be terse.</expert>" });
  });
});

describe("Claude driver design threads", () => {
  it("gives a design thread its design plugin and lets it read the skill folders; a chat thread gets neither", async () => {
    sdk.calls.length = 0;
    const plugins: [string, boolean | undefined][] = [];
    const d = createClaudeDriver({
      pluginDir: (cwd, design) => {
        plugins.push([cwd, design]);
        return design ? "/tmp/plugin-design" : "/tmp/plugin";
      },
      skillDirs: () => ["/app/skills", "/data/skills"],
    });
    const chat = turnInput();
    await d.runTurn(chat.input);
    const design = turnInput();
    await d.runTurn({ ...design.input, design: "designs/abcd1234" });
    expect(plugins).toEqual([
      ["/tmp/project", false],
      ["/tmp/project", true],
    ]);
    expect(sdk.calls[0]?.options).not.toHaveProperty("additionalDirectories");
    expect(sdk.calls[1]?.options.additionalDirectories).toEqual(["/tmp/plugin-design", "/app/skills", "/data/skills"]);
  });
});

describe("Claude driver memory", () => {
  it("appends the memory block after the guide and disables Claude's own auto-memory", async () => {
    sdk.calls.length = 0;
    const calls: { projectId: string; threadId?: string; sessionKey?: string | null }[] = [];
    const d = createClaudeDriver({
      pluginDir: () => null,
      guide: () => "GUIDE",
      memory: (projectId, threadId, sessionKey) => {
        calls.push({ projectId, threadId, sessionKey });
        return "MEMORY";
      },
    });
    const { input } = turnInput();
    input.projectId = "p1";
    input.threadId = "t1";
    await d.runTurn(input);
    expect(calls).toEqual([{ projectId: "p1", threadId: "t1", sessionKey: null }]);
    expect(sdk.calls[0]?.options.settings).toEqual({ autoMemoryEnabled: false });
    expect(sdk.calls[0]?.options.settings).not.toHaveProperty("autoMemoryDirectory");
    expect(sdk.calls[0]?.options.systemPrompt).toEqual({ type: "preset", preset: "claude_code", append: "GUIDE\n\nMEMORY" });
  });

  it("passes the agent session id so a resumed session keeps the block it first saw", async () => {
    sdk.calls.length = 0;
    const keys: (string | null | undefined)[] = [];
    const d = createClaudeDriver({
      pluginDir: () => null,
      memory: (_projectId, _threadId, sessionKey) => {
        keys.push(sessionKey);
        return "MEMORY";
      },
    });
    const { input } = turnInput();
    input.projectId = "p1";
    input.sessionId = "sess-1";
    await d.runTurn(input);
    expect(keys).toEqual(["sess-1"]);
  });

  it("leaves settings out when memory is off or there's no project", async () => {
    sdk.calls.length = 0;
    const off = createClaudeDriver({ pluginDir: () => null, memory: () => null });
    const { input } = turnInput();
    input.projectId = "p1";
    await off.runTurn(input);
    expect(sdk.calls[0]?.options).not.toHaveProperty("settings");

    sdk.calls.length = 0;
    const noProject = createClaudeDriver({ pluginDir: () => null, memory: () => "MEMORY" });
    const { input: input2 } = turnInput();
    await noProject.runTurn(input2);
    expect(sdk.calls[0]?.options).not.toHaveProperty("settings");
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

describe("Claude lost sessions", () => {
  it("calls onSessionLost, emits no error, and retries once without resume", async () => {
    sdk.calls.length = 0;
    sdk.attempts.length = 0;
    const text = "No conversation found with session ID: abc";
    sdk.attempts.push({
      messages: [{ type: "result", subtype: "error_during_execution", errors: [text], duration_ms: 1, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } }],
      error: `Claude Code returned an error result: ${text}`,
    });
    const d = createClaudeDriver({ pluginDir: () => null });
    const { input, events } = turnInput();
    input.sessionId = "abc";
    const reasons: string[] = [];
    input.onSessionLost = async (reason) => {
      reasons.push(reason);
      return { promptPrefix: "SEED" };
    };
    await d.runTurn(input);
    expect(reasons).toEqual([expect.stringContaining("No conversation found")]);
    expect(events.some((e) => e.kind === "error")).toBe(false);
    expect(sdk.calls).toHaveLength(2);
    expect(sdk.calls[1]?.options.resume).toBeUndefined();
    expect(sdk.calls[1]?.prompt).toBe("SEED\n---\nhi");
  });
});

describe("Claude context breakdown", () => {
  /** A getContextUsage() response with two used rows (one out of order) and a free row. */
  function usageResponse(): unknown {
    return {
      categories: [
        { name: "System prompt", tokens: 500, color: "#c1", kind: "used" },
        { name: "Tools", tokens: 2000, color: "#c2", kind: "used" },
        { name: "Free space", tokens: 197500, color: "#c3", kind: "free" },
      ],
      totalTokens: 2500,
      maxTokens: 200000,
      rawMaxTokens: 200000,
      percentage: 1.25,
      gridRows: [],
      model: "claude-x",
      memoryFiles: [],
      mcpTools: [],
      agents: [],
      isAutoCompactEnabled: false,
    };
  }

  const successResult = { type: "result", subtype: "success", duration_ms: 1, total_cost_usd: null, usage: { input_tokens: 10, output_tokens: 5 } };
  // The query's first frame; getContextUsage() is only valid before the result.
  const initMessage = { type: "system", subtype: "init", session_id: "s1" };

  it("emits one breakdown before turn-end for a new session's first result", async () => {
    sdk.calls.length = 0;
    sdk.attempts.length = 0;
    sdk.contextUsage = usageResponse();
    sdk.attempts.push({ messages: [initMessage, successResult] });
    const d = createClaudeDriver({ pluginDir: () => null });
    const { input, events } = turnInput();
    await d.runTurn(input);
    const breakdowns = events.filter((e) => e.kind === "context-breakdown");
    expect(breakdowns).toEqual([
      {
        kind: "context-breakdown",
        rows: [
          { label: "Tools", tokens: 2000 },
          { label: "System prompt", tokens: 500 },
        ],
        total: 2500,
        estimated: false,
      },
    ]);
    // The breakdown must land before the turn's summary.
    expect(events.findIndex((e) => e.kind === "context-breakdown")).toBeLessThan(events.findIndex((e) => e.kind === "turn-end"));
  });

  it("emits no breakdown for a resumed session", async () => {
    sdk.calls.length = 0;
    sdk.attempts.length = 0;
    sdk.contextUsage = usageResponse();
    sdk.attempts.push({ messages: [initMessage, successResult] });
    const d = createClaudeDriver({ pluginDir: () => null });
    const { input, events } = turnInput();
    input.sessionId = "abc";
    await d.runTurn(input);
    expect(events.some((e) => e.kind === "context-breakdown")).toBe(false);
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
    const usageUpdates: { contextUsed?: number; contextSize?: number }[] = [];
    const events: ThreadEvent[] = [];
    const input = {
      onEvent: (e: ThreadEvent) => events.push(e),
      onTextDelta: (text: string, itemId?: string) => textDeltas.push({ text, itemId }),
      onReasoningDelta: (d: { itemId: string; text: string; opaque: boolean }) => reasoningDeltas.push(d),
      onToolInputDelta: (d: { toolUseId: string; text: string }) => toolInputDeltas.push(d),
      onThinkingProgress: (p: { estimatedTokens: number }) => thinkingProgress.push(p),
      onUsageUpdate: (u: { contextUsed?: number; contextSize?: number }) => usageUpdates.push(u),
    } as unknown as TurnInput;
    return { input, textDeltas, reasoningDeltas, toolInputDeltas, thinkingProgress, events, usageUpdates };
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

  it("records the last main-thread call's context input and fires onUsageUpdate", () => {
    const { input, usageUpdates } = recorder();
    const turn = newTurnState();
    feed(input, turn, {
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        id: "m1",
        model: "claude-opus-4",
        content: [{ type: "text", text: "hi" }],
        usage: { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 8000, cache_creation_input_tokens: 2000 },
      },
    });
    expect(turn.contextInputTokens).toBe(10100);
    expect(turn.model).toBe("claude-opus-4");
    expect(usageUpdates).toEqual([{ contextUsed: 10100 }]);
    // A subagent's message leaves the main thread's context bookkeeping alone.
    feed(input, turn, {
      type: "assistant",
      parent_tool_use_id: "tu-agent",
      message: { id: "m2", model: "claude-haiku", content: [], usage: { input_tokens: 50, output_tokens: 1 } },
    });
    expect(turn.contextInputTokens).toBe(10100);
    expect(turn.model).toBe("claude-opus-4");
    expect(usageUpdates).toHaveLength(1);
  });

  it("passes the recorded context onto the turn-end event", () => {
    const { input, events } = recorder();
    const turn = newTurnState();
    feed(input, turn, {
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        id: "m1",
        model: "claude-opus-4",
        content: [],
        usage: { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 8000, cache_creation_input_tokens: 2000 },
      },
    });
    feed(input, turn, {
      type: "result",
      subtype: "success",
      duration_ms: 5,
      total_cost_usd: null,
      usage: { input_tokens: 100, output_tokens: 5 },
      modelUsage: { "claude-opus-4": { contextWindow: 200000 } },
    });
    expect(events.find((e) => e.kind === "turn-end")).toMatchObject({
      kind: "turn-end",
      usage: { contextUsed: 10100, contextSize: 200000 },
    });
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

  it("reports the turn's context input and the model's window", () => {
    const message = {
      type: "result",
      subtype: "success",
      duration_ms: 1200,
      total_cost_usd: 0.42,
      usage: { input_tokens: 100, output_tokens: 50 },
      modelUsage: { "claude-opus-4": { contextWindow: 200000 } },
    } as unknown as SDKResultMessage;
    const event = turnEnd(turnEndFromResult(message, 42000, "claude-opus-4"));
    expect(event.usage?.contextUsed).toBe(42000);
    expect(event.usage?.contextSize).toBe(200000);
  });

  it("falls back to the widest window when the model key doesn't match", () => {
    const message = {
      type: "result",
      subtype: "success",
      duration_ms: 1200,
      total_cost_usd: 0.42,
      usage: { input_tokens: 100, output_tokens: 50 },
      modelUsage: { "claude-haiku": { contextWindow: 100000 }, "claude-opus-4": { contextWindow: 500000 } },
    } as unknown as SDKResultMessage;
    const event = turnEnd(turnEndFromResult(message, 42000, "claude-unknown"));
    expect(event.usage?.contextSize).toBe(500000);
  });

  it("reports no context figures without a reported window", () => {
    const event = turnEnd(turnEndFromResult(result({ input_tokens: 1000, output_tokens: 50 }), null, null));
    expect(event.usage?.contextUsed).toBeNull();
    expect(event.usage?.contextSize).toBeNull();
  });
});

describe("Claude plan mode", () => {
  type CanUseTool = (
    name: string,
    toolInput: Record<string, unknown>,
    opts: { suggestions: unknown[] },
  ) => Promise<{ behavior: string; updatedPermissions?: { type: string; mode?: string; destination?: string }[]; message?: string }>;

  async function gate(input: TurnInput): Promise<CanUseTool> {
    sdk.calls.length = 0;
    sdk.attempts.length = 0;
    const d = createClaudeDriver({ pluginDir: () => null });
    await d.runTurn(input);
    return sdk.calls[0]!.options.canUseTool as CanUseTool;
  }

  it("auto answers the plan by allowing edits for the session", async () => {
    const { input } = turnInput();
    input.permissionMode = "plan";
    input.requestPlanDecision = async () => "auto";
    const canUseTool = await gate(input);
    const res = await canUseTool("ExitPlanMode", { plan: "Do the thing" }, { suggestions: [] });
    expect(res.behavior).toBe("allow");
    expect(res.updatedPermissions).toEqual([{ type: "setMode", mode: "acceptEdits", destination: "session" }]);
  });

  it("manual answers the plan by allowing edits under the default mode", async () => {
    const { input } = turnInput();
    input.permissionMode = "plan";
    input.requestPlanDecision = async () => "manual";
    const canUseTool = await gate(input);
    const res = await canUseTool("ExitPlanMode", { plan: "Do the thing" }, { suggestions: [] });
    expect(res.behavior).toBe("allow");
    expect(res.updatedPermissions).toEqual([{ type: "setMode", mode: "default", destination: "session" }]);
  });

  it("keep denies with the user's feedback", async () => {
    const { input } = turnInput();
    input.permissionMode = "plan";
    input.requestPlanDecision = async () => ({ keep: "Cover the tests too" });
    const canUseTool = await gate(input);
    const res = await canUseTool("ExitPlanMode", { plan: "Do the thing" }, { suggestions: [] });
    expect(res.behavior).toBe("deny");
    expect(res.message).toContain("Cover the tests too");
  });

  it("keep without feedback asks for a refined plan", async () => {
    const { input } = turnInput();
    input.permissionMode = "plan";
    const canUseTool = await gate(input);
    const res = await canUseTool("ExitPlanMode", { plan: "Do the thing" }, { suggestions: [] });
    expect(res.behavior).toBe("deny");
    expect(res.message).toMatch(/Refine the plan/);
  });

  it("answers AskUserQuestion from the user's card, keyed by question text", async () => {
    const { input } = turnInput();
    input.requestUserInput = async (qs) => ({ answers: { [qs[0]!.id]: ["Detailed"] }, notes: { [qs[0]!.id]: "with examples" } });
    const canUseTool = await gate(input);
    const questions = [{ question: "Which format?", header: "Format", multiSelect: false, options: [{ label: "Summary", description: "" }, { label: "Detailed", description: "" }] }];
    const res = (await canUseTool("AskUserQuestion", { questions }, { suggestions: [] })) as { behavior: string; updatedInput?: Record<string, unknown> };
    expect(res.behavior).toBe("allow");
    expect(res.updatedInput).toEqual({ questions, answers: { "Which format?": "Detailed" }, annotations: { "Which format?": { notes: "with examples" } } });
    expect(sdk.calls[0]!.options.toolConfig).toEqual({ askUserQuestion: { previewFormat: "markdown" } });
  });

  it("a skipped AskUserQuestion tells Claude to go on with its defaults, never a permission card", async () => {
    const { input } = turnInput();
    const asked: string[] = [];
    input.requestPermission = async (r) => {
      asked.push(r.toolName);
      return "allow-once";
    };
    input.requestUserInput = async () => "dismiss";
    const canUseTool = await gate(input);
    const res = await canUseTool("AskUserQuestion", { questions: [{ question: "Q?", header: "Q", multiSelect: false, options: [] }] }, { suggestions: [] });
    expect(res.behavior).toBe("deny");
    expect(res.message).toMatch(/recommended defaults/);
    expect(asked).toEqual([]);
  });

  it("reads the plan from planFilePath when no inline plan was sent", async () => {
    const file = join(tempDir(), "plan.md");
    writeFileSync(file, "# The plan");
    const { input } = turnInput();
    input.permissionMode = "plan";
    let seen = "";
    input.requestPlanDecision = async (p) => {
      seen = p.plan;
      return "auto";
    };
    const canUseTool = await gate(input);
    await canUseTool("ExitPlanMode", { planFilePath: file }, { suggestions: [] });
    expect(seen).toBe("# The plan");
  });
});

describe("Claude permission callback", () => {
  type CanUseTool = (
    name: string,
    toolInput: Record<string, unknown>,
    opts: { suggestions: unknown[] },
  ) => Promise<{ behavior: string; message?: string }>;

  async function gate(input: TurnInput): Promise<CanUseTool> {
    sdk.calls.length = 0;
    sdk.attempts.length = 0;
    const d = createClaudeDriver({ pluginDir: () => null });
    await d.runTurn(input);
    return sdk.calls[0]!.options.canUseTool as CanUseTool;
  }

  // The CLI routes Bash commands its shell parser can't read (heredocs, code
  // from stdin) to this callback even under bypassPermissions. Full access is
  // the app's "run everything without asking", so it must answer, not card.
  it("answers an unreadable Bash command itself in Full access, and asks in every other mode", async () => {
    const { input } = turnInput();
    const asked: string[] = [];
    input.requestPermission = async (r) => {
      asked.push(r.toolName);
      return "allow-once";
    };
    const command = { command: "python3 - <<'EOF'\nprint(1)\nEOF" };

    input.permissionMode = "full";
    const full = await gate(input);
    expect(await full("Bash", command, { suggestions: [] })).toMatchObject({ behavior: "allow" });
    expect(asked).toEqual([]);

    input.permissionMode = "ask";
    const ask = await gate(input);
    expect(await ask("Bash", command, { suggestions: [] })).toMatchObject({ behavior: "allow" });
    expect(asked).toEqual(["Bash"]);
  });
});

describe("harnessToolOptions", () => {
  const tool = (name: string, autoAllow = true): HarnessTool => ({ name, description: name, input: {}, autoAllow, run: async () => ({ text: "" }) });

  /** The in-process MCP server's registered handler for one tool, so a call can be simulated without launching Claude Code. */
  const handlerOf = (opts: ReturnType<typeof harnessToolOptions>, name: string) =>
    (opts.mcpServers?.[TOOL_SERVER] as unknown as { instance: { _registeredTools: Record<string, { handler: (args: unknown) => Promise<unknown> }> } }).instance._registeredTools[name]!.handler;

  it("offers every tool, including memory_read and memory_write", () => {
    const opts = harnessToolOptions([tool("browser_snapshot"), tool(MEMORY_READ_TOOL), tool(MEMORY_WRITE_TOOL), tool("browser_eval", false)]);
    expect(opts.allowedTools).toEqual([`mcp__${TOOL_SERVER}__browser_snapshot`, `mcp__${TOOL_SERVER}__${MEMORY_READ_TOOL}`, `mcp__${TOOL_SERVER}__${MEMORY_WRITE_TOOL}`]);
  });

  it("passes the tool context through to each tool's run", async () => {
    const seen: (ToolContext | undefined)[] = [];
    const record: HarnessTool = {
      name: MEMORY_READ_TOOL,
      description: "read",
      input: {},
      autoAllow: true,
      run: async (_args, ctx) => {
        seen.push(ctx);
        return { text: "" };
      },
    };
    const ctx: ToolContext = { projectId: "p1", threadId: "t1" };
    const opts = harnessToolOptions([record], ctx);
    await handlerOf(opts, MEMORY_READ_TOOL)({});
    expect(seen).toEqual([ctx]);
  });
});

describe("priceUsage", () => {
  it("prices uncached, cache-write and cache-read input and output per 1M tokens", () => {
    const usage = { input_tokens: 1_000, cache_creation_input_tokens: 1_000, cache_read_input_tokens: 10_000, output_tokens: 500 };
    expect(priceUsage(usage, { input: 1, output: 4, cacheRead: 0.1 })).toBeCloseTo((2_000 * 1 + 10_000 * 0.1 + 500 * 4) / 1e6);
    expect(priceUsage(usage, { input: 1, output: 4 })).toBeCloseTo((12_000 + 2_000) / 1e6);
    expect(priceUsage(usage, null)).toBeNull();
  });
});
