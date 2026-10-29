/// <reference types="vite/client" />
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContextPreview, StoredEvent, Usage } from "../src/shared/types";

const fakePreview: ContextPreview = {
  guide: [{ source: "bundled", path: "/app/HARNESS.md", tokens: 120 }],
  tools: [
    { name: "browser_open", tokens: 210 },
    { name: "browser_click", tokens: 90 },
  ],
  skills: { mode: "tool", count: 12, tokens: 640 },
  mcp: [
    { name: "github", tools: 26, tokens: 5120, deferred: false },
    { name: "linear", tools: 4, tokens: 900, deferred: true },
    { name: "broken", tools: null, tokens: null, deferred: false, error: "No answer in 5 seconds." },
  ],
  memoryIndex: null,
};

/** A turn's usage, defaulting the fields these tests don't care about. */
const usage = (over: Partial<Usage>): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  cacheTtl: null,
  hitRate: null,
  miss: false,
  provenance: "reported",
  ...over,
});

/** Two reporting turns, three tool calls, a compaction and two notices. */
const statEvents: StoredEvent[] = [
  {
    seq: 1,
    event: {
      kind: "turn-end",
      costUsd: null,
      inputTokens: 100,
      outputTokens: 0,
      durationMs: 0,
      usage: usage({ inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 1000 }),
      steps: 3,
      pruned: 0,
    },
    createdAt: 0,
  },
  {
    seq: 2,
    event: {
      kind: "turn-end",
      costUsd: null,
      inputTokens: 100,
      outputTokens: 0,
      durationMs: 0,
      usage: usage({ inputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 0, hitRate: 0.9, miss: true }),
      steps: 1,
      pruned: 2,
    },
    createdAt: 0,
  },
  { seq: 3, event: { kind: "tool-use", toolUseId: "u1", name: "read", summary: "read a" }, createdAt: 0 },
  { seq: 4, event: { kind: "tool-use", toolUseId: "u2", name: "read", summary: "read b" }, createdAt: 0 },
  { seq: 5, event: { kind: "tool-use", toolUseId: "u3", name: "read", summary: "read c" }, createdAt: 0 },
  { seq: 6, event: { kind: "compaction", trigger: "auto", preTokens: 100, postTokens: 50 }, createdAt: 0 },
  { seq: 7, event: { kind: "notice", text: "flagged", evidence: ["a", "b"] }, createdAt: 0 },
  { seq: 8, event: { kind: "notice", text: "ordinary" }, createdAt: 0 },
];

/** A single turn that reports nothing about cache, steps or pruning. */
const bareTurnEvents: StoredEvent[] = [
  { seq: 1, event: { kind: "turn-end", costUsd: null, inputTokens: 10, outputTokens: 5, durationMs: 0 }, createdAt: 0 },
];

describe("breakdownRows", () => {
  it("returns the latest context-breakdown event, or null", async () => {
    const { breakdownRows } = await import("../src/renderer/src/components/ContextSheet");
    const events: StoredEvent[] = [
      { seq: 1, event: { kind: "user", text: "hi" }, createdAt: 0 },
      { seq: 2, event: { kind: "context-breakdown", rows: [{ label: "Harness guide", tokens: 10 }], total: 10, estimated: true }, createdAt: 0 },
      { seq: 3, event: { kind: "context-breakdown", rows: [{ label: "Harness tools", tokens: 20 }], total: 20, estimated: false }, createdAt: 0 },
    ];
    expect(breakdownRows(events)?.rows).toEqual([{ label: "Harness tools", tokens: 20 }]);
    expect(breakdownRows([])).toBeNull();
    expect(breakdownRows(undefined)).toBeNull();
  });
});

describe("agentShare", () => {
  it("is the total minus the listed rows, never negative", async () => {
    const { agentShare } = await import("../src/renderer/src/components/ContextSheet");
    const rows = [{ label: "Harness tools", tokens: 582 }, { label: "Harness guide", tokens: 546 }];
    expect(agentShare({ kind: "context-breakdown", rows, total: 14707, estimated: true })).toBe(13579);
    expect(agentShare({ kind: "context-breakdown", rows, total: 100, estimated: true })).toBe(0);
    expect(agentShare({ kind: "context-breakdown", rows, total: null, estimated: true })).toBe(0);
  });
});

describe("threadStats", () => {
  it("rolls up turns, cache hits, steps, tools, compactions, pruning and flags", async () => {
    const { threadStats } = await import("../src/renderer/src/components/ContextSheet");
    expect(threadStats(statEvents)).toEqual({
      turns: 2,
      hitRate: { all: 900 / 2100, last: 0.9 },
      steps: { total: 4, perTurn: 2 },
      toolCalls: 3,
      compactions: 1,
      pruned: 2,
      misses: 1,
      evidenceFlags: 2,
    });
  });

  it("reports nulls for a turn that says nothing about cache, steps or pruning", async () => {
    const { threadStats } = await import("../src/renderer/src/components/ContextSheet");
    expect(threadStats(bareTurnEvents)).toEqual({
      turns: 1,
      hitRate: null,
      steps: null,
      toolCalls: 0,
      compactions: 0,
      pruned: null,
      misses: 0,
      evidenceFlags: 0,
    });
  });
});

