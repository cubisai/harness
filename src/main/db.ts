import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { bindingKey } from "../shared/bindings";
import type { PermissionMode, Project, Provenance, SessionBinding, StoredEvent, Thread, ThreadEvent, Usage } from "../shared/types";

/**
 * Plain rows in SQLite (node:sqlite, so no native module to rebuild per
 * platform). Projects, threads, and each thread's events in order. No event
 * sourcing: a thread's history is just its events table.
 */
export class Store {
  private db: DatabaseSync;
  private blobsDir: string;

  constructor(file: string) {
    // The busy timeout must apply before the first statement, or a second
    // connection opening the same file fails "database is locked" on setup.
    this.db = new DatabaseSync(file, { timeout: 5000 });
    this.blobsDir = join(dirname(file), "blobs");
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        session_id TEXT,
        model TEXT NOT NULL,
        permission_mode TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events (
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        provenance TEXT,
        message_id TEXT,
        turn_id TEXT,
        item_id TEXT,
        parent_id TEXT,
        payload_ref TEXT,
        payload_bytes INTEGER,
        PRIMARY KEY (thread_id, seq)
      );
      CREATE TABLE IF NOT EXISTS blobs (
        sha256 TEXT PRIMARY KEY,
        bytes INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS injection_ledger (
        thread_id TEXT NOT NULL,
        target_provider TEXT NOT NULL,
        target_session_id TEXT NOT NULL,
        checkpoint_id TEXT NOT NULL,
        item_fingerprint TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('intent', 'injected', 'failed')),
        injected_at INTEGER,
        PRIMARY KEY (thread_id, target_provider, target_session_id, checkpoint_id, item_fingerprint)
      );
    `);
    this.migrate();
  }

  /** Additive migrations, in order. Each runs once per database. */
  private migrate(): void {
    const steps: { applied: (db: DatabaseSync) => boolean; sql: string }[] = [
      // 1: threads choose their agent
      { applied: () => this.hasColumn("threads", "agent"), sql: "ALTER TABLE threads ADD COLUMN agent TEXT NOT NULL DEFAULT 'claude'" },
      // 2-8: semantic ids, provenance, and blob pointers on events
      { applied: () => this.hasColumn("events", "provenance"), sql: "ALTER TABLE events ADD COLUMN provenance TEXT" },
      { applied: () => this.hasColumn("events", "message_id"), sql: "ALTER TABLE events ADD COLUMN message_id TEXT" },
      { applied: () => this.hasColumn("events", "turn_id"), sql: "ALTER TABLE events ADD COLUMN turn_id TEXT" },
      { applied: () => this.hasColumn("events", "item_id"), sql: "ALTER TABLE events ADD COLUMN item_id TEXT" },
      { applied: () => this.hasColumn("events", "parent_id"), sql: "ALTER TABLE events ADD COLUMN parent_id TEXT" },
      { applied: () => this.hasColumn("events", "payload_ref"), sql: "ALTER TABLE events ADD COLUMN payload_ref TEXT" },
      { applied: () => this.hasColumn("events", "payload_bytes"), sql: "ALTER TABLE events ADD COLUMN payload_bytes INTEGER" },
      // 9-10: content-addressed blobs and the Phase 6 injection ledger
      {
        applied: () => this.hasTable("blobs"),
        sql: "CREATE TABLE IF NOT EXISTS blobs (sha256 TEXT PRIMARY KEY, bytes INTEGER NOT NULL, created_at INTEGER NOT NULL)",
      },
      {
        applied: () => this.hasTable("injection_ledger"),
        sql: `CREATE TABLE IF NOT EXISTS injection_ledger (
          thread_id TEXT NOT NULL,
          target_provider TEXT NOT NULL,
          target_session_id TEXT NOT NULL,
          checkpoint_id TEXT NOT NULL,
          item_fingerprint TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('intent', 'injected', 'failed')),
          injected_at INTEGER,
          PRIMARY KEY (thread_id, target_provider, target_session_id, checkpoint_id, item_fingerprint)
        )`,
      },
      // 11: per-agent session bindings, backfilled from session_id for the thread's agent.
      // session_id stays, mirroring the current agent's cursor, so a rollback still resumes.
      {
        applied: () => this.hasColumn("threads", "bindings"),
        sql: `ALTER TABLE threads ADD COLUMN bindings TEXT NOT NULL DEFAULT '{}';
          UPDATE threads SET bindings = json_object(agent || ':default', json_object(
            'agent', agent, 'instanceId', 'default', 'resumeCursor', session_id, 'status', 'active',
            'cwd', (SELECT path FROM projects WHERE projects.id = threads.project_id), 'lastSeenAt', updated_at,
            'lastSeq', (SELECT COALESCE(MAX(seq), 0) FROM events WHERE events.thread_id = threads.id)))
          WHERE session_id IS NOT NULL`,
      },
      // 12: pins that survive a restart, and archived threads (kept, just out of the list).
      {
        applied: () => this.hasColumn("threads", "archived"),
        sql: `ALTER TABLE threads ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE threads ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;`,
      },
    ];
    const row = this.db.prepare("SELECT version FROM schema_version").get() as unknown as { version: number } | undefined;
    let version = row?.version ?? 0;
    if (!row) this.db.prepare("INSERT INTO schema_version (version) VALUES (0)").run();
    for (; version < steps.length; version++) {
      const step = steps[version]!;
      // A fresh database may already have the column/table from the newer CREATE; skip if so.
      if (!step.applied(this.db)) this.db.exec(step.sql);
      this.db.prepare("UPDATE schema_version SET version = ?").run(version + 1);
    }
  }

  private hasColumn(table: string, col: string): boolean {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
    return cols.some((c) => c.name === col);
  }

  private hasTable(table: string): boolean {
    return !!this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  }

  close(): void {
    this.db.close();
  }

  listProjects(): Project[] {
    return this.db
      .prepare("SELECT id, path, name, created_at FROM projects ORDER BY name COLLATE NOCASE")
      .all()
      .map((r) => toProject(r as unknown as ProjectRow));
  }

  addProject(path: string): Project {
    const existing = this.db.prepare("SELECT id, path, name, created_at FROM projects WHERE path = ?").get(path);
    if (existing) return toProject(existing as unknown as ProjectRow);
    const project: Project = { id: randomUUID(), path, name: basename(path) || path, createdAt: Date.now() };
    this.db
      .prepare("INSERT INTO projects (id, path, name, created_at) VALUES (?, ?, ?, ?)")
      .run(project.id, project.path, project.name, project.createdAt);
    return project;
  }

  getProject(id: string): Project {
    const row = this.db.prepare("SELECT id, path, name, created_at FROM projects WHERE id = ?").get(id);
    if (!row) throw new Error(`no project ${id}`);
    return toProject(row as unknown as ProjectRow);
  }

  listThreads(projectId: string): Thread[] {
    return this.db
      .prepare(`SELECT ${THREAD_COLS} FROM threads WHERE project_id = ? ORDER BY updated_at DESC`)
      .all(projectId)
      .map((r) => toThread(r as unknown as ThreadRow));
  }

  createThread(projectId: string, agent: string, model: string, permissionMode: PermissionMode): Thread {
    const now = Date.now();
    const thread: Thread = {
      id: randomUUID(),
      projectId,
      agent,
      title: "New thread",
      sessionId: null,
      bindings: {},
      model,
      permissionMode,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        "INSERT INTO threads (id, project_id, agent, title, session_id, model, permission_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(thread.id, projectId, agent, thread.title, null, model, permissionMode, now, now);
    return thread;
  }

  getThread(id: string): Thread {
    const row = this.db.prepare(`SELECT ${THREAD_COLS} FROM threads WHERE id = ?`).get(id);
    if (!row) throw new Error(`no thread ${id}`);
    return toThread(row as unknown as ThreadRow);
  }

  /**
   * `sessionId` writes the cursor of the thread's agent (after any `agent` change in
   * the same patch). Changing `agent` keeps every binding, so switching back resumes.
   */
  updateThread(id: string, patch: Partial<Pick<Thread, "title" | "model" | "permissionMode" | "sessionId" | "agent" | "pinned" | "archived">>): Thread {
    const current = this.getThread(id);
    const now = Date.now();
    const { sessionId, ...rest } = patch;
    const agent = patch.agent ?? current.agent;
    const bindings = { ...current.bindings };
    if (sessionId !== undefined) {
      const key = bindingKey(agent);
      bindings[key] = this.binding(current, agent, sessionId, bindings[key], now);
    }
    // Pinning, archiving or renaming isn't activity: the thread keeps its place (and its Settled state).
    const activity = Object.keys(patch).some((k) => k !== "pinned" && k !== "archived" && k !== "title");
    const t: Thread = { ...current, ...rest, agent, bindings, sessionId: bindings[bindingKey(agent)]?.resumeCursor ?? null, updatedAt: activity ? now : current.updatedAt };
    this.db
      .prepare("UPDATE threads SET agent = ?, title = ?, session_id = ?, bindings = ?, model = ?, permission_mode = ?, pinned = ?, archived = ?, updated_at = ? WHERE id = ?")
      .run(t.agent, t.title, t.sessionId, JSON.stringify(bindings), t.model, t.permissionMode, t.pinned ? 1 : 0, t.archived ? 1 : 0, t.updatedAt, id);
    return t;
  }

  private binding(thread: Thread, agent: string, cursor: string | null, prior: SessionBinding | undefined, now: number): SessionBinding {
    const last = this.db.prepare("SELECT MAX(seq) AS seq FROM events WHERE thread_id = ?").get(thread.id) as unknown as { seq: number | null };
    return {
      ...prior,
      agent,
      instanceId: prior?.instanceId ?? "default",
      resumeCursor: cursor,
      status: "active",
      cwd: prior?.cwd ?? this.getProject(thread.projectId).path,
      lastSeenAt: now,
      lastSeq: last.seq ?? 0,
    };
  }

  deleteThread(id: string): void {
    this.db.prepare("DELETE FROM threads WHERE id = ?").run(id);
  }

  appendEvent(threadId: string, event: ThreadEvent, provenance: Provenance | null = null): StoredEvent {
    const createdAt = Date.now();
    let storedEvent = event;
    let payloadRef: string | null = null;
    let payloadBytes: number | null = null;
    // Large tool I/O moves to a content-addressed blob; the event JSON keeps a stub.
    if ((event.kind === "tool-use" || event.kind === "tool-result") && event.payload !== undefined) {
      const json = JSON.stringify(event.payload);
      const bytes = Buffer.byteLength(json);
      if (bytes > 65536) {
        const sha = createHash("sha256").update(json).digest("hex");
        this.writeBlob(sha, json);
        storedEvent = { ...event, payload: { blobRef: sha, bytes, truncated: true, preview: json.slice(0, 1024) } };
        payloadRef = sha;
        payloadBytes = bytes;
      }
    }
    const row = this.db
      .prepare(
        `INSERT INTO events (thread_id, seq, payload, created_at, provenance, message_id, turn_id, item_id, parent_id, payload_ref, payload_bytes)
         SELECT ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM events WHERE thread_id = ?
         RETURNING seq`,
      )
      .get(
        threadId,
        JSON.stringify(storedEvent),
        createdAt,
        provenance ? JSON.stringify(provenance) : null,
        storedEvent.messageId ?? null,
        storedEvent.turnId ?? null,
        storedEvent.itemId ?? null,
        storedEvent.parentId ?? null,
        payloadRef,
        payloadBytes,
        threadId,
      ) as unknown as { seq: number };
    return { seq: row.seq, event: storedEvent, createdAt, provenance };
  }

  /** Read an offloaded payload back by its sha256. */
  readBlob(sha256: string): string {
    return readFileSync(join(this.blobsDir, sha256), "utf8");
  }

  /** Store an offloaded payload under its sha256; content-addressed, so a second write is a no-op. */
  writeBlob(sha256: string, content: string): void {
    const file = join(this.blobsDir, sha256);
    if (!existsSync(file)) {
      mkdirSync(this.blobsDir, { recursive: true });
      writeFileSync(file, content);
    }
    this.db
      .prepare("INSERT OR IGNORE INTO blobs (sha256, bytes, created_at) VALUES (?, ?, ?)")
      .run(sha256, Buffer.byteLength(content), Date.now());
  }

  /**
   * Injection ledger: seeding a target is not idempotent, so every item is
   * recorded before it is sent and marked after. Intent and failed rows roll
   * forward on the next run; injected rows are skipped.
   */
  recordIntent(t: LedgerTarget, fingerprint: string): void {
    this.db
      .prepare(
        `INSERT INTO injection_ledger (thread_id, target_provider, target_session_id, checkpoint_id, item_fingerprint, state, injected_at)
         VALUES (?, ?, ?, ?, ?, 'intent', NULL)
         ON CONFLICT(thread_id, target_provider, target_session_id, checkpoint_id, item_fingerprint) DO UPDATE SET state = 'intent' WHERE state = 'failed'`,
      )
      .run(t.threadId, t.provider, t.sessionId, t.checkpointId, fingerprint);
  }

  markInjected(t: LedgerTarget, fingerprint: string): void {
    this.db
      .prepare(
        `UPDATE injection_ledger SET state = 'injected', injected_at = ?
         WHERE thread_id = ? AND target_provider = ? AND target_session_id = ? AND checkpoint_id = ? AND item_fingerprint = ?`,
      )
      .run(Date.now(), t.threadId, t.provider, t.sessionId, t.checkpointId, fingerprint);
  }

  markFailed(t: LedgerTarget, fingerprint: string): void {
    this.db
      .prepare(
        `UPDATE injection_ledger SET state = 'failed'
         WHERE thread_id = ? AND target_provider = ? AND target_session_id = ? AND checkpoint_id = ? AND item_fingerprint = ? AND state != 'injected'`,
      )
      .run(t.threadId, t.provider, t.sessionId, t.checkpointId, fingerprint);
  }

  injectedFingerprints(t: { threadId: string; provider: string; sessionId: string }): Set<string> {
    const rows = this.db
      .prepare(
        `SELECT item_fingerprint FROM injection_ledger
         WHERE thread_id = ? AND target_provider = ? AND target_session_id = ? AND state = 'injected'`,
      )
      .all(t.threadId, t.provider, t.sessionId) as unknown as { item_fingerprint: string }[];
    return new Set(rows.map((r) => r.item_fingerprint));
  }

  ledgerRows(t: LedgerTarget): { fingerprint: string; state: "intent" | "injected" | "failed" }[] {
    const rows = this.db
      .prepare(
        `SELECT item_fingerprint, state FROM injection_ledger
         WHERE thread_id = ? AND target_provider = ? AND target_session_id = ? AND checkpoint_id = ?
         ORDER BY item_fingerprint`,
      )
      .all(t.threadId, t.provider, t.sessionId, t.checkpointId) as unknown as { item_fingerprint: string; state: "intent" | "injected" | "failed" }[];
    return rows.map((r) => ({ fingerprint: r.item_fingerprint, state: r.state }));
  }

  /**
   * Insert an exported thread and its events as a new thread, all or nothing.
   * Events keep their seq, time, provenance and ids; blobs must already be written.
   */
  restoreThread(projectId: string, data: { thread: Thread; events: StoredEvent[] }): Thread {
    const id = randomUUID();
    const { thread } = data;
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          "INSERT INTO threads (id, project_id, agent, title, session_id, bindings, model, permission_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          id,
          projectId,
          thread.agent,
          thread.title,
          thread.sessionId,
          JSON.stringify(thread.bindings ?? {}),
          thread.model,
          thread.permissionMode,
          thread.createdAt,
          Date.now(),
        );
      const insert = this.db.prepare(
        `INSERT INTO events (thread_id, seq, payload, created_at, provenance, message_id, turn_id, item_id, parent_id, payload_ref, payload_bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const { seq, event, createdAt, provenance } of data.events) {
        const ref = blobRefOf(event);
        insert.run(
          id,
          seq,
          JSON.stringify(event),
          createdAt,
          provenance ? JSON.stringify(provenance) : null,
          event.messageId ?? null,
          event.turnId ?? null,
          event.itemId ?? null,
          event.parentId ?? null,
          ref?.sha256 ?? null,
          ref?.bytes ?? null,
        );
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return this.getThread(id);
  }

