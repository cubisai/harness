import { beforeEach, describe, expect, it } from "vitest";
import { inboxModel } from "../src/renderer/src/sections";
import { useStore } from "../src/renderer/src/store";
import type { Thread } from "../src/shared/types";

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

const ids = (list: Thread[]) => list.map((t) => t.id);

describe("inboxModel by kind", () => {
  const list = [
    thread("chat", { updatedAt: 5 }),
    thread("old", { updatedAt: 4 }), // no kind: a chat from before Design mode
    thread("design", { kind: "design", updatedAt: 3 }),
    thread("design-pin", { kind: "design", pinned: true }),
    thread("design-arch", { kind: "design", archived: true }),
    thread("chat-arch", { archived: true }),
    thread("design-live", { kind: "design", updatedAt: 9 }),
  ];

  it("lists only the current kind in Pinned, Recent and Archived, but every kind while running", () => {
    const chat = inboxModel(["p"], { p: list }, { running: { "design-live": true }, kind: "chat" });
    expect(ids(chat.running)).toEqual(["design-live"]);
    expect(ids(chat.pinned)).toEqual([]);
    expect(ids(chat.recent)).toEqual(["chat", "old"]);
    expect(ids(chat.archived.p!)).toEqual(["chat-arch"]);

    const design = inboxModel(["p"], { p: list }, { running: {}, kind: "design" });
    expect(ids(design.pinned)).toEqual(["design-pin"]);
    expect(ids(design.recent)).toEqual(["design-live", "design"]);
    expect(ids(design.archived.p!)).toEqual(["design-arch"]);
  });

  it("lists every kind when no kind is given", () => {
    const all = inboxModel(["p"], { p: list }, { running: {} });
    expect(ids(all.recent)).toEqual(["design-live", "chat", "old", "design"]);
  });
});

describe("store mode", () => {
  const created: unknown[] = [];
  beforeEach(() => {
    created.length = 0;
    (globalThis as { window?: unknown }).window = {
      unskilled: new Proxy(
        {},
        {
          get: (_t, name) =>
            name === "createThread"
              ? async (projectId: string, agent: string | undefined, opts: { kind?: string }) => {
                  created.push(opts);
                  return thread("new", { projectId, kind: opts.kind === "design" ? "design" : "chat", updatedAt: 10 });
                }
              : name === "listEvents" || name === "listArtifacts"
                ? async () => []
                : async () => null,
        },
      ),
    };
    useStore.setState({
      selectedProjectId: "p",
      selectedThreadId: "chat",
      threadKind: "chat",
      threads: { p: [thread("chat", { updatedAt: 5 }), thread("d1", { kind: "design", updatedAt: 2 }), thread("d2", { kind: "design", updatedAt: 3 })] },
      events: { chat: [], d1: [], d2: [] },
      artifactFiles: { chat: [], d1: [], d2: [] },
      finished: [],
      draft: {},
    });
  });

  it("switching to Design opens the project's latest design thread, and back to Chat", async () => {
    await useStore.getState().setThreadKind("design");
    expect(useStore.getState()).toMatchObject({ threadKind: "design", selectedThreadId: "d2" });
    await useStore.getState().setThreadKind("chat");
    expect(useStore.getState()).toMatchObject({ threadKind: "chat", selectedThreadId: "chat" });
  });

  it("switching to a kind with no threads leaves nothing selected", async () => {
    useStore.setState({ threads: { p: [thread("chat")] } });
    await useStore.getState().setThreadKind("design");
    expect(useStore.getState()).toMatchObject({ threadKind: "design", selectedThreadId: null });
  });

  it("selecting a thread follows its kind", async () => {
    await useStore.getState().selectThread("d1");
    expect(useStore.getState().threadKind).toBe("design");
    await useStore.getState().selectThread("chat");
    expect(useStore.getState().threadKind).toBe("chat");
  });

  it("a new thread is made in the current mode", async () => {
    await useStore.getState().setThreadKind("design");
    await useStore.getState().newThread(undefined, { worktree: false });
    expect(created).toEqual([{ worktree: false, kind: "design" }]);
    expect(useStore.getState().selectedThreadId).toBe("new");
  });
});
