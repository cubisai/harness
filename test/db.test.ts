import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Store } from "../src/main/db";
import { tempDir } from "./helpers";

describe("Store", () => {
  it("keeps projects, threads, and ordered events", () => {
    const store = new Store(join(tempDir(), "t.db"));
    const p = store.addProject("/tmp/some/project");
    expect(store.addProject("/tmp/some/project").id).toBe(p.id); // idempotent
    expect(p.name).toBe("project");

    const t = store.createThread(p.id, "claude", "claude-opus-5", "ask");
    expect(store.listThreads(p.id).map((x) => x.id)).toEqual([t.id]);

    store.appendEvent(t.id, { kind: "user", text: "hi" });
    store.appendEvent(t.id, { kind: "assistant-text", text: "hello" });
    expect(store.listEvents(t.id).map((e) => [e.seq, e.event.kind])).toEqual([
      [1, "user"],
      [2, "assistant-text"],
    ]);

    const updated = store.updateThread(t.id, { sessionId: "s1", permissionMode: "full" });
    expect(store.getThread(t.id)).toMatchObject({ sessionId: "s1", permissionMode: "full", title: "New thread" });
    expect(updated.updatedAt).toBeGreaterThanOrEqual(t.updatedAt);

    store.deleteThread(t.id);
    expect(store.listThreads(p.id)).toEqual([]);
    expect(store.listEvents(t.id)).toEqual([]);
    store.close();
  });
});

describe("Store migrations", () => {
  it("adds the agent column to a database from before it existed", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const file = join(tempDir(), "old.db");
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE threads (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, session_id TEXT, model TEXT NOT NULL,
        permission_mode TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      INSERT INTO projects VALUES ('p', '/x', 'x', 1);
      INSERT INTO threads VALUES ('t', 'p', 'Old', NULL, 'claude-opus-5', 'ask', 1, 1);`);
    old.close();
    const store = new Store(file);
    expect(store.getThread("t").agent).toBe("claude");
    store.close();
    const again = new Store(file); // idempotent
    expect(again.listThreads("p")).toHaveLength(1);
    again.close();
  });
});