describe("threadStatRows", () => {
  it("builds the labelled rows in order", async () => {
    const { threadStats, threadStatRows } = await import("../src/renderer/src/components/ContextSheet");
    expect(threadStatRows(threadStats(statEvents))).toEqual([
      { label: "Turns", value: "2" },
      { label: "Prompt cache hit", value: "43% all turns · 90% last turn" },
      { label: "Model steps", value: "4 · 2.0 per turn" },
      { label: "Tool calls", value: "3" },
      { label: "Compactions", value: "1" },
      { label: "Tool outputs cleared to fit", value: "2" },
      { label: "Unexpected cache misses", value: "1" },
      { label: "Evidence flags", value: "2" },
    ]);
  });

  it("omits the step and pruning rows and dashes the cache hit when unreported", async () => {
    const { threadStats, threadStatRows } = await import("../src/renderer/src/components/ContextSheet");
    expect(threadStatRows(threadStats(bareTurnEvents))).toEqual([
      { label: "Turns", value: "1" },
      { label: "Prompt cache hit", value: "—" },
      { label: "Tool calls", value: "0" },
      { label: "Compactions", value: "0" },
      { label: "Unexpected cache misses", value: "0" },
      { label: "Evidence flags", value: "0" },
    ]);
  });
});

describe("ContextSheet", () => {
  afterEach(() => vi.unstubAllGlobals());

  // `renderToStaticMarkup` runs no effects, so the fetch never resolves during
  // it: the resolved preview arrives through the same `preview` prop the app
  // leaves unset. The api is still stubbed, as the connected sheet would call it.
  const render = async (preview: ContextPreview, events: StoredEvent[] = []) => {
    vi.stubGlobal("window", { unskilled: { contextPreview: vi.fn(() => Promise.resolve(preview)) } });
    const { useStore } = await import("../src/renderer/src/store");
    const { ContextSheet } = await import("../src/renderer/src/components/ContextSheet");
    const state = useStore.getInitialState();
    const savedOpen = state.contextSheetOpen;
    const savedThread = state.contextSheetThread;
    const savedEvents = state.events;
    try {
      state.contextSheetOpen = true;
      state.contextSheetThread = "t1";
      state.events = { t1: events };
      return renderToStaticMarkup(<ContextSheet preview={preview} />);
    } finally {
      state.contextSheetOpen = savedOpen;
      state.contextSheetThread = savedThread;
      state.events = savedEvents;
    }
  };

  it("renders the harness preview, a tool name, and its token total", async () => {
    const html = await render(fakePreview);
    expect(html).toContain("Added by CubiQ");
    expect(html).toContain("browser_open");
    expect(html).toContain("Bundled guide");
    expect(html).toContain("300"); // 210 + 90 tools total
    expect(html).toContain("github");
  });

  it("renders the skills line", async () => {
    const html = await render(fakePreview);
    expect(html).toContain("Skills");
    expect(html).toContain("12 skills · 640 tokens · the skill tool plus the agent&#x27;s own listing");
  });

  it("marks a deferred MCP row and leaves it out of the total", async () => {
    const html = await render(fakePreview);
    expect(html).toContain("4 tools · 900 (deferred)");
    expect(html).toContain("26 tools · 5,120");
    // Total counts github only (5,120); linear is deferred and broken has no tokens.
    expect(html).not.toContain("6,020");
  });

  it("shows why a server couldn't be listed", async () => {
    const html = await render(fakePreview);
    // static markup escapes the apostrophe.
    expect(html).toContain("couldn&#x27;t list: No answer in 5 seconds.");
  });

  it("renders the latest first-turn breakdown", async () => {
    const events: StoredEvent[] = [
      { seq: 1, event: { kind: "context-breakdown", rows: [{ label: "Harness tools", tokens: 1234 }], total: 1234, estimated: true }, createdAt: 0 },
    ];
    const html = await render(fakePreview, events);
    expect(html).toContain("First turn");
    expect(html).toContain("(estimated)");
    expect(html).toContain("Harness tools");
    expect(html).toContain("1,234");
  });

  it("renders the thread's telemetry", async () => {
    const html = await render(fakePreview, statEvents);
    expect(html).toContain("This thread");
    expect(html).toContain("Prompt cache hit");
    expect(html).toContain("4 · 2.0 per turn");
  });

  it("says there are no turns yet on an unrun thread", async () => {
    const html = await render(fakePreview, []);
    expect(html).toContain("No turns yet.");
  });

  it("renders nothing when closed", async () => {
    vi.stubGlobal("window", { unskilled: { contextPreview: vi.fn(() => Promise.resolve(fakePreview)) } });
    const { useStore } = await import("../src/renderer/src/store");
    const { ContextSheet } = await import("../src/renderer/src/components/ContextSheet");
    const state = useStore.getInitialState();
    const saved = state.contextSheetOpen;
    try {
      state.contextSheetOpen = false;
      expect(renderToStaticMarkup(<ContextSheet preview={fakePreview} />)).toBe("");
    } finally {
      state.contextSheetOpen = saved;
    }
  });
});
