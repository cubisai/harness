import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project, Thread } from "../src/shared/types";
import { Sidebar } from "../src/renderer/src/components/Sidebar";
import { useStore } from "../src/renderer/src/store";

const CHATS: Project = { id: "chats", path: "/data/chats", name: "Chats", createdAt: 0, builtin: true };
const APP: Project = { id: "p1", path: "/code/app", name: "app", createdAt: 0 };
const chat = { id: "c1", projectId: "chats", agent: "claude", title: "c1", kind: "chat", worktreePath: "/data/chats/c1", branch: null, updatedAt: 1 } as unknown as Thread;

/** Server rendering reads zustand's initial state: seed it, render, then restore. */
function render(patch: Partial<ReturnType<typeof useStore.getState>>): string {
  const state = useStore.getInitialState() as unknown as Record<string, unknown>;
  const saved = Object.fromEntries(Object.keys(patch).map((k) => [k, state[k]]));
  Object.assign(state, patch);
  try {
    return renderToStaticMarkup(<Sidebar />);
  } finally {
    Object.assign(state, saved);
  }
}

describe("Chats in the sidebar", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("offers New chat in Chat mode, lists Chats first, and gives it no folder menu", () => {
    vi.stubGlobal("window", { unskilled: { platform: "darwin" } });
    const html = render({ projects: [APP, CHATS], threads: { p1: [], chats: [chat] }, threadKind: "chat" });
    expect(html).toContain("New chat");
    expect(html.indexOf(">Chats<")).toBeGreaterThan(-1);
    expect(html.indexOf(">Chats<")).toBeLessThan(html.indexOf(">app<"));
    // One ⋯ menu: the real project's, not Chats'.
    expect(html.match(/title="Project options"/g)).toHaveLength(1);
    expect(html).toContain("Chats with no project folder");
  });

  it("hides New chat in Design mode", () => {
    vi.stubGlobal("window", { unskilled: { platform: "darwin" } });
    expect(render({ projects: [APP], threads: { p1: [] }, threadKind: "design" })).not.toContain("New chat");
  });
});

describe("flat Recent view", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("starts each project folded in the Projects list, so Recent's threads aren't listed twice", () => {
    vi.stubGlobal("window", { unskilled: { platform: "darwin" } });
    const t = { ...chat, id: "t1", projectId: "p1", title: "fix the parser", worktreePath: "/code/app" } as Thread;
    const html = render({ projects: [APP], threads: { p1: [t] }, threadKind: "chat", settings: { sidebarGroupByProject: false } as never });
    expect(html).toContain(">Projects<");
    expect(html.match(/class="thread-row"/g)).toHaveLength(1);
  });
});

describe("newChat", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    useStore.setState(useStore.getInitialState(), true);
  });

  it("opens Chats (made on first use) and starts a chat there, in Chat mode", async () => {
    const created = { ...chat, id: "c2", worktreePath: "/data/chats/c2" };
    const api = {
      openChats: vi.fn(async () => CHATS),
      createThread: vi.fn(async () => created),
      updateThread: vi.fn(async () => created),
      projectBranch: vi.fn(async () => null),
      listSkills: vi.fn(async () => []),
      listThreads: vi.fn(async () => []),
      listEventsPage: vi.fn(async () => ({ events: [], firstSeq: 0, hasMore: false })),
      threadTotals: vi.fn(async () => null),
      listArtifacts: vi.fn(async () => []),
      learnScores: vi.fn(async () => []),
    };
    vi.stubGlobal("window", { unskilled: api, dispatchEvent: vi.fn() });
    useStore.setState({ projects: [APP], threads: { p1: [] }, selectedProjectId: "p1", threadKind: "design" });

    const id = await useStore.getState().newChat();

    const s = useStore.getState();
    expect(id).toBe("c2");
    expect(s.projects.map((p) => p.id)).toEqual(["p1", "chats"]);
    expect(s.selectedProjectId).toBe("chats");
    expect(s.selectedThreadId).toBe("c2");
    expect(s.threadKind).toBe("chat");
    expect(api.createThread).toHaveBeenCalledWith("chats", undefined, { kind: "chat" });
  });

  it("says so when Chats can't be opened", async () => {
    vi.stubGlobal("window", { unskilled: { openChats: vi.fn(async () => Promise.reject(new Error("disk full"))) } });
    expect(await useStore.getState().newChat()).toBeNull();
    expect(useStore.getState().notice).toContain("Couldn't start a chat");
  });
});
