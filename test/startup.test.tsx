import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveUpdate, PendingState, Project, SkillEntry, Thread } from "../src/shared/types";
import { deferred } from "./helpers";

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

/** The backend calls init makes, recording the order the thread and branch loads arrive in. */
function fakeApi(projects: Project[], all: Record<string, Thread[]>, calls: string[], agents: { id: string }[] = []) {
return {
    onUpdate: vi.fn(() => () => {}),
    listProjects: vi.fn(async () => projects),
    listSkills: vi.fn(async () => []),
    listAgents: vi.fn(async () => agents),
    getSettings: vi.fn(async () => ({ theme: "system", defaultAgent: null, defaultPermissionMode: "ask", autoUpdate: false, editor: null, providers: [], providerCredential: {}, migratedProviders: [], secretsEncrypted: false })),
    updateStatus: vi.fn(async () => ({ current: "0.1.0", ready: null, notes: null, supported: false })),
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
}

describe("init startup", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  it("keeps the newest project's skills through A → B → A with reversed replies", async () => {
    const oldA = deferred<SkillEntry[]>(), b = deferred<SkillEntry[]>(), newA = deferred<SkillEntry[]>();
    const listSkills = vi.fn().mockReturnValueOnce(oldA.promise).mockReturnValueOnce(b.promise).mockReturnValueOnce(newA.promise);
    vi.stubGlobal("window", { unskilled: { listSkills, projectBranch: async () => null } });
    const { useStore } = await import("../src/renderer/src/store");
    useStore.setState({ threads: { a: [], b: [] } });
    for (const id of ["a", "b", "a"]) await useStore.getState().selectProject(id);
    const skill: SkillEntry = { name: "current", description: "", invocation: "model", sha256: "current", files: [], calls: [] };
    for (const [reply, name] of [[newA, "current"], [b, "other"], [oldA, "obsolete"]] as const) {
      reply.resolve([{ ...skill, name }]);
      await reply.promise;
      expect(useStore.getState().skills).toEqual([skill]);
    }
    expect(listSkills.mock.calls).toEqual([["a"], ["b"], ["a"]]);
  });

  it("replays only newer card and queue transitions over a delayed snapshot", async () => {
    const snapshot = deferred<PendingState>();
    let push!: (update: LiveUpdate) => void;
    const api = { ...fakeApi([], {}, []), pendingState: () => snapshot.promise, onUpdate: (listener: typeof push) => { push = listener; } };
    vi.stubGlobal("window", { unskilled: api, dispatchEvent: vi.fn() });
    vi.stubGlobal("document", { documentElement: { dataset: {}, style: { setProperty: vi.fn() } } });
    const { useStore } = await import("../src/renderer/src/store");
    const init = useStore.getState().init();
    const permission = { threadId: "a", requestId: "withdrawn", toolName: "Edit", summary: "before", canAlwaysAllow: false };
    const question = { threadId: "a", requestId: "new", questions: [] };
    push({ type: "question", request: { ...question, requestId: "already-gone" }, pendingSequence: 1 });
    push({ type: "permission-withdrawn", requestId: permission.requestId, pendingSequence: 4 });
    push({ type: "question", request: question, pendingSequence: 5 });
    push({ type: "queued", threadId: "c", queued: true, pendingSequence: 6 });
    snapshot.resolve({ sequence: 3, running: ["a"], queued: ["b"], permissions: [permission], questions: [], plans: [] });
    await init;
    push({ type: "permission", request: permission, pendingSequence: 3 });
    expect(useStore.getState()).toMatchObject({ initError: null, running: { a: true, b: true, c: true }, queued: { b: true, c: true }, permissions: [], questions: [question] });
  });

  it("opens the first project's most recent thread after one all-threads call", async () => {
    const projects = [project("p1"), project("p2")];
    const all: Record<string, Thread[]> = {
      p1: [thread("t2", "p1", 2), thread("t1", "p1", 1)],
      p2: [thread("t3", "p2", 3)],
    };
    // Record the order the startup calls reach the backend.
    const calls: string[] = [];
    const api = fakeApi(projects, all, calls);
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

  it("reopens the last project, thread and new-thread picks, and saves the next selection", async () => {
    const projects = [project("p1"), project("p2")];
    const all: Record<string, Thread[]> = { p1: [thread("t1", "p1", 1)], p2: [thread("t3", "p2", 3), thread("t2", "p2", 2)] };
    const api = fakeApi(projects, all, [], [{ id: "claude" }, { id: "codex" }]);
    const saved = { projectId: "p2", threadId: "t2", lastAgent: "codex", draft: { agent: "codex", model: "gpt-6-luna", effort: "medium" } };
    const storage = new Map([["cubiq.session", JSON.stringify(saved)]]);
    vi.stubGlobal("localStorage", { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v) });
    vi.stubGlobal("window", { unskilled: api, dispatchEvent: vi.fn() });
    vi.stubGlobal("document", { documentElement: { dataset: {}, style: { setProperty: vi.fn() } } });
    const { useStore } = await import("../src/renderer/src/store");

    await useStore.getState().init();

    const s = useStore.getState();
    expect(s.selectedProjectId).toBe("p2");
    expect(s.selectedThreadId).toBe("t2");
    expect(s.lastAgent).toBe("codex");
    expect(s.draft).toEqual({ agent: "codex", model: "gpt-6-luna", effort: "medium" });
    await s.selectThread("t3");
    expect(JSON.parse(storage.get("cubiq.session")!)).toMatchObject({ projectId: "p2", threadId: "t3", lastAgent: "codex" });
  });
});
