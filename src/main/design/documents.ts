// This file binds the mutation service to threads and pages, and validates what arrives over IPC,
// so it can be tested without Electron.

import type {
  DesignHistoryRequest,
  DesignHistoryResult,
  DesignMutation,
  InsertPosition,
  MutationConflict,
  MutationResult,
} from "../../shared/design-mutation";
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
  /** Test seam, passed straight to the service. */
  debounceMs?: number;
}

interface Tracked {
  threadId: string;
  rel: string;
  conflicts: MutationConflict[];
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
      onConflicts: (documentId, conflicts) => {
        this.tracked.get(documentId)?.conflicts.push(...conflicts);
      },
    });
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
    this.tracked.set(id, { threadId, rel, conflicts: [...opened.conflicts] });
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
    this.service.noteDiskChange(id);
    return this.service.mutate(mutation);
  }

  history(threadId: string, rel: string, file: string, request: DesignHistoryRequest): DesignHistoryResult {
    const id = this.ensure(threadId, rel, file);
    this.service.noteDiskChange(id);

    let result: MutationResult | undefined;
    switch (request.action) {
      case "undo":
        result = this.service.undo(id, request.crossBoundary === true ? { crossBoundary: true } : undefined);
        break;
      case "redo":
        result = this.service.redo(id);
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

    return { status, html, conflicts, ...(result !== undefined ? { result } : {}) };
  }

  diskChanged(threadId: string, paths: string[] | null): void {
    const wanted = paths === null ? null : new Set(paths.map((path) => path.replace(/\\/g, "/")));
    for (const [id, entry] of [...this.tracked]) {
      if (entry.threadId !== threadId) continue;
      if (wanted !== null && !wanted.has(entry.rel.replace(/\\/g, "/"))) continue;
      try {
        this.service.noteDiskChange(id);
      } catch (error) {
        console.error("design: disk change failed", error);
      }
    }
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
