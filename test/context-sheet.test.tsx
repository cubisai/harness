/// <reference types="vite/client" />
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContextPreview, StoredEvent } from "../src/shared/types";

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
