// Typed SQLite store for Creator mode extension proposals and installed records.

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ConnectorDraft, ProposalScope, ProposalStatus, SkillDraft, StoredProposal } from "./manifest";

export interface InstalledFile {
  path: string;
  sha256: string;
}

export interface ExtensionInstall {
  id: string;
  proposalId: string;
  scope: ProposalScope;
  kind: "skill" | "connector";
  name: string;
  location: string;
  files: InstalledFile[];
  digest: string;
  installedAt: number;
}

interface RawProposal {
  id: string;
  thread_id: string;
  scope: string;
  kind: string;
  name: string;
  draft: string;
  digest: string;
  status: string;
  error: string | null;
  created_at: number;
  updated_at: number;
}

interface RawInstall {
  id: string;
  proposal_id: string;
  scope: string;
  kind: string;
  name: string;
  location: string;
  files: string;
  digest: string;
  installed_at: number;
}

export function encodeScope(scope: ProposalScope): string {
  return scope.kind === "global" ? "global" : `project:${scope.projectId}`;
}

export function decodeScope(raw: string): ProposalScope {
  if (raw.startsWith("project:")) return { kind: "project", projectId: raw.slice("project:".length) };
  return { kind: "global" };
}

function toProposal(r: RawProposal): StoredProposal {
  return {
    id: r.id,
    threadId: r.thread_id,
    scope: decodeScope(r.scope),
    draft: JSON.parse(r.draft) as SkillDraft | ConnectorDraft,
    digest: r.digest,
    status: r.status as ProposalStatus,
    ...(r.error !== null && r.error !== undefined ? { error: r.error } : {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toInstall(r: RawInstall): ExtensionInstall {
  return {
    id: r.id,
    proposalId: r.proposal_id,
    scope: decodeScope(r.scope),
    kind: r.kind as "skill" | "connector",
    name: r.name,
    location: r.location,
    files: JSON.parse(r.files) as InstalledFile[],
    digest: r.digest,
    installedAt: r.installed_at,
  };
}

export class ExtensionStore {
  constructor(private db: DatabaseSync) {}

  stage(input: {
    id?: string;
    threadId: string;
    scope: ProposalScope;
    draft: SkillDraft | ConnectorDraft;
    digest: string;
    createdAt?: number;
  }): StoredProposal {
    const now = input.createdAt ?? Date.now();
    const id = input.id ?? randomUUID();
    const scopeStr = encodeScope(input.scope);
    this.db
      .prepare(
        `INSERT INTO extension_proposals (id, thread_id, scope, kind, name, draft, digest, status, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'staged', NULL, ?, ?)`,
      )
      .run(id, input.threadId, scopeStr, input.draft.kind, input.draft.name, JSON.stringify(input.draft), input.digest, now, now);
    return this.get(id)!;
  }

  get(id: string): StoredProposal | null {
    const row = this.db.prepare("SELECT * FROM extension_proposals WHERE id = ?").get(id) as unknown as RawProposal | undefined;
    return row ? toProposal(row) : null;
  }

  setStatus(id: string, status: ProposalStatus, error?: string | null): StoredProposal | null {
    const now = Date.now();
    this.db
      .prepare("UPDATE extension_proposals SET status = ?, error = ?, updated_at = ? WHERE id = ?")
      .run(status, error ?? null, now, id);
    return this.get(id);
  }

  /** The user moved a reviewed proposal to another scope: the digest is re-bound to it. */
  rescope(id: string, scope: ProposalScope, digest: string): StoredProposal | null {
    this.db
      .prepare("UPDATE extension_proposals SET scope = ?, digest = ?, updated_at = ? WHERE id = ? AND status IN ('staged', 'failed')")
      .run(encodeScope(scope), digest, Date.now(), id);
    return this.get(id);
  }

  forThread(threadId: string): StoredProposal[] {
    return (
      this.db
        .prepare("SELECT * FROM extension_proposals WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC")
        .all(threadId) as unknown as RawProposal[]
    ).map(toProposal);
  }

  recordInstall(input: {
    id?: string;
    proposalId: string;
    scope: ProposalScope;
    kind: "skill" | "connector";
    name: string;
    location: string;
    files: InstalledFile[];
    digest: string;
    installedAt?: number;
  }): ExtensionInstall {
    const id = input.id ?? randomUUID();
    const installedAt = input.installedAt ?? Date.now();
    const scopeStr = encodeScope(input.scope);
    this.db
      .prepare(
        `INSERT INTO extension_installs (id, proposal_id, scope, kind, name, location, files, digest, installed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope, kind, name) DO UPDATE SET
           id = excluded.id,
           proposal_id = excluded.proposal_id,
           location = excluded.location,
           files = excluded.files,
           digest = excluded.digest,
           installed_at = excluded.installed_at`,
      )
      .run(id, input.proposalId, scopeStr, input.kind, input.name, input.location, JSON.stringify(input.files), input.digest, installedAt);
    return this.getInstall(id)!;
  }

  getInstall(id: string): ExtensionInstall | null {
    const row = this.db.prepare("SELECT * FROM extension_installs WHERE id = ?").get(id) as unknown as RawInstall | undefined;
    return row ? toInstall(row) : null;
  }

  installs(scope?: ProposalScope): ExtensionInstall[] {
    if (scope) {
      return (
        this.db
          .prepare("SELECT * FROM extension_installs WHERE scope = ? ORDER BY installed_at DESC, rowid DESC")
          .all(encodeScope(scope)) as unknown as RawInstall[]
      ).map(toInstall);
    }
    return (
      this.db.prepare("SELECT * FROM extension_installs ORDER BY installed_at DESC, rowid DESC").all() as unknown as RawInstall[]
    ).map(toInstall);
  }

  removeInstall(id: string): void {
    this.db.prepare("DELETE FROM extension_installs WHERE id = ?").run(id);
  }
}
