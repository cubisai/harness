import { afterEach, describe, expect, it, vi } from "vitest";
import { readSession, restoreDraft, restoreTarget, type SavedSession } from "../src/renderer/src/session";

const session = (extra: Partial<SavedSession> = {}): SavedSession => ({
  projectId: "p2",
  threadId: "t2",
  lastAgent: "codex",
  draft: {},
  ...extra,
});
const projects = [{ id: "p1" }, { id: "p2" }];
const threads = { p1: [{ id: "t1" }], p2: [{ id: "t3" }, { id: "t2" }] };

describe("session restore", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("readSession drops malformed fields and survives bad JSON", () => {
    const raw = {
      projectId: 5,
      threadId: "t1",
      lastAgent: "",
      draft: { agent: "codex", model: 3, permissionMode: "yolo", effort: null },
    };
    vi.stubGlobal("localStorage", { getItem: () => JSON.stringify(raw) });
    expect(readSession()).toEqual({
      projectId: null,
      threadId: "t1",
      lastAgent: null,
      draft: { agent: "codex", effort: null },
    });
    vi.stubGlobal("localStorage", { getItem: () => "{nope" });
    expect(readSession()).toBeNull();
  });

  it("restoreTarget reopens the saved project and thread", () => {
    expect(restoreTarget(session(), projects, threads)).toEqual({
      projectId: "p2",
      threadId: "t2",
    });
  });

  it("restoreTarget keeps a saved start page", () => {
    expect(restoreTarget(session({ threadId: null }), projects, threads)).toEqual({ projectId: "p2", threadId: null });
  });

  it("restoreTarget falls back to the project's newest thread when the saved one is gone", () => {
    expect(restoreTarget(session({ threadId: "gone" }), projects, threads)).toEqual({ projectId: "p2", threadId: "t3" });
  });

  it("restoreTarget opens the first project's newest thread without a usable session, as before", () => {
    expect(restoreTarget(null, projects, threads)).toEqual({
      projectId: "p1",
      threadId: "t1",
    });
    expect(restoreTarget(session({ projectId: "gone" }), projects, threads)).toEqual({ projectId: "p1", threadId: "t1" });
    expect(restoreTarget(null, [], {})).toBeNull();
  });

  it("restoreDraft keeps picks whose agent is still installed", () => {
    const draft = { agent: "codex", model: "gpt-6-luna" };
    expect(restoreDraft(session({ draft }), [{ id: "claude" }, { id: "codex" }])).toEqual({ draft, lastAgent: "codex" });
  });

  it("restoreDraft drops another agent's model when that agent is gone, keeping the permission mode", () => {
    const saved = session({
      lastAgent: "codex",
      draft: { model: "gpt-6-luna", permissionMode: "plan" },
    });
    expect(restoreDraft(saved, [{ id: "claude" }])).toEqual({
      draft: { permissionMode: "plan" },
      lastAgent: null,
    });
  });
});
