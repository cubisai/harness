import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SAFE_DEFAULTS } from "../src/main/agents/capabilities";
import { DraftControls } from "../src/renderer/src/components/ThreadControls";
import { useStore } from "../src/renderer/src/store";
import type { AgentInfo, SettingsView, StoredEvent, SwitchResult, Thread } from "../src/shared/types";

const agent = (id: string, label: string, defaultModel: string, models: AgentInfo["models"] = []): AgentInfo => ({
  id,
  label,
  models,
  defaultModel,
  capabilities: { ...SAFE_DEFAULTS, seeding: "first-message" },
});

const thread = (over: Partial<Thread> = {}): Thread => ({
  id: "t1",
  projectId: "p",
  agent: "claude",
  title: "Thread",
  sessionId: null,
  bindings: {},
  model: "opus",
  effort: null,
  permissionMode: "ask",
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

const userEvent: StoredEvent = { seq: 1, createdAt: 0, event: { kind: "user", text: "hi" } };

describe("DraftControls", () => {
  it("shows the default agent and its model before a thread exists", () => {
    // Server rendering reads zustand's initial state; seed it, then restore.
    const state = useStore.getInitialState();
    const saved = { agents: state.agents, settings: state.settings, lastAgent: state.lastAgent, draft: state.draft };
    try {
      state.agents = [agent("claude", "Claude", "opus", [{ id: "opus", label: "Opus" }]), agent("codex", "Codex", "gpt", [{ id: "gpt", label: "GPT" }])];
      state.lastAgent = null;
      state.settings = { defaultAgent: "codex", defaultPermissionMode: "ask" } as unknown as SettingsView;
      state.draft = {};
      const html = renderToStaticMarkup(<DraftControls />);
      expect(html).toContain("Codex");
      expect(html).toContain("GPT");
    } finally {
      state.agents = saved.agents;
      state.settings = saved.settings;
      state.lastAgent = saved.lastAgent;
      state.draft = saved.draft;
    }
  });

  it("renders nothing when no agent is installed", () => {
    const state = useStore.getInitialState();
    const saved = state.agents;
    try {
      state.agents = [];
      expect(renderToStaticMarkup(<DraftControls />)).toBe("");
    } finally {
      state.agents = saved;
    }
  });
});

describe("draft picks", () => {
  it("clears model and effort when the draft agent changes", () => {
    useStore.setState({ draft: { agent: "claude", model: "opus", effort: "high" } });
    useStore.getState().setDraft({ agent: "codex" });
    expect(useStore.getState().draft).toEqual({ agent: "codex" });
  });

  it("keeps a model picked together with a new agent (another agent's provider model)", () => {
    useStore.setState({ draft: { agent: "claude", model: "opus", effort: "high" } });
    useStore.getState().setDraft({ agent: "opencode", model: "unskilled-th/fast" });
    expect(useStore.getState().draft).toEqual({ agent: "opencode", model: "unskilled-th/fast" });
  });

  it("keeps the model when the same agent is picked again", () => {
    useStore.setState({ draft: { agent: "claude", model: "opus" } });
    useStore.getState().setDraft({ agent: "claude" });
    expect(useStore.getState().draft).toEqual({ agent: "claude", model: "opus" });
  });
});

describe("openSwitch on an empty thread", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("switches fresh without showing the dialog when the thread has no user events", async () => {
    const fresh: SwitchResult = { ok: true, mode: "fresh", thread: { ...thread(), agent: "codex" } };
    const fakeApi = {
      switchAgent: vi.fn(() => Promise.resolve(fresh)),
      listAgents: vi.fn(() => Promise.resolve([])),
      listEvents: vi.fn(() => Promise.resolve([])),
      updateThread: vi.fn(() => Promise.resolve(thread())),
    };
    vi.stubGlobal("window", { unskilled: fakeApi });
    useStore.setState({
      selectedThreadId: "t1",
      threads: { p: [thread()] },
      events: { t1: [{ seq: 1, createdAt: 0, event: { kind: "assistant-text", text: "hello" } }] },
      pendingSwitch: null,
    });

    useStore.getState().openSwitch("codex");
    await new Promise((r) => setTimeout(r, 0));

    expect(useStore.getState().pendingSwitch).toBeNull();
    expect(fakeApi.switchAgent).toHaveBeenCalledWith("t1", "codex", "fresh");
  });

  it("shows the dialog when the thread has a user message", () => {
    const fakeApi = { switchAgent: vi.fn(() => Promise.resolve({ ok: true })) };
    vi.stubGlobal("window", { unskilled: fakeApi });
    useStore.setState({
      selectedThreadId: "t1",
      threads: { p: [thread()] },
      events: { t1: [{ seq: 1, createdAt: 0, event: { kind: "thinking", text: "..." } }, userEvent] },
      pendingSwitch: null,
    });

    useStore.getState().openSwitch("codex");

    expect(useStore.getState().pendingSwitch).toBe("codex");
    expect(fakeApi.switchAgent).not.toHaveBeenCalled();
  });

  it("shows the dialog when the thread's events aren't loaded yet", () => {
    const fakeApi = { switchAgent: vi.fn(() => Promise.resolve({ ok: true })) };
    vi.stubGlobal("window", { unskilled: fakeApi });
    useStore.setState({ selectedThreadId: "t1", threads: { p: [thread()] }, events: {}, pendingSwitch: null });

    useStore.getState().openSwitch("codex");

    expect(useStore.getState().pendingSwitch).toBe("codex");
    expect(fakeApi.switchAgent).not.toHaveBeenCalled();
  });
});
