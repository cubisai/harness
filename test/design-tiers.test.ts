import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Store } from "../src/main/db";
import { DEFAULT_TIER, TIERS, readTier, tierFeatures, tierNote, tierOf } from "../src/shared/tiers";
import { closeAfter, tempDir } from "./helpers";

describe("prototype tiers", () => {
  it("reads only the three known tiers", () => {
    expect(readTier("quick")).toBe("quick");
    expect(readTier("working")).toBe("working");
    expect(readTier("real-app")).toBe("real-app");
    expect(readTier("draft")).toBeNull();
    expect(readTier(null)).toBeNull();
    expect(readTier(undefined)).toBeNull();
    expect(readTier(3)).toBeNull();
  });

  it("defaults a thread with no tier to working", () => {
    expect(DEFAULT_TIER).toBe("working");
    expect(tierOf({})).toBe("working");
    expect(tierOf({ prototypeTier: "quick" })).toBe("quick");
    expect(tierOf({ prototypeTier: "real-app" })).toBe("real-app");
  });

  it("lists the three tiers with labels and details", () => {
    expect(TIERS.map((t) => t.value)).toEqual(["quick", "working", "real-app"]);
    for (const t of TIERS) {
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.detail.length).toBeGreaterThan(0);
    }
  });

  it("enables features per tier", () => {
    expect(tierFeatures("quick")).toEqual({ tweaks: false, textEdit: false, comments: false });
    expect(tierFeatures("working")).toEqual({ tweaks: true, textEdit: true, comments: false });
    expect(tierFeatures("real-app")).toEqual({ tweaks: true, textEdit: true, comments: true });
  });

  it("gives each tier a non-empty, distinct note", () => {
    const notes = (["quick", "working", "real-app"] as const).map((t) => tierNote(t));
    for (const note of notes) expect(note.length).toBeGreaterThan(0);
    expect(new Set(notes).size).toBe(3);
  });
});

describe("Store prototype tiers (migration 22)", () => {
  it("starts a new design thread with no tier, and round-trips set/clear", () => {
    const store = new Store(join(tempDir(), "tiers.db"));
    closeAfter(() => store.close());
    const p = store.addProject("/tmp/p");
    const design = store.createThread(p.id, "claude", "m", "ask", "design");
    expect(store.getThread(design.id).prototypeTier).toBeUndefined();

    expect(store.setPrototypeTier(design.id, "quick").prototypeTier).toBe("quick");
    expect(store.getThread(design.id).prototypeTier).toBe("quick");

    expect(store.setPrototypeTier(design.id, null).prototypeTier).toBeUndefined();
    expect(store.getThread(design.id).prototypeTier).toBeUndefined();
  });

  it("stores a tier on a chat thread but never reads it back", () => {
    const dir = tempDir();
    const file = join(dir, "chat.db");
    const store = new Store(file);
    closeAfter(() => store.close());
    const p = store.addProject("/tmp/p");
    const chat = store.createThread(p.id, "claude", "m", "ask");

    store.setPrototypeTier(chat.id, "real-app");
    expect(store.getThread(chat.id).prototypeTier).toBeUndefined();

    const raw = new DatabaseSync(file);
    closeAfter(() => raw.close());
    expect((raw.prepare("SELECT prototype_tier FROM threads WHERE id = ?").get(chat.id) as { prototype_tier: string }).prototype_tier).toBe("real-app");
  });

  it("adds a nullable prototype_tier column to a pre-22 database", () => {
    const file = join(tempDir(), "pre22.db");
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at INTEGER NOT NULL,
        check_command TEXT, check_fix_rounds INTEGER);
      CREATE TABLE threads (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, agent TEXT NOT NULL DEFAULT 'claude', title TEXT NOT NULL,
        session_id TEXT, bindings TEXT NOT NULL DEFAULT '{}', model TEXT NOT NULL, effort TEXT, permission_mode TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
        branch TEXT, worktree_path TEXT, context_window INTEGER, kind TEXT NOT NULL DEFAULT 'chat', design_system TEXT);
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version VALUES (21);
      INSERT INTO projects VALUES ('p', '/x', 'x', 1, NULL, NULL);
      INSERT INTO threads (id, project_id, agent, title, model, permission_mode, created_at, updated_at, kind)
        VALUES ('t', 'p', 'claude', 'Old design', 'opus', 'ask', 1, 1, 'design');
    `);
    old.close();

    const store = new Store(file);
    closeAfter(() => store.close());
    expect(store.getThread("t").prototypeTier).toBeUndefined();
    expect(store.setPrototypeTier("t", "quick").prototypeTier).toBe("quick");
  });

  it("keeps a design thread's tier through restore, never on a chat", () => {
    const store = new Store(join(tempDir(), "restore-tier.db"));
    closeAfter(() => store.close());
    const p = store.addProject("/tmp/p");
    const design = store.createThread(p.id, "claude", "m", "ask", "design");
    store.setPrototypeTier(design.id, "real-app");

    const restored = store.restoreThread(p.id, { thread: store.getThread(design.id), events: [] });
    expect(store.getThread(restored.id).prototypeTier).toBe("real-app");

    // An export from before the field existed restores as absent (working).
    const { prototypeTier: _tier, ...withoutTier } = store.getThread(design.id);
    const older = store.restoreThread(p.id, { thread: withoutTier, events: [] });
    expect(store.getThread(older.id).prototypeTier).toBeUndefined();
  });
});
