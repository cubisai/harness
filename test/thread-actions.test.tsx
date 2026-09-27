import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Store } from "../src/main/db";
import { ThreadRow } from "../src/renderer/src/components/ThreadRow";
import { archivedThreads, sectionThreads } from "../src/renderer/src/sections";
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
  permissionMode: "ask",
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});

describe("thread pin and archive", () => {
  it("keeps archived threads out of the sections and lists them apart", () => {
    const list = [thread("a", { updatedAt: 3 }), thread("b", { archived: true, updatedAt: 2 }), thread("c", { pinned: true })];
    const sections = sectionThreads(list, { running: {}, now: 5 });
    expect(sections.map((s) => [s.name, s.threads.map((t) => t.id)])).toEqual([
      ["Pinned", ["c"]],
      ["Active", ["a"]],
    ]);
    expect(archivedThreads(list).map((t) => t.id)).toEqual(["b"]);
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
      <ThreadRow thread={thread("x", { title: "Fix login", pinned: true })} agent={undefined} branch={null} selected={false} running={false} onOpen={() => {}} />,
    );
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain("Fix login");
    expect(html).toContain("<svg"); // the pin before the title
  });
});
