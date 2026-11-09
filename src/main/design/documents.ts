// This file binds the mutation service to threads and pages, and validates what arrives over IPC,
// so it can be tested without Electron.

import { randomUUID } from "node:crypto";
import type {
  DesignHistoryRequest,
  DesignHistoryResult,
  DesignMutation,
  DocumentStatus,
  InsertPosition,
  MutationConflict,
  MutationResult,
} from "../../shared/design-mutation";
import { RETAG_TAGS } from "../../shared/design-mutation";
import { DocumentMutationService, documentIdOf } from "./mutation";

/**
 * True when a call came from the app's own top-level page. A design page runs in a sandboxed frame inside that window,
 * so nothing a page does may ever reach these handlers, even if a frame got hold of the bridge.
 */
export function isFromAppWindow(event: { senderFrame?: { parent?: unknown } | null }): boolean {
  const frame = event.senderFrame;
  return frame !== null && frame !== undefined && (frame.parent === null || frame.parent === undefined);
}

const MAX_ID = 200;
const MAX_TEXT = 1_000_000;
const MAX_PATH = 64;
const MAX_STYLE_CHANGES = 32;
const MAX_EXTRA_IDS = 64;

const POSITIONS: readonly string[] = ["before", "after", "inside-start", "inside-end"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID;
}

function isPosition(value: unknown): value is InsertPosition {
  return typeof value === "string" && POSITIONS.includes(value);
}

/** A path from `<html>`: at most 64 indexes, none negative or fractional. */
function isPath(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_PATH &&
    value.every((at) => Number.isInteger(at) && (at as number) >= 0)
  );
}

/** The change's own fields, rebuilt so an unexpected key never travels on. */
function parseChange(value: unknown): DesignMutation["change"] | null {
  if (!isRecord(value)) return null;
  switch (value.kind) {
    case "setProp":
      if (typeof value.name !== "string" || value.name === "") return null;
      if (!(typeof value.value === "string" || value.value === null)) return null;
      return { kind: "setProp", name: value.name, value: value.value };
    case "setStyle": {
      if (!Array.isArray(value.changes)) return null;
      if (value.changes.length < 1 || value.changes.length > MAX_STYLE_CHANGES) return null;
      const changes: { prop: string; value: string }[] = [];
      for (const entry of value.changes) {
        if (!isRecord(entry)) return null;
        if (typeof entry.prop !== "string" || typeof entry.value !== "string") return null;
        changes.push({ prop: entry.prop, value: entry.value });
      }
      return { kind: "setStyle", changes };
    }
    case "setText":
      if (typeof value.before !== "string" || typeof value.after !== "string") return null;
      return { kind: "setText", before: value.before, after: value.after };
    case "insert":
      if (typeof value.html !== "string" || value.html.length > MAX_TEXT) return null;
      if (!isPosition(value.position)) return null;
      return { kind: "insert", html: value.html, position: value.position };
    case "remove":
      return { kind: "remove" };
    case "move":
      if (!isId(value.refId)) return null;
      if (!isPosition(value.position)) return null;
      return { kind: "move", refId: value.refId, position: value.position };
    case "wrap": {
      if (!Array.isArray(value.extraIds) || value.extraIds.length > MAX_EXTRA_IDS) return null;
      const extraIds: string[] = [];
      for (const id of value.extraIds) {
        if (!isId(id)) return null;
        extraIds.push(id);
      }
      if (typeof value.tag !== "string" || value.tag === "") return null;
      if (!isRecord(value.attrs)) return null;
      const pairs: [string, string][] = [];
      for (const [key, attr] of Object.entries(value.attrs)) {
        if (typeof attr !== "string") return null;
        pairs.push([key, attr]);
      }
      // Built from entries so nothing from the message's prototype follows the attrs in.
      const attrs = Object.fromEntries(pairs);
      return { kind: "wrap", extraIds, tag: value.tag, attrs };
    }
    case "unwrap":
      return { kind: "unwrap" };
    case "duplicate":
      return { kind: "duplicate" };
    case "retag":
      if (typeof value.tag !== "string" || !(RETAG_TAGS as readonly string[]).includes(value.tag)) return null;
      return { kind: "retag", tag: value.tag };
    default:
      return null;
  }
}

function parseTarget(value: unknown): DesignMutation["target"] | null {
  if (!isRecord(value)) return null;
  const hasId = "id" in value;
  const hasLocator = "locator" in value;
  if (hasId === hasLocator) return null;
  if (hasId) {
    if (!isId(value.id)) return null;
    return { id: value.id };
  }

  const locator = value.locator;
  if (!isRecord(locator)) return null;
  if (typeof locator.tag !== "string" || locator.tag === "") return null;
  if (!isPath(locator.path)) return null;
  if ("text" in locator) {
    if (typeof locator.text !== "string") return null;
    return { locator: { tag: locator.tag, path: locator.path, text: locator.text } };
  }
  return { locator: { tag: locator.tag, path: locator.path } };
}

