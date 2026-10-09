import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { escapeStopsTurn, type EscapeTarget } from "../src/renderer/src/escape";
import type { PlanRequest, PermissionRequest, QuestionRequest, Thread } from "../src/shared/types";

/** A thread fixture with just the fields the actions here read. */
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

/** A fake window.unskilled with resolving stubs; `over` replaces the ones a test needs to reject. */
const fakeApi = (over: Record<string, unknown> = {}) => ({
  send: vi.fn(() => Promise.resolve()),
  updateThread: vi.fn(() => Promise.resolve(thread("t1"))),
  deleteThread: vi.fn(() => Promise.resolve()),
  respondPermission: vi.fn(() => Promise.resolve()),
  respondPlan: vi.fn(() => Promise.resolve()),
  respondQuestion: vi.fn(() => Promise.resolve()),
  ...over,
});

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("store reliability (D1)", () => {
  it("send clears the spinner and reports a rejected IPC call", async () => {
    vi.stubGlobal("window", { unskilled: fakeApi({ send: vi.fn(() => Promise.reject(new Error("Error invoking remote method 'send': Error: boom"))) }) });
    const { useStore } = await import("../src/renderer/src/store");
    useStore.setState({ selectedThreadId: "t1", running: {} });

    const ok = await useStore.getState().send("hello");

    expect(ok).toBe(false);
    expect(useStore.getState().running.t1).toBe(false);
    expect(useStore.getState().notice).toBe("Couldn't send: boom");
  });

  it("send returns true and keeps the spinner while the turn runs", async () => {
    const send = vi.fn(() => Promise.resolve());
    vi.stubGlobal("window", { unskilled: fakeApi({ send }) });
    const { useStore } = await import("../src/renderer/src/store");
    useStore.setState({ selectedThreadId: "t1", running: {} });

    const ok = await useStore.getState().send("hello");

    expect(ok).toBe(true);
    expect(useStore.getState().running.t1).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("send returns false without calling the API when there is no thread", async () => {
    const send = vi.fn(() => Promise.resolve());
    vi.stubGlobal("window", { unskilled: fakeApi({ send }) });
    const { useStore } = await import("../src/renderer/src/store");
    useStore.setState({ selectedThreadId: null, running: {} });

    expect(await useStore.getState().send("hello")).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("compact clears the spinner and reports a rejected IPC call", async () => {
    vi.stubGlobal("window", { unskilled: fakeApi({ send: vi.fn(() => Promise.reject(new Error("boom"))) }) });
    const { useStore } = await import("../src/renderer/src/store");
    useStore.setState({ running: {} });

    await useStore.getState().compact("t1", null);

    expect(useStore.getState().running.t1).toBe(false);
    expect(useStore.getState().notice).toMatch(/^Couldn't compact/);
  });
});

describe("store reliability (D2)", () => {
  it("thread actions surface IPC failures without throwing", async () => {
    const nope = () => Promise.reject(new Error("Error invoking remote method 'updateThread': Error: nope"));
    vi.stubGlobal("window", { unskilled: fakeApi({ updateThread: vi.fn(nope), deleteThread: vi.fn(() => Promise.reject(new Error("Error invoking remote method 'deleteThread': Error: gone"))) }) });
    const { useStore } = await import("../src/renderer/src/store");
    useStore.setState({ threads: { p: [thread("t1")] }, events: { t1: [] }, selectedThreadId: "t1" });

    await useStore.getState().togglePin("t1");
    expect(useStore.getState().notice).toBe("Couldn't pin the thread: nope");

    await useStore.getState().renameThread("t1", "New name");
    expect(useStore.getState().notice).toBe("Couldn't rename the thread: nope");

    await useStore.getState().setArchived("t1", true);
    expect(useStore.getState().notice).toBe("Couldn't archive the thread: nope");
    // A failed archive must not deselect the thread.
    expect(useStore.getState().selectedThreadId).toBe("t1");

    await useStore.getState().deleteThread("t1");
    expect(useStore.getState().notice).toBe("Couldn't delete the thread: gone");
    expect(useStore.getState().threads.p!.map((t) => t.id)).toEqual(["t1"]);
    expect(useStore.getState().events.t1).toEqual([]);
  });

  it("answer actions restore the card and report a rejected IPC call", async () => {
    const fail = () => Promise.reject(new Error("Error invoking remote method 'respond': Error: no answer"));
    vi.stubGlobal("window", { unskilled: fakeApi({ respondPermission: vi.fn(fail), respondPlan: vi.fn(fail), respondQuestion: vi.fn(fail) }) });
    const { useStore } = await import("../src/renderer/src/store");
    const permission: PermissionRequest = { requestId: "r1", threadId: "t1", toolName: "Bash", summary: "run", canAlwaysAllow: true };
    const plan: PlanRequest = { requestId: "r2", threadId: "t1", plan: "do it" };
    const question: QuestionRequest = { requestId: "r3", threadId: "t1", questions: [] };
    useStore.setState({ permissions: [permission], plans: [plan], questions: [question] });

    await useStore.getState().respond("r1", "deny");
    expect(useStore.getState().permissions).toEqual([permission]);

    await useStore.getState().respondPlan("r2", "auto");
    expect(useStore.getState().plans).toEqual([plan]);

    await useStore.getState().respondQuestion("r3", "dismiss");
    expect(useStore.getState().questions).toEqual([question]);

    expect(useStore.getState().notice).toBe("Couldn't send your answer: no answer");
  });
});

describe("store reliability (D7)", () => {
  it("init shows a startup error, retries cleanly, and subscribes once", async () => {
    let fail = true;
    const onUpdate = vi.fn(() => () => {});
    const fake = {
      onUpdate,
      listProjects: vi.fn(() => (fail ? Promise.reject(new Error("Error invoking remote method 'listProjects': Error: database is locked")) : Promise.resolve([]))),
      listSkills: vi.fn(() => Promise.resolve([])),
      listAgents: vi.fn(() => Promise.resolve([])),
      getSettings: vi.fn(() =>
        Promise.resolve({
          theme: "system",
          defaultAgent: null,
          defaultPermissionMode: "ask",
          autoUpdate: false,
          editor: null,
          providers: [],
          providerCredential: {},
          migratedProviders: [],
          secretsEncrypted: false,
        }),
      ),
      updateStatus: vi.fn(() => Promise.resolve({ current: "0.1.0", ready: null, supported: false })),
      listLimits: vi.fn(() => Promise.resolve([])),
      pendingState: vi.fn(() => Promise.resolve({ running: [], permissions: [], plans: [], questions: [] })),
      listEditors: vi.fn(() => Promise.resolve([])),
    };
    vi.stubGlobal("window", { unskilled: fake, dispatchEvent: vi.fn() });
    vi.stubGlobal("document", { documentElement: { dataset: {}, style: { setProperty: vi.fn() } } });
    const { useStore } = await import("../src/renderer/src/store");

    await useStore.getState().init();
    expect(useStore.getState().initError).toBe("database is locked");

    fail = false;
    await useStore.getState().init();
    expect(useStore.getState().initError).toBeNull();
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });
});

describe("escapeStopsTurn (D3)", () => {
  /** An event target whose closest() hits `inside`, or matches nothing when omitted. */
  const near = (tagName?: string, isContentEditable?: boolean, inside?: string): EscapeTarget => ({
    tagName,
    isContentEditable,
    closest: (selector: string) => (inside && selector.includes(inside) ? {} : null),
  });
  const press = (target: EscapeTarget | null, over: Partial<{ key: string; defaultPrevented: boolean }> = {}) => ({ key: "Escape", defaultPrevented: false, target, ...over });

  it("stops the turn from a plain, non-editable, non-terminal target", () => {
    expect(escapeStopsTurn(press(near("BODY")), true, false)).toBe(true);
    expect(escapeStopsTurn(press(near("BUTTON")), true, false)).toBe(true);
    expect(escapeStopsTurn(press(null), true, false)).toBe(true);
  });

  it("allows the composer's own field but not a terminal or a field outside it", () => {
    expect(escapeStopsTurn(press(near("TEXTAREA", false, "composer-wrap")), true, false)).toBe(true);
    expect(escapeStopsTurn(press(near("DIV", true, "composer-wrap")), true, false)).toBe(true);
    expect(escapeStopsTurn(press(near("TEXTAREA", false, "xterm")), true, false)).toBe(false);
    expect(escapeStopsTurn(press(near("INPUT")), true, false)).toBe(false);
    expect(escapeStopsTurn(press(near("TEXTAREA")), true, false)).toBe(false);
  });

  it("leaves Escape to an open overlay, and only stops while a turn runs", () => {
    expect(escapeStopsTurn(press(near("BODY")), true, true)).toBe(false);
    expect(escapeStopsTurn(press(near("BODY")), false, false)).toBe(false);
    expect(escapeStopsTurn(press(near("BODY"), { defaultPrevented: true }), true, false)).toBe(false);
    expect(escapeStopsTurn(press(near("BODY"), { key: "a" }), true, false)).toBe(false);
  });
});
