import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { PermissionMode, Project, StoredEvent, Thread, ThreadEvent } from "../shared/types";

/**
 * Plain rows in SQLite (node:sqlite, so no native module to rebuild per
 * platform). Projects, threads, and each thread's events in order. No event
 * sourcing: a thread's history is just its events table.
 */
export class Store {
  private db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
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
        PRIMARY KEY (thread_id, seq)
      );
    `);
    this.migrate();
  }

  /** Additive migrations, in order. Each runs once per database. */
  private migrate(): void {
    const steps: string[] = [
      // 1: threads choose their agent
      "ALTER TABLE threads ADD COLUMN agent TEXT NOT NULL DEFAULT 'claude'",
    ];
    const row = this.db.prepare("SELECT version FROM schema_version").get() as unknown as { version: number } | undefined;
    let version = row?.version ?? 0;
    if (!row) this.db.prepare("INSERT INTO schema_version (version) VALUES (0)").run();
    for (; version < steps.length; version++) {
      const cols = this.db.prepare("PRAGMA table_info(threads)").all() as unknown as { name: string }[];
      // A fresh database may already have the column from a newer CREATE; skip if so.
      if (!(version === 0 && cols.some((c) => c.name === "agent"))) this.db.exec(steps[version]!);
      this.db.prepare("UPDATE schema_version SET version = ?").run(version + 1);
    }
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

  updateThread(id: string, patch: Partial<Pick<Thread, "title" | "model" | "permissionMode" | "sessionId" | "agent">>): Thread {
    const t = { ...this.getThread(id), ...patch, updatedAt: Date.now() };
    this.db
      .prepare("UPDATE threads SET agent = ?, title = ?, session_id = ?, model = ?, permission_mode = ?, updated_at = ? WHERE id = ?")
      .run(t.agent, t.title, t.sessionId, t.model, t.permissionMode, t.updatedAt, id);
    return t;
  }

  deleteThread(id: string): void {
    this.db.prepare("DELETE FROM threads WHERE id = ?").run(id);
  }

  appendEvent(threadId: string, event: ThreadEvent): StoredEvent {
    const row = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE thread_id = ?").get(threadId) as unknown as {
      seq: number;
    };
    const stored: StoredEvent = { seq: row.seq + 1, event, createdAt: Date.now() };
    this.db
      .prepare("INSERT INTO events (thread_id, seq, payload, created_at) VALUES (?, ?, ?, ?)")
      .run(threadId, stored.seq, JSON.stringify(event), stored.createdAt);
    return stored;
  }

  listEvents(threadId: string): StoredEvent[] {
    return this.db
      .prepare("SELECT seq, payload, created_at FROM events WHERE thread_id = ? ORDER BY seq")
      .all(threadId)
      .map((r) => {
        const row = r as unknown as { seq: number; payload: string; created_at: number };
        return { seq: row.seq, event: JSON.parse(row.payload) as ThreadEvent, createdAt: row.created_at };
      });
  }
}

const THREAD_COLS = "id, project_id, agent, title, session_id, model, permission_mode, created_at, updated_at";

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
  model: string;
  permission_mode: string;
  created_at: number;
  updated_at: number;
}

function toProject(r: ProjectRow): Project {
  return { id: r.id, path: r.path, name: r.name, createdAt: r.created_at };
}

function toThread(r: ThreadRow): Thread {
  return {
    id: r.id,
    projectId: r.project_id,
    agent: r.agent,
    title: r.title,
    sessionId: r.session_id,
    model: r.model,
    permissionMode: r.permission_mode as PermissionMode,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
