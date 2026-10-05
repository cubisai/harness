import { createHash } from "node:crypto";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { Store } from "../src/main/db";
import { closeAfter, tempDir } from "./helpers";

describe("Store", () => {
  it("keeps projects, threads, and ordered events", () => {
    const store = new Store(join(tempDir(), "t.db"));
    const p = store.addProject("/tmp/some/project");
    expect(store.addProject("/tmp/some/project").id).toBe(p.id); // idempotent
    expect(p.name).toBe("project");

    const t = store.createThread(p.id, "claude", "claude-opus-5", "ask");
    expect(t.effort).toBeNull();
    expect(store.updateThread(t.id, { effort: "high" }).effort).toBe("high");
    expect(store.getThread(t.id).effort).toBe("high");
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

    const p2 = store.addProject("/tmp/some/other-project");
    const t2 = store.createThread(p2.id, "claude", "claude-opus-5", "ask");
    store.appendEvent(t2.id, { kind: "user", text: "test" });
    expect(store.listProjects().map((x) => x.id)).toContain(p2.id);
    expect(store.listThreads(p2.id)).toHaveLength(1);
    store.deleteProject(p2.id);
    expect(store.listProjects().map((x) => x.id)).not.toContain(p2.id);
    expect(store.listThreads(p2.id)).toEqual([]);
    expect(store.listEvents(t2.id)).toEqual([]);

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

  it("upgrades a pre-Phase-0 event log and is idempotent", () => {
    const file = join(tempDir(), "pre.db");
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE threads (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, agent TEXT NOT NULL DEFAULT 'claude', title TEXT NOT NULL,
        session_id TEXT, model TEXT NOT NULL, permission_mode TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version VALUES (1);
      CREATE TABLE events (thread_id TEXT NOT NULL, seq INTEGER NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY (thread_id, seq));
      INSERT INTO projects VALUES ('p', '/x', 'x', 1);
      INSERT INTO threads VALUES ('t', 'p', 'claude', 'Old', NULL, 'claude-opus-5', 'ask', 1, 1);
      INSERT INTO events VALUES ('t', 1, '{"kind":"user","text":"old"}', 123);
    `);
    old.close();

    const store = new Store(file);
    const events = store.listEvents("t");
    expect(events).toHaveLength(1);
    expect(events[0]!.seq).toBe(1);
    expect(events[0]!.event).toEqual({ kind: "user", text: "old" });
    expect(events[0]!.provenance).toBeNull();
    store.close();

    const again = new Store(file); // idempotent, no throw
    expect(again.listEvents("t")).toHaveLength(1);
    again.close();

    const raw = new DatabaseSync(file);
    const tables = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => (r as unknown as { name: string }).name);
    expect(tables).toContain("blobs");
    expect(tables).toContain("injection_ledger");
    raw.close();
  });

  it("adds bindings to a pre-bindings database, backfilling the current agent's session", () => {
    const file = join(tempDir(), "prebind.db");
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE threads (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, agent TEXT NOT NULL DEFAULT 'claude', title TEXT NOT NULL,
        session_id TEXT, model TEXT NOT NULL, permission_mode TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version VALUES (10);
      CREATE TABLE events (thread_id TEXT NOT NULL, seq INTEGER NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL,
        provenance TEXT, message_id TEXT, turn_id TEXT, item_id TEXT, parent_id TEXT, payload_ref TEXT, payload_bytes INTEGER,
        PRIMARY KEY (thread_id, seq));
      INSERT INTO projects VALUES ('p', '/x', 'x', 1);
      INSERT INTO threads VALUES ('fresh', 'p', 'claude', 'Fresh', NULL, 'm', 'ask', 1, 1);
      INSERT INTO threads VALUES ('t', 'p', 'codex', 'Old', 'thr-1', 'm', 'ask', 1, 5);
      INSERT INTO events VALUES ('t', 1, '{"kind":"user","text":"old"}', 2, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
      INSERT INTO events VALUES ('t', 2, '{"kind":"assistant-text","text":"hi"}', 3, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
    `);
    old.close();

    const store = new Store(file);
    closeAfter(() => store.close());
    expect(store.getThread("fresh")).toMatchObject({ bindings: {}, sessionId: null });
    const t = store.getThread("t");
    expect(t.sessionId).toBe("thr-1");
    expect(t.bindings).toEqual({
      "codex:default": { agent: "codex", instanceId: "default", resumeCursor: "thr-1", status: "active", cwd: "/x", lastSeenAt: 5, lastSeq: 2 },
    });
    const raw = new DatabaseSync(file);
    closeAfter(() => raw.close());
    expect((raw.prepare("SELECT session_id FROM threads WHERE id = 't'").get() as { session_id: string }).session_id).toBe("thr-1");
  });

  it("keeps each agent's cursor across a switch and back; sessionId is the current agent's", () => {
    const store = new Store(join(tempDir(), "switch.db"));
    closeAfter(() => store.close());
    const p = store.addProject("/tmp/p");
    const t = store.createThread(p.id, "codex", "m", "ask");
    store.appendEvent(t.id, { kind: "user", text: "hi" });
    store.updateThread(t.id, { sessionId: "thr-1" });
    const codex = store.getThread(t.id).bindings["codex:default"]!;
    expect(codex).toMatchObject({ resumeCursor: "thr-1", cwd: "/tmp/p", lastSeq: 1, status: "active" });

    const onClaude = store.updateThread(t.id, { agent: "claude" });
    expect(onClaude.sessionId).toBeNull();
    store.updateThread(t.id, { sessionId: "claude-s" });
    expect(store.getThread(t.id).sessionId).toBe("claude-s");

    const back = store.updateThread(t.id, { agent: "codex" });
    const reread = store.getThread(t.id);
    expect(reread.bindings["codex:default"]!.resumeCursor).toBe("thr-1");
    expect(reread.bindings["claude:default"]!.resumeCursor).toBe("claude-s");
    expect(back.sessionId).toBe("thr-1");
    expect(reread.sessionId).toBe(reread.bindings["codex:default"]!.resumeCursor);
  });

  it("keeps a thread's context-window override", () => {
    const store = new Store(join(tempDir(), "t.db"));
    closeAfter(() => store.close());
    const p = store.addProject("/tmp/some/project");
    const t = store.createThread(p.id, "codex", "gpt-6-luna", "ask");
    expect(t.contextWindow ?? null).toBeNull();
    expect(store.updateThread(t.id, { contextWindow: 872000 }).contextWindow).toBe(872000);
    expect(store.getThread(t.id).contextWindow).toBe(872000);
    expect(store.updateThread(t.id, { contextWindow: null }).contextWindow).toBeNull();
    expect(store.getThread(t.id).contextWindow).toBeNull();
  });

  it("moves a project to another folder, refusing one another project uses", () => {
    const store = new Store(join(tempDir(), "t.db"));
    closeAfter(() => store.close());
    const a = store.addProject("/tmp/old/a");
    store.addProject("/tmp/taken");
    expect(store.setProjectPath(a.id, "/tmp/new/a").path).toBe("/tmp/new/a");
    expect(store.getProject(a.id).path).toBe("/tmp/new/a");
    expect(() => store.setProjectPath(a.id, "/tmp/taken")).toThrow("Another project already uses that folder.");
  });

  it("adds effort to a database at version 12, keeping existing threads on the model default", () => {
    const file = join(tempDir(), "pre13.db");
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE threads (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, agent TEXT NOT NULL DEFAULT 'claude', title TEXT NOT NULL,
        session_id TEXT, bindings TEXT NOT NULL DEFAULT '{}', model TEXT NOT NULL, permission_mode TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version VALUES (12);
      INSERT INTO projects VALUES ('p', '/x', 'x', 1);
      INSERT INTO threads (id, project_id, agent, title, model, permission_mode, created_at, updated_at)
        VALUES ('t', 'p', 'claude', 'Old', 'opus', 'ask', 1, 1);
    `);
    old.close();

    const store = new Store(file);
    closeAfter(() => store.close());
    expect(store.getThread("t").effort).toBeNull();
    expect(store.updateThread("t", { effort: "high" }).effort).toBe("high");
    expect(store.getThread("t").effort).toBe("high");
    expect(store.updateThread("t", { effort: null }).effort).toBeNull();
    expect(store.getThread("t").effort).toBeNull();
  });

  it("adds worktrees to a database at version 13, keeping existing threads on the project folder", () => {
    const file = join(tempDir(), "pre14.db");
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE threads (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, agent TEXT NOT NULL DEFAULT 'claude', title TEXT NOT NULL,
        session_id TEXT, bindings TEXT NOT NULL DEFAULT '{}', model TEXT NOT NULL, effort TEXT, permission_mode TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version VALUES (13);
      INSERT INTO projects VALUES ('p', '/x', 'x', 1);
      INSERT INTO threads (id, project_id, agent, title, model, permission_mode, created_at, updated_at)
        VALUES ('t', 'p', 'claude', 'Old', 'opus', 'ask', 1, 1);
    `);
    old.close();

    const store = new Store(file);
    closeAfter(() => store.close());
    expect(store.getThread("t")).toMatchObject({ branch: null, worktreePath: null });

    const updated = store.setWorktree("t", "harness/keep-abc123", "/worktrees/t");
    expect(updated).toMatchObject({ branch: "harness/keep-abc123", worktreePath: "/worktrees/t" });
    expect(store.getThread("t")).toMatchObject({ branch: "harness/keep-abc123", worktreePath: "/worktrees/t" });
    expect(store.listThreads("p")[0]).toMatchObject({ branch: "harness/keep-abc123", worktreePath: "/worktrees/t" });
  });

  it("adds check_command to a database at version 14, and setCheckCommand round-trips", () => {
    const file = join(tempDir(), "pre15.db");
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE threads (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, agent TEXT NOT NULL DEFAULT 'claude', title TEXT NOT NULL,
        session_id TEXT, bindings TEXT NOT NULL DEFAULT '{}', model TEXT NOT NULL, effort TEXT, permission_mode TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
        branch TEXT, worktree_path TEXT);
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version VALUES (14);
      INSERT INTO projects VALUES ('p', '/x', 'x', 1);
    `);
    old.close();

    const store = new Store(file);
    closeAfter(() => store.close());
    expect(store.getProject("p").checkCommand ?? null).toBeNull();
    expect(store.setCheckCommand("p", "bun run typecheck").checkCommand).toBe("bun run typecheck");
    expect(store.getProject("p").checkCommand).toBe("bun run typecheck");
    expect(store.listProjects()[0]!.checkCommand).toBe("bun run typecheck");
    // A blank command turns the gate off.
    expect(store.setCheckCommand("p", "   ").checkCommand).toBeNull();
    expect(store.getProject("p").checkFixRounds ?? null).toBeNull();
    expect(store.setCheckCommand("p", "x", 0).checkFixRounds).toBe(0);
    expect(store.setCheckCommand("p", "x", 9).checkFixRounds).toBe(2);
    expect(store.setCheckCommand("p", "x").checkFixRounds).toBe(2);
    expect(store.getProject("p").checkCommand).toBe("x");
  });

  it("round-trips a thread's worktree on a fresh database", () => {
    const store = new Store(join(tempDir(), "worktree.db"));
    closeAfter(() => store.close());
    const p = store.addProject("/tmp/p");
    const t = store.createThread(p.id, "claude", "opus", "ask");
    expect(store.getThread(t.id).branch ?? null).toBeNull();
    expect(store.getThread(t.id).worktreePath ?? null).toBeNull();

    const set = store.setWorktree(t.id, "harness/fresh-abc123", "/wt/fresh");
    expect(set).toMatchObject({ branch: "harness/fresh-abc123", worktreePath: "/wt/fresh" });
    expect(store.getThread(t.id)).toMatchObject({ branch: "harness/fresh-abc123", worktreePath: "/wt/fresh" });
  });

  it("opens a fresh database twice without throwing", () => {
    const file = join(tempDir(), "fresh.db");
    new Store(file).close();
    new Store(file).close();
  });
});

describe("Store event payloads", () => {
  it("round-trips provenance and semantic ids", () => {
    const store = new Store(join(tempDir(), "ids.db"));
    const p = store.addProject("/tmp/p");
    const t = store.createThread(p.id, "claude", "claude-opus-5", "ask");
    const provenance = { agent: "claude", model: "claude-opus-5", provider: "anthropic", instanceId: "i1" };

    store.appendEvent(t.id, { kind: "assistant-text", text: "hi", turnId: "turn-1", itemId: "item-1" }, provenance);
    store.appendEvent(t.id, { kind: "user", text: "no provenance" });

    const events = store.listEvents(t.id);
    expect(events[0]!.provenance).toEqual(provenance);
    expect(events[0]!.event).toMatchObject({ kind: "assistant-text", turnId: "turn-1", itemId: "item-1" });
    expect(events[1]!.provenance).toBeNull();
    expect(events[1]!.event).toEqual({ kind: "user", text: "no provenance" });
    store.close();
  });

  it("removes a deleted thread's blobs (payloads, file and plan versions) but keeps any another thread still uses", () => {
    const dir = tempDir();
    const store = new Store(join(dir, "gc.db"));
    closeAfter(() => store.close());
    const p = store.addProject("/tmp/gc");
    const a = store.createThread(p.id, "claude", "opus", "ask");
    const b = store.createThread(p.id, "claude", "opus", "ask");
    const blobs = join(dir, "blobs");
    const files = () => (existsSync(blobs) ? readdirSync(blobs).sort() : []);
    const rows = () => (store as unknown as { db: DatabaseSync }).db.prepare("SELECT COUNT(*) AS n FROM blobs").get() as unknown as { n: number };

    // A: an offloaded payload, a file version and a plan; B: the same plan text (one shared blob).
    store.appendEvent(a.id, { kind: "tool-result", toolUseId: "tu", isError: false, summary: "big", payload: { data: "x".repeat(100_000) } });
    const sha = (text: string) => createHash("sha256").update(text).digest("hex");
    for (const [thread, path, text] of [[a.id, "src/a.ts", "code"], [a.id, "cubiq:plan.md", "# plan"], [b.id, "cubiq:plan.md", "# plan"]] as const) {
      store.writeBlobBytes(sha(text), Buffer.from(text));
      store.addArtifactVersion(thread, path, sha(text), text.length, 1);
    }
    // A stray file from an interrupted write, and something that isn't a blob at all.
    writeFileSync(join(blobs, "f".repeat(64)), "orphan");
    writeFileSync(join(blobs, "README"), "keep me");
    expect(files()).toHaveLength(5);
    expect(rows().n).toBe(3);

    store.deleteThread(a.id);
    expect(files()).toEqual([sha("# plan"), "README"].sort());
    expect(rows().n).toBe(1);
    expect(store.readBlobBytes(sha("# plan")).toString()).toBe("# plan");

    store.deleteProject(p.id);
    expect(files()).toEqual(["README"]);
    expect(rows().n).toBe(0);
    expect(store.pruneBlobs()).toBe(0);
  });

  it("offloads 100 KB tool payloads to one blob and keeps 2 KB ones inline", () => {
    const dir = tempDir();
    const file = join(dir, "blob.db");
    const store = new Store(file);
    const p = store.addProject("/tmp/p");
    const t = store.createThread(p.id, "claude", "claude-opus-5", "ask");

    const payload = { data: "x".repeat(100_000) };
    const json = JSON.stringify(payload);
    const sha = createHash("sha256").update(json).digest("hex");
    const bytes = Buffer.byteLength(json);
    const event = { kind: "tool-result" as const, toolUseId: "tu", isError: false, summary: "big", payload };
    store.appendEvent(t.id, event);
    store.appendEvent(t.id, event);

    const small = { data: "y".repeat(2000) };
    store.appendEvent(t.id, { kind: "tool-result", toolUseId: "tu2", isError: false, summary: "small", payload: small });

    const events = store.listEvents(t.id);
    expect(events).toHaveLength(3);
    const stub = (events[0]!.event as { payload: { blobRef: string; bytes: number; truncated: boolean } }).payload;
    expect(stub.blobRef).toBe(sha);
    expect(stub.truncated).toBe(true);
    expect(stub.bytes).toBe(bytes);
    expect(store.readBlob(sha)).toBe(json);
    expect((events[2]!.event as { payload: unknown }).payload).toEqual(small);

    const raw = new DatabaseSync(file);
    const big = raw.prepare("SELECT payload_ref, payload_bytes FROM events WHERE seq = 1").get() as unknown as {
      payload_ref: string;
      payload_bytes: number;
    };
    expect(big.payload_ref).toBe(sha);
    expect(big.payload_bytes).toBe(bytes);
    const inline = raw.prepare("SELECT payload_ref FROM events WHERE seq = 3").get() as unknown as { payload_ref: string | null };
    expect(inline.payload_ref).toBeNull();
    const count = raw.prepare("SELECT COUNT(*) AS n FROM blobs").get() as unknown as { n: number };
    expect(count.n).toBe(1);
    raw.close();

    store.close();
  });
});

describe("Store seq allocation", () => {
  it(
    "gives two worker threads disjoint seqs on one database",
    { timeout: 30_000 },
    async () => {
      const file = join(tempDir(), "workers.db");
      const seed = new Store(file);
      const p = seed.addProject("/tmp/p");
      const t = seed.createThread(p.id, "claude", "claude-opus-5", "ask");
      seed.close();

      const fixture = resolve(__dirname, "fixtures", "db-writer.mjs");
      const dbPath = pathToFileURL(resolve(__dirname, "..", "src", "main", "db.ts")).href; // a URL, so import() works on Windows too
      const run = (worker: number) =>
        new Promise<void>((res, rej) => {
          const w = new Worker(fixture, { workerData: { file, threadId: t.id, dbPath, count: 500, worker } });
          w.on("message", (m: { ok: boolean; error?: string }) => (m.ok ? res() : rej(new Error(m.error))));
          w.on("error", rej);
        });
      await Promise.all([run(0), run(1)]);

      const store = new Store(file);
      const seqs = store.listEvents(t.id).map((e) => e.seq);
      expect(seqs).toEqual(Array.from({ length: 1000 }, (_, i) => i + 1));
      store.close();
    },
  );

  it(
    "keeps 10,000 sequential appends contiguous",
    { timeout: 30_000 },
    () => {
      const store = new Store(join(tempDir(), "seq.db"));
      const p = store.addProject("/tmp/p");
      const t = store.createThread(p.id, "claude", "claude-opus-5", "ask");
      for (let i = 0; i < 10_000; i++) store.appendEvent(t.id, { kind: "notice", text: String(i) });
      expect(store.listEvents(t.id).map((e) => e.seq)).toEqual(Array.from({ length: 10_000 }, (_, i) => i + 1));
      store.close();
    },
  );
});

describe("Store search and artifact versions", () => {
  it("upgrades a version-17 database with search and artifact versions", () => {
    const file = join(tempDir(), "pre18.db");
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at INTEGER NOT NULL,
        check_command TEXT, check_fix_rounds INTEGER);
      CREATE TABLE threads (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, agent TEXT NOT NULL DEFAULT 'claude', title TEXT NOT NULL,
        session_id TEXT, bindings TEXT NOT NULL DEFAULT '{}', model TEXT NOT NULL, effort TEXT, permission_mode TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
        branch TEXT, worktree_path TEXT, context_window INTEGER);
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      CREATE TABLE events (thread_id TEXT NOT NULL, seq INTEGER NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL,
        provenance TEXT, message_id TEXT, turn_id TEXT, item_id TEXT, parent_id TEXT, payload_ref TEXT, payload_bytes INTEGER,
        PRIMARY KEY (thread_id, seq));
      CREATE TABLE blobs (sha256 TEXT PRIMARY KEY, bytes INTEGER NOT NULL, created_at INTEGER NOT NULL);
      INSERT INTO schema_version VALUES (17);
      INSERT INTO projects VALUES ('p', '/x', 'x', 1, NULL, NULL);
      INSERT INTO threads (id, project_id, agent, title, model, permission_mode, created_at, updated_at)
        VALUES ('t', 'p', 'claude', 'Old login work', 'opus', 'ask', 1, 1);
      INSERT INTO events VALUES ('t', 1, '{"kind":"user","text":"fix the login limiter"}', 2, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
    `);
    old.close();

    const store = new Store(file);
    closeAfter(() => store.close());
    expect(store.search({ text: "limiter" }).messages).toHaveLength(1);
    expect(store.search({ text: "login work" }).threads).toHaveLength(1);

    const v1 = store.addArtifactVersion("t", "src/a.ts", "sha1", 10, 3);
    expect(v1).toMatchObject({ version: 1, sha256: "sha1", bytes: 10, turnSeq: 3 });
    expect(store.addArtifactVersion("t", "src/a.ts", "sha1", 10, 4)).toBeNull();
    const v2 = store.addArtifactVersion("t", "src/a.ts", "sha2", 12, 5);
    expect(v2).toMatchObject({ version: 2, sha256: "sha2", bytes: 12, turnSeq: 5 });
    expect(store.listArtifactVersions("t")).toEqual([{ path: "src/a.ts", versions: [v1, v2] }]);

    const bytes = Buffer.from([0, 1, 2, 255]);
    store.writeBlobBytes("blobsha", bytes);
    expect(store.readBlobBytes("blobsha").equals(bytes)).toBe(true);
  });
});