  listEvents(threadId: string): StoredEvent[] {
    return this.db
      .prepare("SELECT seq, payload, created_at, provenance FROM events WHERE thread_id = ? ORDER BY seq")
      .all(threadId)
      .map((r) => {
        const row = r as unknown as { seq: number; payload: string; created_at: number; provenance: string | null };
        return {
          seq: row.seq,
          event: JSON.parse(row.payload) as ThreadEvent,
          createdAt: row.created_at,
          provenance: row.provenance ? (JSON.parse(row.provenance) as Provenance) : null,
        };
      });
  }

  /**
   * Every turn-end usage across all threads with created_at in [from, to), in
   * time order — the raw material for a rollback window's cache figures. A
   * turn-end that carried no usage object isn't a data point, so it's skipped.
   */
  turnUsage(from: number, to: number): { threadId: string; createdAt: number; usage: Usage }[] {
    return this.db
      .prepare("SELECT thread_id, payload, created_at FROM events WHERE created_at >= ? AND created_at < ? ORDER BY created_at")
      .all(from, to)
      .map((r) => r as unknown as { thread_id: string; payload: string; created_at: number })
      .flatMap((row) => {
        const event = JSON.parse(row.payload) as ThreadEvent;
        if (event.kind !== "turn-end" || !event.usage) return [];
        return [{ threadId: row.thread_id, createdAt: row.created_at, usage: event.usage }];
      });
  }
}

