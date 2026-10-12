import { beforeEach, describe, expect, it } from "vitest";
import { selectorFor, startPicker } from "../src/main/browser/picker";
import { bridgeScript } from "../src/main/design/bridge";
import { chipLabel } from "../src/renderer/src/composer";
import { frameLayout, pageFromPath, pickChipText, readBridgeMessage } from "../src/renderer/src/design/frame";
import { DEFAULT_LAYOUT, DESIGN_FLOOR, clampLayout } from "../src/renderer/src/layout";
import { useStore } from "../src/renderer/src/store";
import type { Thread } from "../src/shared/types";

const element = { selector: "main > button:nth-of-type(2)", tag: "button", text: "Get started", html: "<button>Get started</button>", rect: { x: 10.4, y: 20.6, width: 120, height: 44 } };

describe("design frame", () => {
  it("fills the stage on Fit and scales a preset down to fit, never up", () => {
    expect(frameLayout("fit", "fit", { width: 600, height: 500 })).toEqual({ width: 600, height: 500, scale: 1 });
    expect(frameLayout("desktop", "fit", { width: 768, height: 600 })).toEqual({ width: 1440, height: 900, scale: (768 - 48) / 1440 });
    expect(frameLayout("mobile", "fit", { width: 1000, height: 600 }).scale).toBe(1);
    // A slide fits both ways.
    expect(frameLayout("slide", "fit", { width: 2000, height: 600 }).scale).toBeCloseTo((600 - 48) / 1080);
    expect(frameLayout("tablet", 0.5, { width: 100, height: 100 })).toEqual({ width: 768, height: 1024, scale: 0.5 });
  });

  it("accepts only well-formed bridge messages", () => {
    expect(readBridgeMessage({ source: "cubiq-design", type: "ready" })).toEqual({ type: "ready" });
    expect(readBridgeMessage({ source: "cubiq-design", type: "scroll", x: 0, y: 120 })).toEqual({ type: "scroll", x: 0, y: 120 });
    expect(readBridgeMessage({ source: "cubiq-design", type: "picked", element })).toEqual({ type: "picked", element });
    expect(readBridgeMessage({ source: "other", type: "ready" })).toBeNull();
    expect(readBridgeMessage({ source: "cubiq-design", type: "scroll", x: "1", y: 2 })).toBeNull();
    expect(readBridgeMessage({ source: "cubiq-design", type: "picked", element: { ...element, text: "x".repeat(301) } })).toBeNull();
    expect(readBridgeMessage({ source: "cubiq-design", type: "picked", element: { ...element, rect: { x: 1 } } })).toBeNull();
    expect(readBridgeMessage({ source: "cubiq-design", type: "navigate", url: "https://example.com" })).toBeNull();
    expect(readBridgeMessage("ready")).toBeNull();
  });

  it("reads the ready path and maps a frame's location back to a page", () => {
    expect(readBridgeMessage({ source: "cubiq-design", type: "ready", path: "/t1/index.html" })).toEqual({ type: "ready", path: "/t1/index.html" });
    expect(readBridgeMessage({ source: "cubiq-design", type: "ready", path: 5 })).toEqual({ type: "ready" });
    expect(pageFromPath("/t1/pricing.html", "t1")).toBe("pricing.html");
    expect(pageFromPath("/t1/a%20b.html", "t1")).toBe("a b.html");
    expect(pageFromPath("/t2/x.html", "t1")).toBeNull();
    expect(pageFromPath("/t1/", "t1")).toBeNull();
    expect(pageFromPath("/t1/../x.html", "t1")).toBeNull();
    expect(pageFromPath("/t1/%E0%A4%A.html", "t1")).toBeNull();
  });

  it("turns a pick into a chip that shows the selector", () => {
    const text = pickChipText(element, "designs/abcd1234/index.html");
    expect(text.split("\n")[0]).toBe("Element `main > button:nth-of-type(2)` in designs/abcd1234/index.html");
    expect(text).toContain('Text: "Get started"');
    expect(text).toContain("Box: 120×44 at 10,21");
    expect(chipLabel(text)).toBe("main > button:nth-of-type(2)");
  });

  it("ships page scripts that are plain, self-contained JavaScript", () => {
    expect(() => new Function(bridgeScript(selectorFor))).not.toThrow();
    // The browser pane's picker still gets its selector helper the same way.
    expect(() => new Function(`(${startPicker.toString()})("b", ${selectorFor.toString()})`)).not.toThrow();
  });
});

describe("design layout floor", () => {
  it("leaves the chat's own clamp unchanged without a floor", () => {
    expect(clampLayout(1402, { ...DEFAULT_LAYOUT, sidebar: 359, inspector: 623 })).toEqual(clampLayout(1402, { ...DEFAULT_LAYOUT, sidebar: 359, inspector: 623 }, true, undefined));
  });

  it("narrows the side panel so a design thread keeps chat + canvas room", () => {
    const r = clampLayout(1280, { ...DEFAULT_LAYOUT, sidebar: 256, inspector: 460 }, true, DESIGN_FLOOR);
    expect(r.main).toBeGreaterThanOrEqual(DESIGN_FLOOR);
    expect(r.inspectorMax).toBe(1280 - 256 - DESIGN_FLOOR);
    // Too narrow for both: the panel steps aside rather than squeezing the canvas.
    const narrow = clampLayout(1000, { ...DEFAULT_LAYOUT, sidebar: 256, inspector: 460 }, true, DESIGN_FLOOR);
    expect(narrow.main).toBeGreaterThanOrEqual(DESIGN_FLOOR);
  });
});

describe("artifact panel auto-open", () => {
  const thread = (id: string, patch: Partial<Thread> = {}): Thread => ({
    id,
    projectId: "p",
    agent: "claude",
    title: id,
    sessionId: null,
    bindings: {},
    model: "default",
    effort: null,
    permissionMode: "ask",
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  });

  beforeEach(() => {
    (globalThis as { window?: unknown }).window = { unskilled: new Proxy({}, { get: () => async () => [] }) };
    useStore.setState({
      selectedProjectId: "p",
      threads: { p: [thread("chat-thread"), thread("design01-thread", { kind: "design" })] },
      artifact: null,
      inspectorOpen: false,
    });
  });

  it("still opens for a chat thread's file", () => {
    useStore.setState({ selectedThreadId: "chat-thread" });
    useStore.getState().apply({ type: "artifact-ready", threadId: "chat-thread", path: "designs/x/index.html", files: [] });
    expect(useStore.getState().artifact).toEqual({ threadId: "chat-thread", path: "designs/x/index.html" });
  });

  it("stays shut for a design thread's own page, but opens for its other files", () => {
    useStore.setState({ selectedThreadId: "design01-thread" });
    useStore.getState().apply({ type: "artifact-ready", threadId: "design01-thread", path: "designs/design01/index.html", files: [] });
    expect(useStore.getState().artifact).toBeNull();
    useStore.getState().apply({ type: "artifact-ready", threadId: "design01-thread", path: "report.pdf", files: [] });
    expect(useStore.getState().artifact).toEqual({ threadId: "design01-thread", path: "report.pdf" });
  });

  it("counts design-changed pushes per thread", () => {
    useStore.setState({ designReload: {} });
    useStore.getState().apply({ type: "design-changed", threadId: "design01-thread" });
    useStore.getState().apply({ type: "design-changed", threadId: "design01-thread" });
    expect(useStore.getState().designReload).toEqual({ "design01-thread": 2 });
  });
});
