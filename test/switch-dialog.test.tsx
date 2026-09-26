import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SAFE_DEFAULTS } from "../src/main/agents/capabilities";
import type { AgentCapabilities, AgentInfo, StoredEvent, SwitchResult, Thread } from "../src/shared/types";
import { SwitchDialog, switchCounts } from "../src/renderer/src/components/SwitchDialog";

const agent = (id: string, label: string, caps: Partial<AgentCapabilities> = {}): AgentInfo => ({
  id,
  label,
  models: [],
  defaultModel: "",
  capabilities: { ...SAFE_DEFAULTS, ...caps },
});

const codex = agent("codex", "Codex", { seeding: "inject-items" });
const claude = agent("claude", "Claude", { seeding: "first-message" });

const props = (over: Partial<Parameters<typeof SwitchDialog>[0]> = {}) => ({
  from: codex,
  to: claude,
  counts: { messages: 4, commands: 2 },
  canGoBack: false,
  busy: false,
  error: null,
  onHandoff: () => {},
  onFresh: () => {},
  onBack: () => {},
  onCancel: () => {},
  ...over,
});

describe("SwitchDialog", () => {
  it("names the target and what a handoff keeps and leaves behind", () => {
    const html = renderToStaticMarkup(<SwitchDialog {...props()} />);
    expect(html).toContain("Switch to Claude");
    expect(html).toContain("4 messages");
    expect(html).toContain("2 command results");
    expect(html).toContain("Carries over");
    expect(html).toContain("Does not carry over");
    expect(html).toContain("Reasoning");
    expect(html).toContain("prompt cache");
  });

  it("offers the kept session only when the target can resume", () => {
    expect(renderToStaticMarkup(<SwitchDialog {...props({ canGoBack: true })} />)).toContain("Switch back to Claude");
    expect(renderToStaticMarkup(<SwitchDialog {...props({ canGoBack: false })} />)).not.toContain("Switch back to Claude");
  });

  it("disables Hand off when the target can't receive a handoff", () => {
    const html = renderToStaticMarkup(<SwitchDialog {...props({ to: agent("claude", "Claude", { seeding: "none" }) })} />);
    expect(html).toContain("no way to receive a handoff");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Hand off<\/button>/);
  });
});

describe("switchCounts", () => {
  it("counts messages and command results", () => {
    const events: StoredEvent[] = [
      { seq: 1, createdAt: 0, event: { kind: "user", text: "hi" } },
      { seq: 2, createdAt: 0, event: { kind: "assistant-text", text: "hello" } },
      { seq: 3, createdAt: 0, event: { kind: "thinking", text: "..." } },
      { seq: 4, createdAt: 0, event: { kind: "tool-use", toolUseId: "x", name: "Bash", summary: "ls" } },
    ];
    expect(switchCounts(events)).toEqual({ messages: 2, commands: 1 });
  });
});

describe("store switchAgent", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("goes back through updateThread and switches fresh through the API", async () => {
    const thread: Thread = {
      id: "t1",
      projectId: "p",
      agent: "claude",
      title: "Thread",
      sessionId: null,
      bindings: {},
      model: "m",
      permissionMode: "ask",
      createdAt: 0,
      updatedAt: 0,
    };
    const fresh: SwitchResult = { ok: true, mode: "fresh", thread: { ...thread, agent: "codex" } };
    const fakeApi = {
      updateThread: vi.fn(() => Promise.resolve(thread)),
      switchAgent: vi.fn(() => Promise.resolve(fresh)),
      listAgents: vi.fn(() => Promise.resolve([])),
      listEvents: vi.fn(() => Promise.resolve([])),
    };
    vi.stubGlobal("window", { unskilled: fakeApi });
    const { useStore } = await import("../src/renderer/src/store");
    useStore.setState({ selectedThreadId: "t1", threads: { p: [thread] } });

    expect(await useStore.getState().switchAgent("codex", "back")).toBeNull();
    expect(fakeApi.updateThread).toHaveBeenCalledWith("t1", { agent: "codex" });
    expect(fakeApi.switchAgent).not.toHaveBeenCalled();

    expect(await useStore.getState().switchAgent("codex", "fresh")).toBeNull();
    expect(fakeApi.switchAgent).toHaveBeenCalledWith("t1", "codex", "fresh");
  });
});