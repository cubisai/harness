import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project, Thread } from "../src/shared/types";
import { useStore } from "../src/renderer/src/store";

const project: Project = { id: "p2", path: "/tmp/p2", name: "p2", createdAt: 0 };

const thread = (over: Partial<Thread> = {}): Thread => ({
  id: "t2",
  projectId: "p2",
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

describe("thread for an unknown project", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    useStore.setState({ projects: [], threads: {} });
  });

  it("fetches the project list when a thread arrives for an unknown project", async () => {
    const listProjects = vi.fn(async () => [project]);
    vi.stubGlobal("window", { unskilled: { listProjects } });
    useStore.setState({ projects: [], threads: {} });

    useStore.getState().apply({ type: "thread", thread: thread() });

    await vi.waitFor(() => expect(useStore.getState().projects.map((p) => p.id)).toEqual(["p2"]));
    expect(listProjects).toHaveBeenCalledTimes(1);
    expect(useStore.getState().threads.p2?.map((t) => t.id)).toEqual(["t2"]);
  });

  it("doesn't refetch for a known project", () => {
    const listProjects = vi.fn(async () => [project]);
    vi.stubGlobal("window", { unskilled: { listProjects } });
    useStore.setState({ projects: [project], threads: {} });

    useStore.getState().apply({ type: "thread", thread: thread() });

    expect(listProjects).not.toHaveBeenCalled();
    expect(useStore.getState().threads.p2?.map((t) => t.id)).toEqual(["t2"]);
  });
});
