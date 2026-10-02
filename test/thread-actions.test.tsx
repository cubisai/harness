import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Store } from "../src/main/db";
import { ThreadRow } from "../src/renderer/src/components/ThreadRow";
import { inboxModel } from "../src/renderer/src/sections";
import { useStore } from "../src/renderer/src/store";
import type { Thread } from "../src/shared/types";
import { closeAfter, tempDir } from "./helpers";

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

describe("thread pin and archive", () => {
  it("keeps archived threads out of the sections and lists them apart", () => {
    const list = [thread("a", { updatedAt: 3 }), thread("b", { archived: true, updatedAt: 2 }), thread("c", { pinned: true })];
    const m = inboxModel(["p"], { p: list }, { running: {} });
    expect(m.pinned.map((t) => t.id)).toEqual(["c"]);
    expect(m.recent.map((t) => t.id)).toEqual(["a"]);
    expect(m.archived.p!.map((t) => t.id)).toEqual(["b"]);
  });

  it("stores pinned and archived, and neither counts as activity", () => {
    const store = new Store(join(tempDir(), "t.db"));
    closeAfter(() => store.close());
    const p = store.addProject(tempDir());
    const t = store.createThread(p.id, "claude", "opus", "ask");
    const before = store.getThread(t.id).updatedAt;
    store.updateThread(t.id, { pinned: true });
    store.updateThread(t.id, { archived: true, title: "Renamed" });
    const after = store.getThread(t.id);
    expect(after).toMatchObject({ pinned: true, archived: true, title: "Renamed", updatedAt: before });
  });
});

describe("store thread actions", () => {
  (globalThis as { window?: unknown }).window ??= { unskilled: new Proxy({}, { get: () => async () => null }) };

  it("deletes a thread from its project, its events and the selection", async () => {
    useStore.setState({ threads: { p: [thread("a"), thread("b")] }, events: { a: [], b: [] }, selectedThreadId: "a", finished: [] });
    await useStore.getState().deleteThread("a");
    const s = useStore.getState();
    expect(s.threads.p!.map((t) => t.id)).toEqual(["b"]);
    expect(s.events.a).toBeUndefined();
    expect(s.selectedThreadId).toBeNull();
  });
});

describe("ThreadRow", () => {
  it("offers its actions from a ⋯ menu button and shows a pin", () => {
    const html = renderToStaticMarkup(
      <ThreadRow thread={thread("x", { title: "Fix login", pinned: true })} agent={undefined} branch={null} selected={false} status={null} time="3h" onOpen={() => {}} />,
    );
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain("Fix login");
    expect(html).toContain('title="Archive"');
    expect(html).toContain("3h");
    expect(html).toContain("<svg"); // the pin before the title
  });

  it("labels its status dot and shows a sub-line", () => {
    const html = renderToStaticMarkup(
      <ThreadRow thread={thread("x")} agent={undefined} branch={null} selected status="waiting" time="12s" sub={<span className="need">Needs approval</span>} onOpen={() => {}} />,
    );
    expect(html).toContain('aria-label="Needs approval"');
    expect(html).toContain('class="thread-dot waiting"');
    expect(html).toContain("thread-sub");
  });
});
