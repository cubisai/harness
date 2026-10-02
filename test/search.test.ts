import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Store } from "../src/main/db";
import { tempDir } from "./helpers";

describe("Store.search", () => {
  it("finds a title hit and a message hit, marking the match", () => {
    const store = new Store(join(tempDir(), "search.db"));
    const p = store.addProject("/tmp/p");
    const t = store.createThread(p.id, "claude", "m", "ask");
    store.updateThread(t.id, { title: "Fix the login limiter" });
    store.appendEvent(t.id, { kind: "user", text: "the ratelimiter is broken" });

    const title = store.search({ text: "login" });
    expect(title.threads).toHaveLength(1);
    expect(title.threads[0]).toMatchObject({ threadId: t.id, projectId: p.id, title: "Fix the login limiter", kind: "title", seq: null });
    expect(title.threads[0]!.snippet).toContain("\u0001");
    expect(title.threads[0]!.snippet).toContain("\u0002");

    const message = store.search({ text: "broken" });
    expect(message.messages).toHaveLength(1);
    expect(message.messages[0]).toMatchObject({ threadId: t.id, kind: "user", seq: 1 });
    expect(message.messages[0]!.snippet).toContain("\u0001");
    expect(message.messages[0]!.snippet).toContain("\u0002");
    store.close();
  });

  it("matches prefixes and requires every word", () => {
    const store = new Store(join(tempDir(), "search.db"));
    const p = store.addProject("/tmp/p");
    const t = store.createThread(p.id, "claude", "m", "ask");
    store.appendEvent(t.id, { kind: "user", text: "setup the ratelimit guard" });
    store.appendEvent(t.id, { kind: "user", text: "rate the limiter" });

    expect(store.search({ text: "rate" }).messages).toHaveLength(2);
    const both = store.search({ text: "ratelimit guard" });
    expect(both.messages).toHaveLength(1);
    expect(both.messages[0]!.snippet).toContain("ratelimit");
    expect(store.search({ text: "ratelimit missing" }).messages).toHaveLength(0);
    store.close();
  });

  it("excludes archived threads", () => {
    const store = new Store(join(tempDir(), "search.db"));
    const p = store.addProject("/tmp/p");
    const t = store.createThread(p.id, "claude", "m", "ask");
    store.appendEvent(t.id, { kind: "user", text: "archivable" });
    expect(store.search({ text: "archivable" }).messages).toHaveLength(1);

    store.updateThread(t.id, { archived: true });
    expect(store.search({ text: "archivable" }).messages).toHaveLength(0);
    expect(store.search({ text: "New thread" }).threads).toHaveLength(0);
    store.close();
  });

  it("filters by project and agent", () => {
    const store = new Store(join(tempDir(), "search.db"));
    const p1 = store.addProject("/tmp/p1");
    const p2 = store.addProject("/tmp/p2");
    const claude = store.createThread(p1.id, "claude", "m", "ask");
    const codex = store.createThread(p1.id, "codex", "m", "ask");
    const other = store.createThread(p2.id, "claude", "m", "ask");
    store.appendEvent(claude.id, { kind: "user", text: "shared token word" });
    store.appendEvent(codex.id, { kind: "user", text: "shared token word" });
    store.appendEvent(other.id, { kind: "user", text: "shared token word" });

    expect(store.search({ text: "token", projectId: p1.id }).messages.map((h) => h.threadId).sort()).toEqual([claude.id, codex.id].sort());
    expect(store.search({ text: "token", agent: "codex" }).messages.map((h) => h.threadId)).toEqual([codex.id]);
    expect(store.search({ text: "token", agent: "codex", projectId: p2.id }).messages).toEqual([]);
    store.close();
  });

  it("reflects renames and deletions", () => {
    const store = new Store(join(tempDir(), "search.db"));
    const p = store.addProject("/tmp/p");
    const t = store.createThread(p.id, "claude", "m", "ask");
    store.updateThread(t.id, { title: "Alpha title" });
    expect(store.search({ text: "Alpha" }).threads).toHaveLength(1);

    store.updateThread(t.id, { title: "Renamed thing" });
    expect(store.search({ text: "Alpha" }).threads).toHaveLength(0);
    expect(store.search({ text: "Renamed" }).threads).toHaveLength(1);

    store.appendEvent(t.id, { kind: "assistant-text", text: "deletable answer" });
    expect(store.search({ text: "deletable" }).messages).toHaveLength(1);
    store.deleteThread(t.id);
    expect(store.search({ text: "deletable" }).messages).toHaveLength(0);
    expect(store.search({ text: "Renamed" }).threads).toHaveLength(0);
    store.close();
  });

  it("treats punctuation-only queries as empty and never throws on bad syntax", () => {
    const store = new Store(join(tempDir(), "search.db"));
    const p = store.addProject("/tmp/p");
    const t = store.createThread(p.id, "claude", "m", "ask");
    store.appendEvent(t.id, { kind: "user", text: "something to find" });

    expect(store.search({ text: '"' })).toEqual({ threads: [], messages: [] });
    expect(store.search({ text: "   " })).toEqual({ threads: [], messages: [] });
    expect(() => store.search({ text: "foo AND (" })).not.toThrow();
    store.close();
  });
});