/** Read one mutation off the wire; null for anything the service should never see. */
export function parseDesignMutation(value: unknown): DesignMutation | null {
  if (!isRecord(value)) return null;
  if (!isId(value.operationId) || !isId(value.documentId) || !isId(value.transactionId)) return null;
  if (!Number.isInteger(value.baseRevision) || (value.baseRevision as number) < 0) return null;

  const target = parseTarget(value.target);
  if (!target) return null;
  const change = parseChange(value.change);
  if (!change) return null;

  return {
    operationId: value.operationId,
    documentId: value.documentId,
    baseRevision: value.baseRevision as number,
    target,
    transactionId: value.transactionId,
    change,
  };
}

/** Read one history request off the wire; undefined fields stay off the result. */
export function parseHistoryRequest(value: unknown): DesignHistoryRequest | null {
  if (!isRecord(value)) return null;
  switch (value.action) {
    case "status":
      return { action: "status" };
    case "flush":
      return { action: "flush" };
    case "redo":
      return { action: "redo" };
    case "undo":
      if (!("crossBoundary" in value)) return { action: "undo" };
      if (typeof value.crossBoundary !== "boolean") return null;
      return { action: "undo", crossBoundary: value.crossBoundary };
    case "close-transaction":
      if (!isId(value.transactionId)) return null;
      return { action: "close-transaction", transactionId: value.transactionId };
    default:
      return null;
  }
}

export interface DesignDocumentsOptions {
  journalDir: string;
  /** True while an agent turn runs on the thread: its pages are read-only until it ends. */
  isBusy: (threadId: string) => boolean;
  /** Called once, before a page's first open, so the text as it stood is kept as a version. */
  beforeFirstOpen?: (threadId: string, rel: string) => void;
  onSaved?: (threadId: string, rel: string) => void;
  /** A page's save state, revision or undo state changed; `conflicts` says edits are waiting to be fetched with a history call. */
  onStatus?: (threadId: string, rel: string, status: DocumentStatus, conflicts: boolean) => void;
  /** Test seam, passed straight to the service. */
  debounceMs?: number;
}

interface Tracked {
  threadId: string;
  rel: string;
  conflicts: MutationConflict[];
  /** A check outside the watcher already found a foreign write, so the watcher's report of it isn't our own save. */
  foreignSeen: boolean;
  /** Edits replayed from the journal on open, until the canvas has been told. */
  recovered: number;
}

/**
 * The pages open for each thread. A page is tracked the first time anything asks about it; every call
 * names the page by thread and path, and the document id is derived from those.
 */
export class DesignDocuments {
  private readonly service: DocumentMutationService;
  private readonly options: DesignDocumentsOptions;
  private readonly tracked = new Map<string, Tracked>();

  constructor(options: DesignDocumentsOptions) {
    this.options = options;
    // Both callbacks run from a save timer, where a throw would be an uncaught exception.
    this.service = new DocumentMutationService({
      journalDir: options.journalDir,
      ...(options.debounceMs !== undefined ? { debounceMs: options.debounceMs } : {}),
      onSaved: (documentId) => {
        const entry = this.tracked.get(documentId);
        if (!entry) return;
        try {
          this.options.onSaved?.(entry.threadId, entry.rel);
        } catch (error) {
          console.error("design: onSaved failed", error);
        }
      },
      onStatus: (status) => this.tell(status.documentId, status),
      onConflicts: (documentId, conflicts) => {
        const entry = this.tracked.get(documentId);
        if (!entry) return;
        entry.conflicts.push(...conflicts);
        // Reading the status reports it, which tells the canvas that conflicts wait.
        this.service.status(documentId);
      },
    });
  }

  /** Pass a status on from a save timer, where a throw would be an uncaught exception. */
  private tell(documentId: string, status: DocumentStatus): void {
    const entry = this.tracked.get(documentId);
    if (!entry) return;
    try {
      this.options.onStatus?.(entry.threadId, entry.rel, status, entry.conflicts.length > 0);
    } catch (error) {
      console.error("design: onStatus failed", error);
    }
  }

  /** Look for a write nobody reported, remembering a foreign one for the watcher's later report. */
  private checkDisk(id: string): void {
    if (!this.service.noteDiskChange(id).changed) return;
    const entry = this.tracked.get(id);
    if (entry) entry.foreignSeen = true;
  }

  /** Open the page if it is not open yet, and return its id. */
  private ensure(threadId: string, rel: string, file: string): string {
    const id = documentIdOf(threadId, rel);
    if (this.tracked.has(id)) return id;

    try {
      this.options.beforeFirstOpen?.(threadId, rel);
    } catch (error) {
      console.error("design: beforeFirstOpen failed", error);
    }
    // An open that throws leaves nothing tracked, so the next call simply tries again.
    const opened = this.service.open(id, file);
    this.tracked.set(id, { threadId, rel, conflicts: [...opened.conflicts], foreignSeen: false, recovered: opened.recovered });
    if (this.options.isBusy(threadId)) this.service.setReadOnly(id, true);
    return id;
  }