const THREAD_COLS =
  "id, project_id, agent, title, session_id, bindings, model, permission_mode, created_at, updated_at, pinned, archived, (SELECT path FROM projects WHERE projects.id = threads.project_id) AS project_path";

export interface LedgerTarget {
  threadId: string;
  provider: string;
  sessionId: string;
  checkpointId: string;
}

interface ProjectRow {
  id: string;
  path: string;
  name: string;
  created_at: number;
}

interface ThreadRow {
  id: string;
  project_id: string;
  agent: string;
  title: string;
  session_id: string | null;
  bindings: string | null;
  model: string;
  permission_mode: string;
  created_at: number;
  updated_at: number;
  pinned: number;
  archived: number;
  project_path: string | null;
}

/** The blob a tool event's payload was offloaded to, or null when it's inline. */
export function blobRefOf(event: ThreadEvent): { sha256: string; bytes: number | null } | null {
  if (event.kind !== "tool-use" && event.kind !== "tool-result") return null;
  const p = event.payload as { blobRef?: unknown; bytes?: unknown } | null | undefined;
  if (!p || typeof p !== "object" || typeof p.blobRef !== "string") return null;
  return { sha256: p.blobRef, bytes: typeof p.bytes === "number" ? p.bytes : null };
}

function toProject(r: ProjectRow): Project {
  return { id: r.id, path: r.path, name: r.name, createdAt: r.created_at };
}

function toThread(r: ThreadRow): Thread {
  const bindings = JSON.parse(r.bindings || "{}") as Record<string, SessionBinding>;
  const key = bindingKey(r.agent);
  // This build writes session_id only as a mirror of the binding, so a column
  // that disagrees was written by an older build after a rollback: it wins.
  if (r.session_id !== null && r.session_id !== bindings[key]?.resumeCursor) {
    const prior = bindings[key];
    bindings[key] = {
      ...prior,
      agent: r.agent,
      instanceId: prior?.instanceId ?? "default",
      resumeCursor: r.session_id,
      status: "active",
      cwd: prior?.cwd ?? r.project_path ?? "",
      lastSeenAt: r.updated_at,
      lastSeq: prior?.lastSeq ?? 0,
    };
  }
  const current = bindings[key];
  return {
    id: r.id,
    projectId: r.project_id,
    agent: r.agent,
    title: r.title,
    sessionId: current?.resumeCursor ?? null,
    bindings,
    model: r.model,
    permissionMode: r.permission_mode as PermissionMode,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    pinned: r.pinned === 1,
    archived: r.archived === 1,
  };
}
