import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { bindingKey } from "../shared/bindings";
import type {
  ArtifactVersion,
  PermissionMode,
  Project,
  Provenance,
  SearchHit,
  SearchQuery,
  SearchResults,
  SessionBinding,
  StoredEvent,
  Thread,
  ThreadEvent,
  Usage,
} from "../shared/types";

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
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        check_command TEXT,
        check_fix_rounds INTEGER
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
      // 13: per-thread reasoning effort; null keeps the model's own default.
      {
        applied: () => this.hasColumn("threads", "effort"),
        sql: "ALTER TABLE threads ADD COLUMN effort TEXT",
      },
      // 14: a thread's own git worktree (T8.13): the branch, and the folder its tools run in.
      {
        applied: () => this.hasColumn("threads", "worktree_path"),
        sql: `ALTER TABLE threads ADD COLUMN branch TEXT;
          ALTER TABLE threads ADD COLUMN worktree_path TEXT;`,
      },
      // 15: the project's post-turn check command; null = off.
      { applied: () => this.hasColumn("projects", "check_command"), sql: "ALTER TABLE projects ADD COLUMN check_command TEXT" },
      // 16: how many automatic fix turns a failed check may send; null = 1.
      { applied: () => this.hasColumn("projects", "check_fix_rounds"), sql: "ALTER TABLE projects ADD COLUMN check_fix_rounds INTEGER" },
      // 17: the thread's context-window override in tokens; null = the model's default.
      { applied: () => this.hasColumn("threads", "context_window"), sql: "ALTER TABLE threads ADD COLUMN context_window INTEGER" },
      // 18: full-text search over thread titles and user/assistant messages (⌘K).
      {
        applied: () => this.hasTable("search_fts"),
        sql: `CREATE VIRTUAL TABLE search_fts USING fts5(body, thread_id UNINDEXED, seq UNINDEXED, kind UNINDEXED, tokenize = 'unicode61 remove_diacritics 2');
          INSERT INTO search_fts (body, thread_id, seq, kind) SELECT title, id, NULL, 'title' FROM threads;
          INSERT INTO search_fts (body, thread_id, seq, kind)
            SELECT json_extract(payload, '$.text'), thread_id, seq, json_extract(payload, '$.kind')
            FROM events WHERE json_extract(payload, '$.kind') IN ('user', 'assistant-text');
          CREATE TRIGGER search_events_ai AFTER INSERT ON events
            WHEN json_extract(new.payload, '$.kind') IN ('user', 'assistant-text')
            BEGIN
              INSERT INTO search_fts (body, thread_id, seq, kind)
                VALUES (json_extract(new.payload, '$.text'), new.thread_id, new.seq, json_extract(new.payload, '$.kind'));
            END;
          CREATE TRIGGER search_events_ad AFTER DELETE ON events
            BEGIN
              DELETE FROM search_fts WHERE thread_id = old.thread_id AND seq = old.seq;
            END;
          CREATE TRIGGER search_threads_ai AFTER INSERT ON threads
            BEGIN
              INSERT INTO search_fts (body, thread_id, seq, kind) VALUES (new.title, new.id, NULL, 'title');
            END;
          CREATE TRIGGER search_threads_au AFTER UPDATE OF title ON threads
            BEGIN
              UPDATE search_fts SET body = new.title WHERE kind = 'title' AND thread_id = new.id;
            END;
          CREATE TRIGGER search_threads_ad AFTER DELETE ON threads
            BEGIN
              DELETE FROM search_fts WHERE thread_id = old.id;
            END;`,
      },
      // 19: saved versions of files agents wrote (artifact panel); content lives in blobs.
      {
        applied: () => this.hasTable("artifact_versions"),
        sql: `CREATE TABLE artifact_versions (
          thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
          path TEXT NOT NULL,
          version INTEGER NOT NULL,
          sha256 TEXT NOT NULL,
          bytes INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          turn_seq INTEGER NOT NULL,
          PRIMARY KEY (thread_id, path, version)
        )`,
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
      .prepare("SELECT id, path, name, created_at, check_command, check_fix_rounds FROM projects ORDER BY name COLLATE NOCASE")
      .all()
      .map((r) => toProject(r as unknown as ProjectRow));
  }

  addProject(path: string): Project {
    const existing = this.db.prepare("SELECT id, path, name, created_at, check_command, check_fix_rounds FROM projects WHERE path = ?").get(path);
    if (existing) return toProject(existing as unknown as ProjectRow);
    const project: Project = { id: randomUUID(), path, name: basename(path) || path, createdAt: Date.now() };
    this.db
      .prepare("INSERT INTO projects (id, path, name, created_at) VALUES (?, ?, ?, ?)")
      .run(project.id, project.path, project.name, project.createdAt);
    return project;
  }

  getProject(id: string): Project {
    const row = this.db.prepare("SELECT id, path, name, created_at, check_command, check_fix_rounds FROM projects WHERE id = ?").get(id);
    if (!row) throw new Error(`no project ${id}`);
    return toProject(row as unknown as ProjectRow);
  }

  /** Point a project at another folder; a folder another project already uses is refused. */
  setProjectPath(id: string, path: string): Project {
    const existing = this.db.prepare("SELECT id FROM projects WHERE path = ? AND id != ?").get(path, id);
    if (existing) throw new Error("Another project already uses that folder.");
    this.db.prepare("UPDATE projects SET path = ? WHERE id = ?").run(path, id);
    return this.getProject(id);
  }

  /** Set the project's post-turn check command; a blank command turns it off. */
  setCheckCommand(id: string, command: string | null, fixRounds?: number | null): Project {
    this.db.prepare("UPDATE projects SET check_command = ? WHERE id = ?").run(command?.trim() || null, id);
    // Left out = unchanged; otherwise clamped to 0-2 (null = the default, 1).
    if (fixRounds !== undefined) {
      const rounds = fixRounds === null ? null : Math.max(0, Math.min(2, Math.trunc(fixRounds)));
      this.db.prepare("UPDATE projects SET check_fix_rounds = ? WHERE id = ?").run(rounds, id);
    }
    return this.getProject(id);
  }

  deleteProject(id: string): void {
    const threadIds = (
      this.db.prepare("SELECT id FROM threads WHERE project_id = ?").all(id) as unknown as { id: string }[]
    ).map((r) => r.id);
    if (threadIds.length > 0) {
      const placeholders = threadIds.map(() => "?").join(", ");
      this.db.prepare(`DELETE FROM injection_ledger WHERE thread_id IN (${placeholders})`).run(...threadIds);
      this.db.prepare(`DELETE FROM events WHERE thread_id IN (${placeholders})`).run(...threadIds);
      this.db.prepare(`DELETE FROM threads WHERE id IN (${placeholders})`).run(...threadIds);
    }
    this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
    this.pruneBlobs();
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
      effort: null,
      permissionMode,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        "INSERT INTO threads (id, project_id, agent, title, session_id, model, effort, permission_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(thread.id, projectId, agent, thread.title, null, model, null, permissionMode, now, now);
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
  updateThread(id: string, patch: Partial<Pick<Thread, "title" | "model" | "effort" | "contextWindow" | "permissionMode" | "sessionId" | "agent" | "pinned" | "archived">>): Thread {
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
      .prepare("UPDATE threads SET agent = ?, title = ?, session_id = ?, bindings = ?, model = ?, effort = ?, context_window = ?, permission_mode = ?, pinned = ?, archived = ?, updated_at = ? WHERE id = ?")
      .run(t.agent, t.title, t.sessionId, JSON.stringify(bindings), t.model, t.effort, t.contextWindow ?? null, t.permissionMode, t.pinned ? 1 : 0, t.archived ? 1 : 0, t.updatedAt, id);
    return t;
  }

  /** Record the worktree and branch a thread runs in (set once, when it is created). */
  setWorktree(id: string, branch: string, worktreePath: string): Thread {
    this.db.prepare("UPDATE threads SET branch = ?, worktree_path = ? WHERE id = ?").run(branch, worktreePath, id);
    return this.getThread(id);
  }

  private binding(thread: Thread, agent: string, cursor: string | null, prior: SessionBinding | undefined, now: number): SessionBinding {
    const last = this.db.prepare("SELECT MAX(seq) AS seq FROM events WHERE thread_id = ?").get(thread.id) as unknown as { seq: number | null };
    return {
      ...prior,
      agent,
      instanceId: prior?.instanceId ?? "default",
      resumeCursor: cursor,
      status: "active",
      cwd: prior?.cwd ?? thread.worktreePath ?? this.getProject(thread.projectId).path,
      lastSeenAt: now,
      lastSeq: last.seq ?? 0,
    };
  }

  deleteThread(id: string): void {
    this.db.prepare("DELETE FROM threads WHERE id = ?").run(id);
    this.pruneBlobs();
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

  /** Store binary content under its sha256; content-addressed, so a second write is a no-op. */
  writeBlobBytes(sha256: string, content: Buffer): void {
    const file = join(this.blobsDir, sha256);
    if (!existsSync(file)) {
      mkdirSync(this.blobsDir, { recursive: true });
      writeFileSync(file, content);
    }
    this.db
      .prepare("INSERT OR IGNORE INTO blobs (sha256, bytes, created_at) VALUES (?, ?, ?)")
      .run(sha256, content.length, Date.now());
  }

  /** Read binary content back by its sha256. */
  readBlobBytes(sha256: string): Buffer {
    return readFileSync(join(this.blobsDir, sha256));
  }

  /**
   * Remove every blob nothing points at any more (an offloaded event payload or a
   * saved artifact version, plans included), rows and files alike. Deleting a
   * thread or project cascades its events and versions but not their content, so
   * this runs after each delete and once at startup. Returns how many went; never throws.
   */
  pruneBlobs(): number {
    try {
      const rows = this.db
        .prepare("SELECT payload_ref AS sha FROM events WHERE payload_ref IS NOT NULL UNION SELECT sha256 FROM artifact_versions")
        .all() as unknown as { sha: string }[];
      const live = new Set(rows.map((r) => r.sha));
      const gone = new Set<string>();
      const del = this.db.prepare("DELETE FROM blobs WHERE sha256 = ?");
      for (const { sha256 } of this.db.prepare("SELECT sha256 FROM blobs").all() as unknown as { sha256: string }[]) {
        if (live.has(sha256)) continue;
        del.run(sha256);
        gone.add(sha256);
      }
      let files: string[] = [];
      try {
        files = readdirSync(this.blobsDir);
      } catch {
        // No blob was ever written.
      }
      for (const name of files) {
        // Only content-addressed files; anything else in the folder isn't ours to remove.
        if (!/^[0-9a-f]{64}$/.test(name) || live.has(name)) continue;
        try {
          rmSync(join(this.blobsDir, name), { force: true });
          gone.add(name);
        } catch {
          // Locked (Windows) or already gone: the next prune tries again.
        }
      }
      return gone.size;
    } catch (err) {
      console.warn("blob prune failed", err);
      return 0;
    }
  }

  /** Full-text search across thread titles and messages; an unparseable query finds nothing. */
  search(query: SearchQuery): SearchResults {
    const words = query.text
      .split(/\s+/)
      .map((w) => w.replace(/"/g, ""))
      .filter((w) => w.length > 0);
    if (words.length === 0) return { threads: [], messages: [] };
    const match = words.map((w) => `"${w}"*`).join(" ");
    const limit = query.limit ?? 20;
    const run = (kind: string): SearchHit[] => {
      const filters = [kind];
      const params: (string | number)[] = [match];
      if (query.projectId != null) {
        filters.push("threads.project_id = ?");
        params.push(query.projectId);
      }
      if (query.agent != null) {
        filters.push("threads.agent = ?");
        params.push(query.agent);
      }
      params.push(limit);
      const rows = this.db
        .prepare(
          `SELECT search_fts.thread_id AS thread_id, threads.project_id AS project_id, threads.title AS title, threads.agent AS agent,
             search_fts.seq AS seq, search_fts.kind AS kind,
             snippet(search_fts, 0, char(1), char(2), '…', 12) AS snippet, threads.updated_at AS updated_at
           FROM search_fts JOIN threads ON threads.id = search_fts.thread_id
           WHERE search_fts MATCH ? AND threads.archived = 0 AND ${filters.join(" AND ")}
           ORDER BY rank LIMIT ?`,
        )
        .all(...params) as unknown as SearchRow[];
      return rows.map((r) => ({
        threadId: r.thread_id,
        projectId: r.project_id,
        title: r.title,
        agent: r.agent,
        seq: r.seq,
        kind: r.kind as SearchHit["kind"],
        snippet: r.snippet,
        updatedAt: r.updated_at,
      }));
    };
    try {
      return { threads: run("search_fts.kind = 'title'"), messages: run("search_fts.kind IN ('user', 'assistant-text')") };
    } catch {
      return { threads: [], messages: [] };
    }
  }

  /** Save a file's content as a new version; unchanged content is a no-op. */
  addArtifactVersion(threadId: string, path: string, sha256: string, bytes: number, turnSeq: number): ArtifactVersion | null {
    const latest = this.db
      .prepare("SELECT version, sha256 FROM artifact_versions WHERE thread_id = ? AND path = ? ORDER BY version DESC LIMIT 1")
      .get(threadId, path) as unknown as { version: number; sha256: string } | undefined;
    if (latest?.sha256 === sha256) return null;
    const version = (latest?.version ?? 0) + 1;
    const createdAt = Date.now();
    this.db
      .prepare("INSERT INTO artifact_versions (thread_id, path, version, sha256, bytes, created_at, turn_seq) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(threadId, path, version, sha256, bytes, createdAt, turnSeq);
    return { version, sha256, bytes, createdAt, turnSeq };
  }

  /** Every file the thread wrote, each with its versions ascending, newest file first. */
  listArtifactVersions(threadId: string): { path: string; versions: ArtifactVersion[] }[] {
    const rows = this.db
      .prepare("SELECT path, version, sha256, bytes, created_at, turn_seq FROM artifact_versions WHERE thread_id = ? ORDER BY path, version")
      .all(threadId) as unknown as ArtifactRow[];
    const byPath = new Map<string, ArtifactVersion[]>();
    for (const r of rows) {
      const versions = byPath.get(r.path) ?? [];
      versions.push({ version: r.version, sha256: r.sha256, bytes: r.bytes, createdAt: r.created_at, turnSeq: r.turn_seq });
      byPath.set(r.path, versions);
    }
    return [...byPath.entries()]
      .map(([path, versions]) => ({ path, versions }))
      .sort((a, b) => {
        const newest = (v: ArtifactVersion[]) => v[v.length - 1]!;
        const an = newest(a.versions);
        const bn = newest(b.versions);
        if (bn.createdAt !== an.createdAt) return bn.createdAt - an.createdAt;
        if (bn.turnSeq !== an.turnSeq) return bn.turnSeq - an.turnSeq;
        return a.path.localeCompare(b.path);
      });
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
          "INSERT INTO threads (id, project_id, agent, title, session_id, bindings, model, effort, permission_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          id,
          projectId,
          thread.agent,
          thread.title,
          thread.sessionId,
          JSON.stringify(thread.bindings ?? {}),
          thread.model,
          thread.effort ?? null,
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
  "id, project_id, agent, title, session_id, bindings, model, effort, context_window, permission_mode, created_at, updated_at, pinned, archived, branch, worktree_path, (SELECT path FROM projects WHERE projects.id = threads.project_id) AS project_path";

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
  check_command: string | null;
  check_fix_rounds: number | null;
}

interface SearchRow {
  thread_id: string;
  project_id: string;
  title: string;
  agent: string;
  seq: number | null;
  kind: string;
  snippet: string;
  updated_at: number;
}

interface ArtifactRow {
  path: string;
  version: number;
  sha256: string;
  bytes: number;
  created_at: number;
  turn_seq: number;
}

interface ThreadRow {
  id: string;
  project_id: string;
  agent: string;
  title: string;
  session_id: string | null;
  bindings: string | null;
  model: string;
  effort: string | null;
  context_window: number | null;
  permission_mode: string;
  created_at: number;
  updated_at: number;
  pinned: number;
  archived: number;
  branch: string | null;
  worktree_path: string | null;
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
  return { id: r.id, path: r.path, name: r.name, createdAt: r.created_at, checkCommand: r.check_command ?? null, checkFixRounds: r.check_fix_rounds ?? null };
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
      cwd: prior?.cwd ?? r.worktree_path ?? r.project_path ?? "",
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
    effort: r.effort ?? null,
    contextWindow: r.context_window ?? null,
    permissionMode: r.permission_mode as PermissionMode,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    pinned: r.pinned === 1,
    archived: r.archived === 1,
    branch: r.branch,
    worktreePath: r.worktree_path,
  };
}
