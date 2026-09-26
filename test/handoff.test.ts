import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Store } from "../src/main/db";
import { exportThread, importThread, THREAD_EXPORT_VERSION } from "../src/main/handoff";
import { closeAfter, tempDir } from "./helpers";

function open(dir = tempDir()): Store {
  const store = new Store(join(dir, "t.db"));
  closeAfter(() => store.close());
  return store;
}

describe("thread export/import", () => {
  it("restores the thread and its ordered events as a new thread", () => {
    const store = open();
    const p = store.addProject("/tmp/p");
    const t = store.createThread(p.id, "codex", "gpt-x", "ask");
    store.updateThread(t.id, { sessionId: "s1", title: "Fix the build" });
    const provenance = { agent: "codex", model: "gpt-x", provider: null, instanceId: null };
    store.appendEvent(t.id, { kind: "user", text: "fix it" });
    store.appendEvent(t.id, { kind: "assistant-text", text: "on it", turnId: "turn-1", itemId: "item-1" }, provenance);
    store.appendEvent(t.id, { kind: "tool-result", toolUseId: "tu", isError: false, summary: "ok", payload: { out: "done" } }, provenance);
    const before = store.listEvents(t.id);

    const exported = JSON.parse(JSON.stringify(exportThread(store, t.id)));
    expect(exported.schemaVersion).toBe(THREAD_EXPORT_VERSION);
    store.deleteThread(t.id);
    const restored = importThread(store, p.id, exported);

    expect(restored.id).not.toBe(t.id);
    expect(restored).toMatchObject({ agent: "codex", title: "Fix the build", model: "gpt-x", permissionMode: "ask", sessionId: "s1" });
    expect(restored.bindings).toEqual(exported.thread.bindings);
    expect(restored.bindings["codex:default"]!.resumeCursor).toBe("s1");
    const after = store.listEvents(restored.id);
    expect(after.map((e) => [e.seq, e.event.kind])).toEqual(before.map((e) => [e.seq, e.event.kind]));
    expect(after.map((e) => e.event)).toEqual(before.map((e) => e.event));
    expect(after.map((e) => e.provenance)).toEqual(before.map((e) => e.provenance));
    expect(after.map((e) => e.createdAt)).toEqual(before.map((e) => e.createdAt));
  });

  it("carries an offloaded tool payload into another data folder", () => {
    const a = open();
    const pa = a.addProject("/tmp/p");
    const t = a.createThread(pa.id, "claude", "m", "ask");
    const payload = { data: "x".repeat(100_000) };
    a.appendEvent(t.id, { kind: "tool-result", toolUseId: "tu", isError: false, summary: "big", payload });
    const file = JSON.parse(JSON.stringify(exportThread(a, t.id)));

    const b = open();
    const pb = b.addProject("/elsewhere/p");
    const restored = importThread(b, pb.id, file);
    const stub = (b.listEvents(restored.id)[0]!.event as { payload: { blobRef: string } }).payload;
    expect(b.readBlob(stub.blobRef)).toBe(JSON.stringify(payload));
  });

  it("refuses an unknown schema version or a corrupted blob without writing anything", () => {
    const store = open();
    const p = store.addProject("/tmp/p");
    const t = store.createThread(p.id, "claude", "m", "ask");
    store.appendEvent(t.id, { kind: "tool-result", toolUseId: "tu", isError: false, summary: "big", payload: { data: "y".repeat(100_000) } });
    const good = JSON.parse(JSON.stringify(exportThread(store, t.id)));

    expect(() => importThread(store, p.id, { ...good, schemaVersion: 2 })).toThrow(/schema version 2/);
    const { schemaVersion: _, ...unversioned } = good;
    expect(() => importThread(store, p.id, unversioned)).toThrow(/schema version/);

    const sha = Object.keys(good.blobs)[0]!;
    expect(sha).toBe(createHash("sha256").update(good.blobs[sha]).digest("hex"));
    expect(() => importThread(store, p.id, { ...good, blobs: { [sha]: "tampered" } })).toThrow(/corrupted/);
    expect(() => importThread(store, p.id, { ...good, blobs: {} })).toThrow(/missing/);
    expect(store.listThreads(p.id).map((x) => x.id)).toEqual([t.id]);
  });

  it("rolls back a half-written import", () => {
    const store = open();
    const p = store.addProject("/tmp/p");
    const t = store.createThread(p.id, "claude", "m", "ask");
    store.appendEvent(t.id, { kind: "user", text: "hi" });
    const data = JSON.parse(JSON.stringify(exportThread(store, t.id)));
    data.events.push({ ...data.events[0] }); // duplicate seq: the second insert fails
    expect(() => importThread(store, p.id, data)).toThrow();
    expect(store.listThreads(p.id).map((x) => x.id)).toEqual([t.id]);
  });
});