  mutate(threadId: string, rel: string, file: string, mutation: DesignMutation): MutationResult {
    if (mutation.documentId !== documentIdOf(threadId, rel)) {
      return {
        ok: false,
        operationId: mutation.operationId,
        reason: "invalid",
        currentRevision: 0,
        message: "That edit is for another page.",
      };
    }
    const id = this.ensure(threadId, rel, file);
    // A write that no watcher reported still has to be seen before this edit is based on it.
    this.checkDisk(id);
    return this.service.mutate(mutation);
  }

  history(threadId: string, rel: string, file: string, request: DesignHistoryRequest): DesignHistoryResult {
    const id = this.ensure(threadId, rel, file);
    this.checkDisk(id);

    let result: MutationResult | undefined;
    switch (request.action) {
      case "undo":
        result = this.service.undo(id, request.crossBoundary === true ? { crossBoundary: true } : undefined);
        // The canvas reloads the frame after this, and the frame reads the file.
        this.service.flush(id);
        break;
      case "redo":
        result = this.service.redo(id);
        this.service.flush(id);
        break;
      case "flush":
        this.service.flush(id);
        break;
      case "close-transaction":
        this.service.closeTransaction(id, request.transactionId);
        break;
      case "status":
        break;
    }

    const status = this.service.status(id);
    const html = this.service.html(id);
    // Both are set once ensure has opened the page.
    if (status === null || html === null) throw new Error("That page isn't open.");

    // Conflicts are handed out once and then forgotten, so the canvas is never told twice.
    const entry = this.tracked.get(id);
    const conflicts = entry ? entry.conflicts : [];
    if (entry) entry.conflicts = [];
    const recovered = entry?.recovered ?? 0;
    if (entry) entry.recovered = 0;
    // On disk before the canvas reloads its frame to show them.
    if (recovered > 0) this.service.flush(id);

    return { status, html, conflicts, ...(result !== undefined ? { result } : {}), ...(recovered > 0 ? { recovered } : {}) };
  }

  /**
   * Edits the main process makes for a page: an agent's token call, a kit move. They're one undo step, they apply even
   * during the turn that asked for them, and they're on disk when this returns. Refusals come back as the message.
   */
  apply(threadId: string, rel: string, file: string, target: DesignMutation["target"], changes: DesignMutation["change"][]): { ok: true } | { ok: false; message: string } {
    const id = this.ensure(threadId, rel, file);
    this.checkDisk(id);
    const busy = this.options.isBusy(threadId);
    if (busy) this.service.setReadOnly(id, false);
    const transactionId = randomUUID();
    try {
      for (const change of changes) {
        const status = this.service.status(id);
        if (!status) return { ok: false, message: "That page isn't open." };
        const result = this.service.mutate({ operationId: randomUUID(), documentId: id, baseRevision: status.revision, target, transactionId, change });
        if (!result.ok) return { ok: false, message: result.message ?? "That edit can't be made here." };
      }
      this.service.closeTransaction(id, transactionId);
      this.service.flush(id);
      return { ok: true };
    } finally {
      if (busy) this.service.setReadOnly(id, true);
    }
  }

  /** The page's text as the service holds it: newer than the file while a save is waiting. */
  text(threadId: string, rel: string, file: string): string {
    const id = this.ensure(threadId, rel, file);
    this.checkDisk(id);
    const html = this.service.html(id);
    if (html === null) throw new Error("That page isn't open.");
    return html;
  }

  /**
   * The watcher saw these paths change. Returns the ones that aren't this service's own saves (null when it wasn't
   * told which), so an edit's save doesn't reload the frame that already shows it.
   */
  diskChanged(threadId: string, paths: string[] | null): string[] | null {
    const wanted = paths === null ? null : new Set(paths.map((path) => path.replace(/\\/g, "/")));
    const own = new Set<string>();
    for (const [id, entry] of [...this.tracked]) {
      if (entry.threadId !== threadId) continue;
      const rel = entry.rel.replace(/\\/g, "/");
      if (wanted !== null && !wanted.has(rel)) continue;
      try {
        const changed = this.service.noteDiskChange(id).changed;
        if (!changed && !entry.foreignSeen) own.add(rel);
        entry.foreignSeen = false;
      } catch (error) {
        console.error("design: disk change failed", error);
      }
    }
    return wanted === null ? null : [...wanted].filter((path) => !own.has(path));
  }

  setBusy(threadId: string, busy: boolean): void {
    for (const [id, entry] of [...this.tracked]) {
      if (entry.threadId !== threadId) continue;
      this.service.setReadOnly(id, busy);
    }
  }

  dispose(): void {
    this.service.dispose();
    this.tracked.clear();
  }
}
