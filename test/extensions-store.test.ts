import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Store } from "../src/main/db";
import { computeProposalDigest } from "../src/main/extensions/manifest";
import { ExtensionStore } from "../src/main/extensions/store";
import { closeAfter, tempDir } from "./helpers";

describe("ExtensionStore", () => {
  it("stages proposals, updates status, records and removes installs, and deletes proposals when a thread is deleted", () => {
    const store = new Store(join(tempDir(), "ext.db"));
    closeAfter(() => store.close());
    const ext = new ExtensionStore(store.sql);

    const project = store.addProject("/tmp/ext-proj");
    const thread = store.createThread(project.id, "claude", "opus", "ask", "chat", null, null, "creator");
    const scope = { kind: "project" as const, projectId: project.id };
    const draft = {
      kind: "skill" as const,
      name: "commit-helper",
      description: "Help with commits",
      files: [{ path: "SKILL.md", content: "---\nname: commit-helper\ndescription: \"Help with commits\"\n---\nBody\n" }],
    };
    const digest = computeProposalDigest(scope, draft);

    const staged = ext.stage({ threadId: thread.id, scope, draft, digest });
    expect(staged.status).toBe("staged");
    expect(ext.get(staged.id)).toEqual(staged);
    expect(ext.forThread(thread.id)).toEqual([staged]);

    const installed = ext.setStatus(staged.id, "installed");
    expect(installed?.status).toBe("installed");

    const failed = ext.setStatus(staged.id, "failed", "conflict");
    expect(failed).toMatchObject({ status: "failed", error: "conflict" });

    const rec = ext.recordInstall({
      proposalId: staged.id,
      scope,
      kind: "skill",
      name: "commit-helper",
      location: "/tmp/ext-proj/.cubiq/skills/commit-helper",
      files: [{ path: "SKILL.md", sha256: "abc" }],
      digest,
    });
    expect(ext.installs(scope)).toEqual([rec]);
    expect(ext.installs({ kind: "global" })).toEqual([]);
    expect(ext.installs()).toEqual([rec]);

    ext.removeInstall(rec.id);
    expect(ext.installs()).toEqual([]);

    store.deleteThread(thread.id);
    expect(ext.get(staged.id)).toBeNull();
    expect(ext.forThread(thread.id)).toEqual([]);
  });

  it("migrates an older database to add extension_proposals and extension_installs", () => {
    const file = join(tempDir(), "old-ext.db");
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE threads (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, agent TEXT NOT NULL DEFAULT 'claude', title TEXT NOT NULL,
        session_id TEXT, model TEXT NOT NULL, permission_mode TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version VALUES (1);
    `);
    old.close();

    const store = new Store(file);
    closeAfter(() => store.close());
    const ext = new ExtensionStore(store.sql);
    expect(ext.installs()).toEqual([]);
  });
});
