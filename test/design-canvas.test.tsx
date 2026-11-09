import { beforeEach, describe, expect, it } from "vitest";
import { selectorFor, startPicker } from "../src/main/browser/picker";
import { bridgeScript } from "../src/main/design/bridge";
import { frameLayout, pageFromPath, readBridgeMessage, viewportForDevice } from "../src/renderer/src/design/frame";
import { DEFAULT_LAYOUT, DESIGN_FLOOR, clampLayout } from "../src/renderer/src/layout";
import { useStore } from "../src/renderer/src/store";
import type { Thread } from "../src/shared/types";

const selected = { selector: "main > button:nth-of-type(2)", tag: "button", text: "Get started", html: "<button>Get started</button>", rect: { x: 10.4, y: 20.6, width: 120, height: 44 }, path: [] };

describe("design frame", () => {
  it("fills the stage on Fit and scales a preset down to fit, never up", () => {
    expect(frameLayout("fit", "fit", { width: 600, height: 500 })).toEqual({ width: 600, height: 500, scale: 1 });
    expect(frameLayout("desktop", "fit", { width: 768, height: 600 })).toEqual({ width: 1440, height: 900, scale: (768 - 48) / 1440 });
    expect(frameLayout("mobile", "fit", { width: 1000, height: 600 }).scale).toBe(1);
    // A slide fits both ways.
    expect(frameLayout("slide", "fit", { width: 2000, height: 600 }).scale).toBeCloseTo((600 - 48) / 1080);
    expect(frameLayout("tablet", 0.5, { width: 100, height: 100 })).toEqual({ width: 768, height: 1024, scale: 0.5 });
  });

  it("opens a page in the device it declares and fits the whole phone", () => {
    expect(viewportForDevice("mobile")).toBe("mobile");
    expect(viewportForDevice("tablet")).toBe("tablet");
    expect(viewportForDevice("slide")).toBe("slide");
    // A desktop page, or one that declares nothing, opens on Desktop.
    expect(viewportForDevice("desktop")).toBe("desktop");
    expect(viewportForDevice(undefined)).toBe("desktop");
    // A 390 × 844 phone in a short stage scales down to show all of it.
    expect(frameLayout("mobile", "fit", { width: 1000, height: 600 }, true).scale).toBeCloseTo((600 - 48) / 844);
  });

  it("accepts only well-formed bridge messages", () => {
    expect(readBridgeMessage({ source: "cubiq-design", type: "ready" })).toEqual({ type: "ready" });
    expect(readBridgeMessage({ source: "cubiq-design", type: "ready", loaded: "a1-x9" })).toEqual({ type: "ready", loaded: "a1-x9" });
    expect(readBridgeMessage({ source: "cubiq-design", type: "ready", loaded: "<b>" })).toEqual({ type: "ready" });
    expect(readBridgeMessage({ source: "cubiq-design", type: "patched", ok: true, n: 3 })).toEqual({ type: "patched", ok: true, n: 3 });
    expect(readBridgeMessage({ source: "cubiq-design", type: "patched", ok: "yes", n: 3 })).toEqual({ type: "patched", ok: false, n: 3 });
    expect(readBridgeMessage({ source: "cubiq-design", type: "patched", ok: true })).toBeNull();
    expect(readBridgeMessage({ source: "cubiq-design", type: "scroll", x: 0, y: 120 })).toEqual({ type: "scroll", x: 0, y: 120 });
    expect(readBridgeMessage({ source: "other", type: "ready" })).toBeNull();
    expect(readBridgeMessage({ source: "cubiq-design", type: "scroll", x: "1", y: 2 })).toBeNull();
    expect(readBridgeMessage({ source: "cubiq-design", type: "navigate", url: "https://example.com" })).toBeNull();
    expect(readBridgeMessage("ready")).toBeNull();
  });

  it("accepts a selection message, drops invalid elements and defaults a bad lost count", () => {
    const msg = { source: "cubiq-design", type: "selection", elements: [selected], lost: 0 };
    expect(readBridgeMessage(msg)).toEqual({ type: "selection", elements: [selected], lost: 0 });
    expect(readBridgeMessage({ ...msg, elements: [selected, { ...selected, tag: "" }] })).toEqual({ type: "selection", elements: [selected], lost: 0 });
    expect(readBridgeMessage({ ...msg, elements: "x" })).toBeNull();
    expect(readBridgeMessage({ ...msg, lost: -1 })).toEqual({ type: "selection", elements: [selected], lost: 0 });
    expect(readBridgeMessage({ ...msg, lost: 3.5 })).toEqual({ type: "selection", elements: [selected], lost: 0 });
  });

  it("accepts an in-place text edit and a refusal, and rejects bad ones", () => {
    const edit = { source: "cubiq-design", type: "text-edit", id: "cta-buy", before: "Buy now", after: "Start free trial" };
    expect(readBridgeMessage(edit)).toEqual({ type: "text-edit", id: "cta-buy", before: "Buy now", after: "Start free trial" });
    expect(readBridgeMessage({ ...edit, id: "bad id" })).toBeNull();
    expect(readBridgeMessage({ ...edit, after: "x".repeat(2001) })).toBeNull();
    expect(readBridgeMessage({ ...edit, before: 5 })).toBeNull();
    expect(readBridgeMessage({ source: "cubiq-design", type: "edit-refused", reason: "That text has no stable id; ask the agent to change it." })).toEqual({
      type: "edit-refused",
      reason: "That text has no stable id; ask the agent to change it.",
    });
    expect(readBridgeMessage({ source: "cubiq-design", type: "edit-refused", reason: "" })).toBeNull();
  });

  it("accepts a tweaks message but rejects oversized manifests and bad maps", () => {
    const tweaks = { source: "cubiq-design", type: "tweaks", manifest: '{"tweaks":[]}', attrs: { "data-theme": "dusk" }, vars: { "--color-accent": "#3b5bdb" } };
    expect(readBridgeMessage(tweaks)).toEqual({ type: "tweaks", manifest: '{"tweaks":[]}', attrs: { "data-theme": "dusk" }, vars: { "--color-accent": "#3b5bdb" } });
    expect(readBridgeMessage({ ...tweaks, manifest: "x".repeat(8001) })).toBeNull();
    expect(readBridgeMessage({ ...tweaks, attrs: [] })).toBeNull();
    expect(readBridgeMessage({ ...tweaks, vars: null })).toBeNull();
    expect(readBridgeMessage({ ...tweaks, attrs: { "data-theme": 5 } })).toBeNull();
    expect(readBridgeMessage({ ...tweaks, vars: { "--x": "y".repeat(65) } })).toBeNull();
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
