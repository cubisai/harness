import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Thread } from "../src/shared/types";

/** A project fixture with the fields the store reads. */
const project = (id: string): Project => ({ id, path: `/tmp/${id}`, name: id, createdAt: 0 });

/** A thread fixture; the highest updatedAt sorts first, as listThreads orders. */
const thread = (id: string, projectId: string, updatedAt: number): Thread => ({
  id,
  projectId,
  agent: "claude",
  title: id,
  sessionId: null,
  bindings: {},
  model: "opus",
  effort: null,
  permissionMode: "ask",
  createdAt: updatedAt,
  updatedAt,
});

describe("init startup", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  it("opens the first project's most recent thread after one all-threads call", async () => {
    const projects = [project("p1"), project("p2")];
    const all: Record<string, Thread[]> = {
      p1: [thread("t2", "p1", 2), thread("t1", "p1", 1)],
      p2: [thread("t3", "p2", 3)],
    };
    // Record the order the startup calls reach the backend.
    const calls: string[] = [];
    const api = {
      onUpdate: vi.fn(() => () => {}),
      listProjects: vi.fn(async () => projects),
      listSkills: vi.fn(async () => []),
      listAgents: vi.fn(async () => []),
      getSettings: vi.fn(async () => ({ theme: "system", defaultAgent: null, defaultPermissionMode: "ask", autoUpdate: false, editor: null, providers: [], providerCredential: {}, migratedProviders: [], secretsEncrypted: false })),
      updateStatus: vi.fn(async () => ({ current: "0.1.0", ready: null, supported: false })),
      listLimits: vi.fn(async () => []),
      pendingState: vi.fn(async () => ({ running: [], permissions: [], plans: [], questions: [] })),
      listEditors: vi.fn(async () => []),
      listAllThreads: vi.fn(async () => {
        calls.push("listAllThreads");
        return all;
      }),
      listThreads: vi.fn(async (id: string) => {
        calls.push(`listThreads:${id}`);
        return all[id] ?? [];
      }),
      projectBranch: vi.fn(async (id: string) => {
        calls.push(`loadBranch:${id}`);
        return "main";
      }),
      listEventsPage: vi.fn(async (id: string) => {
        calls.push(`listEventsPage:${id}`);
        return { events: [], firstSeq: 0, hasMore: false };
      }),
      threadTotals: vi.fn(async () => ({ events: 0, turns: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, costUsd: null, lastSeq: 0 })),
      listArtifacts: vi.fn(async () => []),
      learnScores: vi.fn(async () => []),
    };
    vi.stubGlobal("window", { unskilled: api, dispatchEvent: vi.fn() });
    vi.stubGlobal("document", { documentElement: { dataset: {}, style: { setProperty: vi.fn() } } });
    const { useStore } = await import("../src/renderer/src/store");

    await useStore.getState().init();

    expect(api.listThreads).not.toHaveBeenCalled();
    expect(api.listAllThreads).toHaveBeenCalledTimes(1);
    expect(useStore.getState().selectedProjectId).toBe("p1");
    expect(useStore.getState().selectedThreadId).toBe("t2");
    expect(useStore.getState().threads.p1!.map((t) => t.id)).toEqual(["t2", "t1"]);
    // The selected thread's page is requested before the startup loop's branch loads.
    // (selectProject loads p1's branch itself, so only the loop's calls are checked.)
    const pageAt = calls.indexOf("listEventsPage:t2");
    expect(pageAt).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("loadBranch:p2")).toBeGreaterThan(pageAt);
    expect(calls.lastIndexOf("loadBranch:p1")).toBeGreaterThan(pageAt);
  });
});
