// The one main-process authority for editing a design page. The file on disk is the source of truth:
// every accepted mutation becomes a patch in a write-ahead journal before it touches memory, so a crash
// replays to the same bytes, and an edit from outside the app rebases what we hold instead of being lost.

import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import type {
  DesignChange,
  DesignMutation,
  DocumentStatus,
  MutationConflict,
  MutationFailure,
  MutationResult,
  SaveState,
} from "../../shared/design-mutation";
import { applyChange, applyPatch, diffPatch, invertPatch, SourceEditError, type EditOutcome, type TextPatch } from "./source-edit";

export type { DocumentStatus, MutationConflict, SaveState };

/** The id a page is known by to everyone else: the first 24 hex of a hash of its thread and path. */
export function documentIdOf(threadId: string, rel: string): string {
  return createHash("sha256").update(`${threadId}\0${rel}`).digest("hex").slice(0, 24);
}

/** What `open` read back: the text, its status, how many journal entries were replayed, and refusals. */
export interface OpenResult {
  html: string;
  status: DocumentStatus;
  recovered: number;
  conflicts: MutationConflict[];
}

/** Whether a disk check found the file changed, and which held edits it could not carry over. */
export interface DiskChange {
  changed: boolean;
  conflicts: MutationConflict[];
}

export interface MutationServiceOptions {
  journalDir: string;
  debounceMs?: number;
  idleMs?: number;
  now?: () => number;
  newId?: () => string;
  onSaved?: (documentId: string, file: string) => void;
  onStatus?: (status: DocumentStatus) => void;
  /** Told about edits a disk change or a save could not carry over, so none are dropped silently. */
  onConflicts?: (documentId: string, conflicts: MutationConflict[]) => void;
}

/** One accepted, not-yet-saved edit: replayable on changed text because its ids are captured. */
interface JournalEntry {
  operationId: string;
  transactionId: string;
  target: DesignMutation["target"];
  change: DesignChange;
  /** Ids this mutation generated, in order, so a replay lands on the same bytes. */
  ids: string[];
  patch: TextPatch;
  /** An undo or redo entry's one splice from the group's text in effect to the group's text applied. */
  op: "mutate" | "undo" | "redo";
  patches?: TextPatch[];
}

interface JournalHeader {
  v: 1;
  documentId: string;
  baseHash: string;
}

/** Overview log entry: which element was touched and through which key. */
interface TouchEntry {
  id: string;
  key: string;
  revision: number;
}

interface UndoGroup {
  boundary?: false;
  /** Sealed by `closeTransaction`: later edits never join it, though it stays undoable. */
  closed?: boolean;
  transactionId: string;
  lastAt: number;
  patches: TextPatch[];
  touched: string[];
}

interface Boundary {
  boundary: true;
}

type StackItem = UndoGroup | Boundary;

interface Document {
  file: string;
  html: string;
  revision: number;
  diskHash: string;
  readOnly: boolean;
  undo: StackItem[];
  redo: StackItem[];
  touched: TouchEntry[];
  pending: JournalEntry[];
  lastExternalRevision: number;
  results: Map<string, MutationResult>;
  timer: ReturnType<typeof setTimeout> | null;
  /** The disk hash the journal on disk was written against; null when no journal is on disk. */
  journalBase: string | null;
}

const DEFAULT_DEBOUNCE_MS = 250;
const DEFAULT_IDLE_MS = 500;
const MAX_UNDO = 200;
const MAX_RESULTS = 500;
const MAX_HISTORY_BYTES = 2 * 1024 * 1024;
const RENAME_RETRIES = 5;
const RENAME_WAIT_MS = 20;

/** Write (or append) one file's bytes, flush them, then close it. */
function writeDurable(file: string, text: string, flag: "w" | "a" = "w"): void {
  const fd = openSync(file, flag);
  try {
    writeSync(fd, text);
    try {
      fsyncSync(fd);
    } catch {
      // Some filesystems refuse fsync; the write stands either way.
    }
  } finally {
    closeSync(fd);
  }
}

/** Write a file by renaming a sibling temp file over it, retrying the rename a few times past a lock. */
function writeAtomic(file: string, text: string, randomHex: () => string): void {
  const temp = `${file}.tmp.${process.pid}.${randomHex()}`;
  try {
    writeDurable(temp, text);
    let attempt = 1;
    for (;;) {
      try {
        renameSync(temp, file);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const transient = code === "EPERM" || code === "EBUSY" || code === "EACCES";
        if (!transient || attempt >= RENAME_RETRIES) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RENAME_WAIT_MS * attempt);
        attempt++;
      }
    }
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // The temp file's own removal is best effort.
    }
    throw error;
  }
}

/** The conflict keys a mutation claims: one per attribute, style declaration, or the element as a whole. */
function keysOf(change: DesignChange): string[] {
  switch (change.kind) {
    case "setProp":
      return [`attr:${change.name.toLowerCase()}`];
    case "setStyle":
      return change.changes.map((entry) => `style:${entry.prop}`);
    case "setText":
      return ["text"];
    default:
      return ["*"];
  }
}

/** An id source that replays captured ids first, then falls through to the generator. */
function replayIds(ids: readonly string[], fallback: () => string): () => string {
  let at = 0;
  return () => ids[at++] ?? fallback();
}

function isGroup(item: StackItem | undefined): item is UndoGroup {
  return item !== undefined && item.boundary !== true;
}

function isBoundary(item: StackItem | undefined): item is Boundary {
  return item !== undefined && item.boundary === true;
}

/** How many journal lines parse; a torn trailing line is ignored, a broken first line upstream of it is not. */
function parseLines(text: string): { header: unknown; entries: JournalEntry[] } | null {
  const lines = text.split("\n");
  const headerLine = lines[0];
  if (headerLine === undefined || headerLine.trim() === "") return null;
  let header: unknown;
  try {
    header = JSON.parse(headerLine);
  } catch {
    return null;
  }
  if (typeof header !== "object" || header === null) return null;
  if ((header as { v?: unknown }).v !== 1) return null;

  const entries: JournalEntry[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "") continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      break; // A torn write only ever truncates the tail.
    }
    if (typeof entry !== "object" || entry === null) break;
    entries.push(entry as JournalEntry);
  }
  return { header, entries };
}

function isHeader(value: unknown): value is JournalHeader {
  const record = value as Partial<JournalHeader> | null;
  return typeof record === "object" && record !== null && typeof record.baseHash === "string";
}

/**
 * The mutation service for one main process. It owns each open page's authority text, its undo history
 * and its write-ahead journal; everything else goes through it.
 */
export class DocumentMutationService {
  private readonly journalDir: string;
  private readonly debounceMs: number;
  private readonly idleMs: number;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly onSaved: ((documentId: string, file: string) => void) | undefined;
  private readonly onStatus: ((status: DocumentStatus) => void) | undefined;
  private readonly onConflicts: ((documentId: string, conflicts: MutationConflict[]) => void) | undefined;
  private readonly docs = new Map<string, Document>();
  /** Documents whose latest save attempt failed: a later change must retry on its own. */
  private readonly failed = new Set<string>();

  constructor(options: MutationServiceOptions) {
    this.journalDir = options.journalDir;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? (() => `el-${randomHex(8)}`);
    this.onSaved = options.onSaved;
    this.onStatus = options.onStatus;
    this.onConflicts = options.onConflicts;
    mkdirSync(this.journalDir, { recursive: true });
  }

  open(documentId: string, file: string): OpenResult {
    const existing = this.docs.get(documentId);
    if (existing) return { html: existing.html, status: this.statusOf(documentId, false), recovered: 0, conflicts: [] };

    const diskText = readFileSync(file, "utf8");
    const diskHash = hash(diskText);
    const doc: Document = {
      file,
      html: diskText,
      revision: 1,
      diskHash,
      readOnly: false,
      undo: [],
      redo: [],
      touched: [],
      pending: [],
      lastExternalRevision: 0,
      results: new Map(),
      timer: null,
      journalBase: null,
    };
    this.docs.set(documentId, doc);
    this.loadHistory(documentId, doc);

    const before = doc.pending.length;
    const conflicts = this.recover(documentId, doc);
    const recovered = doc.pending.length - before;
    return { html: doc.html, status: this.statusOf(documentId, true), recovered, conflicts };
  }

  mutate(mutation: DesignMutation): MutationResult {
    const doc = this.docs.get(mutation.documentId);
    if (!doc) return this.fail(mutation.operationId, "invalid", 0);

    const known = doc.results.get(mutation.operationId);
    if (known) return known;

    if (doc.readOnly) return this.fail(mutation.operationId, "read-only", doc.revision);

    const base = mutation.baseRevision;
    if (base !== doc.revision) {
      if (base > doc.revision) return this.fail(mutation.operationId, "stale", doc.revision);
      if (base < doc.lastExternalRevision) return this.fail(mutation.operationId, "external-change", doc.revision);
      if (!("id" in mutation.target)) return this.fail(mutation.operationId, "stale", doc.revision);
      if (this.overlaps(doc, mutation, base)) return this.fail(mutation.operationId, "stale", doc.revision);
    }

    const before = doc.html;
    let outcome: EditOutcome;
    // Every id this call generates is journaled in order, so a replay lands on the same bytes.
    const ids: string[] = [];
    const capture = (): string => {
      const id = this.newId();
      ids.push(id);
      return id;
    };
    try {
      outcome = applyChange(before, mutation.target, mutation.change, capture);
    } catch (error) {
      if (error instanceof SourceEditError) return this.fail(mutation.operationId, error.reason, doc.revision, error.message);
      return this.fail(mutation.operationId, "invalid", doc.revision, messageOf(error));
    }

    if (outcome.html === before) {
      const unchanged: MutationResult = { ok: true, operationId: mutation.operationId, newRevision: doc.revision };
      this.remember(doc, unchanged);
      return unchanged;
    }

    const patch = diffPatch(before, outcome.html);
    const entry = this.entryOf(mutation, ids, patch, "mutate");
    if (!this.appendJournal(mutation.documentId, doc, entry)) {
      return this.fail(mutation.operationId, "invalid", doc.revision, "Couldn't save this edit");
    }

    doc.journalBase = doc.diskHash;
    const after = outcome.html;
    doc.html = after;
    doc.revision += 1;
    const keys = keysOf(mutation.change);
    for (const key of keys) doc.touched.push({ id: outcome.targetId, key, revision: doc.revision });
    this.pruneTouched(doc);
    doc.pending.push(entry);
    this.addToGroup(doc, mutation.transactionId, patch, outcome.targetId);
    doc.redo = [];
    this.schedule(mutation.documentId, doc);

    const result: MutationResult = {
      ok: true,
      operationId: mutation.operationId,
      newRevision: doc.revision,
      ...(outcome.stampedId !== undefined ? { stampedId: outcome.stampedId } : {}),
      ...(outcome.createdIds !== undefined ? { createdIds: outcome.createdIds } : {}),
    };
    this.remember(doc, result);
    this.report(mutation.documentId);
    return result;
  }

  undo(documentId: string, options?: { crossBoundary?: boolean }): MutationResult {
    const doc = this.docs.get(documentId);
    if (!doc) return this.fail(`undo-0`, "invalid", 0);
    if (doc.readOnly) return this.fail(`undo-${doc.revision}`, "read-only", doc.revision);

    const top = doc.undo[doc.undo.length - 1];
    const crossing = isBoundary(top);
    if (crossing && options?.crossBoundary !== true) {
      return this.fail(`undo-${doc.revision}`, "external-change", doc.revision, "The page changed on disk; undo past it first.");
    }
    const group = crossing ? doc.undo[doc.undo.length - 2] : top;
    if (!isGroup(group)) return this.fail(`undo-${doc.revision}`, "invalid", doc.revision, "Nothing to undo");

    let next: string;
    try {
      next = this.applyAll(doc.html, group.patches, true);
    } catch {
      // The text the group expected is gone, and every older group's offsets assumed this one undid first.
      doc.undo = [];
      return this.fail(`undo-${doc.revision}`, "stale", doc.revision, "The page changed; that undo no longer applies.");
    }

    const revision = doc.revision + 1;
    const operationId = `undo-${revision}`;
    const entry = this.groupEntry(operationId, group, doc.html, next, "undo", true);
    if (!this.appendJournal(documentId, doc, entry)) {
      return this.fail(operationId, "invalid", doc.revision, "Couldn't save this edit");
    }

    doc.journalBase = doc.diskHash;
    doc.html = next;
    doc.revision = revision;
    for (const id of group.touched) doc.touched.push({ id, key: "*", revision });
    this.pruneTouched(doc);
    doc.pending.push(entry);
    this.removeItem(doc.undo, group);
    if (crossing) doc.undo.pop();
    doc.redo.push(group);
    this.schedule(documentId, doc);

    const result: MutationResult = { ok: true, operationId, newRevision: revision };
    this.remember(doc, result);
    this.report(documentId);
    return result;
  }

  redo(documentId: string): MutationResult {
    const doc = this.docs.get(documentId);
    if (!doc) return this.fail(`redo-0`, "invalid", 0);
    if (doc.readOnly) return this.fail(`redo-${doc.revision}`, "read-only", doc.revision);

    const top = doc.redo[doc.redo.length - 1];
    if (!isGroup(top)) return this.fail(`redo-${doc.revision}`, "invalid", doc.revision, "Nothing to redo");

    const group = top;
    let next: string;
    try {
      next = this.applyAll(doc.html, group.patches, false);
    } catch {
      doc.redo = [];
      return this.fail(`redo-${doc.revision}`, "stale", doc.revision, "The page changed; that redo no longer applies.");
    }

    const revision = doc.revision + 1;
    const operationId = `redo-${revision}`;
    const entry = this.groupEntry(operationId, group, doc.html, next, "redo", false);
    if (!this.appendJournal(documentId, doc, entry)) {
      return this.fail(operationId, "invalid", doc.revision, "Couldn't save this edit");
    }

    doc.journalBase = doc.diskHash;
    doc.html = next;
    doc.revision = revision;
    for (const id of group.touched) doc.touched.push({ id, key: "*", revision });
    this.pruneTouched(doc);
    doc.pending.push(entry);
    this.removeItem(doc.redo, group);
    doc.undo.push(group);
    this.schedule(documentId, doc);

    const result: MutationResult = { ok: true, operationId, newRevision: revision };
    this.remember(doc, result);
    this.report(documentId);
    return result;
  }

  closeTransaction(documentId: string, transactionId: string): void {
    const doc = this.docs.get(documentId);
    if (!doc) return;
    const top = doc.undo[doc.undo.length - 1];
    if (!isGroup(top) || top.transactionId !== transactionId) return;
    // Sealing the group keeps later edits out of it; only an external change puts a boundary on the stack.
    top.closed = true;
    this.report(documentId);
  }

  setReadOnly(documentId: string, readOnly: boolean): void {
    const doc = this.docs.get(documentId);
    if (!doc || doc.readOnly === readOnly) return;
    doc.readOnly = readOnly;
    this.report(documentId);
  }

  noteDiskChange(documentId: string): DiskChange {
    const doc = this.docs.get(documentId);
    if (!doc) return { changed: false, conflicts: [] };
    return this.detectDiskChange(documentId, doc);
  }

  html(documentId: string): string | null {
    return this.docs.get(documentId)?.html ?? null;
  }

  status(documentId: string): DocumentStatus | null {
    if (!this.docs.has(documentId)) return null;
    return this.statusOf(documentId, true);
  }

  flush(documentId?: string): boolean {
    if (documentId !== undefined) {
      const doc = this.docs.get(documentId);
      if (!doc) return true;
      cancelTimer(doc);
      return this.save(documentId, doc);
    }
    let allSaved = true;
    for (const [id, doc] of this.docs) {
      cancelTimer(doc);
      if (!this.save(id, doc)) allSaved = false;
    }
    return allSaved;
  }

  close(documentId: string): boolean {
    const doc = this.docs.get(documentId);
    if (!doc) return true;
    cancelTimer(doc);
    if (!this.save(documentId, doc)) return false;
    this.docs.delete(documentId);
    this.failed.delete(documentId);
    return true;
  }

  dispose(): void {
    for (const [id, doc] of [...this.docs]) {
      cancelTimer(doc);
      try {
        this.save(id, doc);
      } catch {
        // Disposal must never throw; anything unsaved stays in the journal.
      }
    }
    this.docs.clear();
    this.failed.clear();
  }

  // --- opening and recovery ------------------------------------------------------------------------

  /** Load the saved undo history when the disk still holds the text it was written against. */
  private loadHistory(documentId: string, doc: Document): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.historyPath(documentId), "utf8"));
    } catch {
      return;
    }
    const record = parsed as { hash?: unknown; undo?: unknown; redo?: unknown } | null;
    if (typeof record !== "object" || record === null || record.hash !== doc.diskHash) return;
    const undo = sanitizeStack(record.undo);
    const redo = sanitizeStack(record.redo);
    // Anything ahead of an external boundary can no longer be replayed against today's disk.
    if (undo) doc.undo = undo.slice(lastBoundaryIndex(undo) + 1);
    if (redo) doc.redo = redo;
  }

  /** Replay the journal onto the disk text; returns the conflicts it found. */
  private recover(documentId: string, doc: Document): MutationConflict[] {
    const path = this.journalPath(documentId);
    if (!existsSync(path)) return [];

    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return [];
    }
    const parsed = parseLines(text);
    const header = parsed?.header;
    if (!parsed || !isHeader(header)) {
      this.deleteJournal(documentId, doc);
      return [];
    }

    const conflicts: MutationConflict[] = [];
    const replayed: JournalEntry[] = [];
    const diskHash = doc.diskHash;
    // Whatever the journal says, from here on it describes this disk text.
    doc.journalBase = diskHash;

    if (header.baseHash === diskHash) {
      let current = doc.html;
      let broken = false;
      for (const entry of parsed.entries) {
        // Each patch's offsets assume the one before it landed, so nothing after a failure can apply.
        if (broken) {
          conflicts.push({ operationId: entry.operationId, message: "An earlier edit couldn't be replayed." });
          continue;
        }
        try {
          current = applyPatch(current, entry.patch);
          replayed.push(entry);
        } catch (error) {
          broken = true;
          conflicts.push({ operationId: entry.operationId, message: messageOf(error) });
        }
      }
      doc.html = current;
    } else {
      if (alreadySaved(doc.html, parsed.entries, header.baseHash)) {
        // The crash came between the save and the journal's removal: replaying would apply it all twice.
        this.deleteJournal(documentId, doc);
        return [];
      }
      let current = doc.html;
      for (const entry of parsed.entries) {
        if (entry.op !== "mutate") {
          conflicts.push({ operationId: entry.operationId, message: "An undo couldn't be replayed." });
          continue;
        }
        const replay = replayIds(entry.ids ?? [], this.newId);
        try {
          const next = applyChange(current, entry.target, entry.change, replay);
          // The patch must describe today's text: it is what the journal and the undo group store.
          replayed.push({ ...entry, patch: diffPatch(current, next.html) });
          current = next.html;
        } catch (error) {
          conflicts.push({ operationId: entry.operationId, message: messageOf(error) });
        }
      }
      doc.html = current;
      doc.undo = [];
      doc.redo = [];
      doc.lastExternalRevision = doc.revision;
    }

    if (replayed.length === 0) {
      if (doc.pending.length === 0) this.deleteJournal(documentId, doc);
      return conflicts;
    }

    doc.pending = replayed;
    doc.undo.push(this.groupOf(replayed));
    this.trimUndo(doc);
    // A saved redo stack describes the disk's text, which the replay just moved past.
    doc.redo = [];
    doc.revision += 1;
    // The old lines may describe another text or end in a torn write that would swallow the next append.
    this.rewriteJournal(documentId, doc);
    this.schedule(documentId, doc);
    return conflicts;
  }

  // --- saving --------------------------------------------------------------------------------------

  /** Write the held text to disk, first absorbing any outside edit; true when nothing is left unsaved. */
  private save(documentId: string, doc: Document): boolean {
    this.failed.delete(documentId);

    if (doc.pending.length > 0 && !this.syncWithDisk(documentId, doc)) {
      // The disk moved and nothing held could be replayed onto it: that work is gone, not overwritten.
      doc.pending = [];
      this.deleteJournal(documentId, doc);
      if (doc.timer === null) this.report(documentId);
      return true;
    }
    if (doc.pending.length === 0) {
      if (doc.timer === null) this.report(documentId);
      return true;
    }
    cancelTimer(doc);

    this.report(documentId);
    try {
      writeAtomic(doc.file, doc.html, () => randomHex(8));
    } catch {
      this.failed.add(documentId);
      this.report(documentId);
      return false;
    }

    doc.diskHash = hash(doc.html);
    doc.pending = [];
    this.deleteJournal(documentId, doc);
    try {
      this.writeHistory(documentId, doc);
    } catch {
      // History is an optimisation: losing it costs a reopen's undo stack, not the page.
    }
    this.onSaved?.(documentId, doc.file);
    this.report(documentId);
    return true;
  }

  /**
   * Read the file again before writing. When it changed, bring the held text forward; returns whether any
   * pending work is left to save.
   */
  private syncWithDisk(documentId: string, doc: Document): boolean {
    if (!existsSync(doc.file)) return doc.pending.length > 0;
    let diskText: string;
    try {
      diskText = readFileSync(doc.file, "utf8");
    } catch {
      return doc.pending.length > 0;
    }
    if (hash(diskText) === doc.diskHash) return doc.pending.length > 0;
    this.detectDiskChange(documentId, doc, diskText);
    return doc.pending.length > 0;
  }

  private schedule(documentId: string, doc: Document): void {
    cancelTimer(doc);
    this.report(documentId);
    if (doc.pending.length === 0) return;
    const timer = setTimeout((): void => {
      doc.timer = null;
      this.save(documentId, doc);
    }, this.debounceMs);
    timer.unref?.();
    doc.timer = timer;
  }

  /** The journal and history sit beside each other under the service's journal directory. */
  private journalPath(documentId: string): string {
    return join(this.journalDir, `${documentId}.wal`);
  }

  private historyPath(documentId: string): string {
    return join(this.journalDir, `${documentId}.history.json`);
  }

  private appendJournal(documentId: string, doc: Document, entry: JournalEntry): boolean {
    mkdirSync(this.journalDir, { recursive: true });
    const path = this.journalPath(documentId);
    const line = `${JSON.stringify(entry)}\n`;
    try {
      if (doc.journalBase === doc.diskHash) {
        writeDurable(path, line, "a");
        return true;
      }
      // Nothing of ours is on disk, or the old journal outlived its disk: (re)seat it, keeping what is held.
      const header: JournalHeader = { v: 1, documentId, baseHash: doc.diskHash };
      const lines = [JSON.stringify(header), ...doc.pending.map((held) => JSON.stringify(held))];
      writeDurable(path, `${lines.join("\n")}\n${line}`);
      return true;
    } catch {
      return false;
    }
  }

  private rewriteJournal(documentId: string, doc: Document): void {
    try {
      if (doc.pending.length === 0) {
        this.deleteJournal(documentId, doc);
        return;
      }
      const header: JournalHeader = { v: 1, documentId, baseHash: doc.diskHash };
      const lines = [JSON.stringify(header), ...doc.pending.map((entry) => JSON.stringify(entry))];
      writeAtomic(this.journalPath(documentId), `${lines.join("\n")}\n`, () => randomHex(8));
      doc.journalBase = doc.diskHash;
    } catch {
      // A journal that cannot be rewritten is still the old one; the next append reseats it.
    }
  }

  private deleteJournal(documentId: string, doc: Document): void {
    try {
      rmSync(this.journalPath(documentId), { force: true });
    } catch {
      // The file may survive; with no base recorded, the next append overwrites it instead of adding to it.
    }
    doc.journalBase = null;
  }

  private writeHistory(documentId: string, doc: Document): void {
    const path = this.historyPath(documentId);
    const body = JSON.stringify({ hash: doc.diskHash, undo: doc.undo, redo: doc.redo });
    if (body.length > MAX_HISTORY_BYTES) {
      try {
        rmSync(path, { force: true });
      } catch {
        // Falling back to no history is correct however the delete goes.
      }
      return;
    }
    writeAtomic(path, body, () => randomHex(8));
  }

  // --- external changes and conflicts --------------------------------------------------------------

  /** Take the file's current text when it moved under us, rebasing pending work where it still fits. */
  private detectDiskChange(documentId: string, doc: Document, already?: string): DiskChange {
    let diskText: string;
    if (already !== undefined) {
      diskText = already;
    } else {
      if (!existsSync(doc.file)) return { changed: false, conflicts: [] };
      try {
        diskText = readFileSync(doc.file, "utf8");
      } catch {
        return { changed: false, conflicts: [] };
      }
    }

    const diskHash = hash(diskText);
    if (diskHash === doc.diskHash) return { changed: false, conflicts: [] };

    const conflicts: MutationConflict[] = [];
    const reapplied: JournalEntry[] = [];
    // Our owned text once the surviving edits are laid back on top of the disk's.
    let text = diskText;
    for (const entry of doc.pending) {
      if (entry.op !== "mutate") {
        conflicts.push({ operationId: entry.operationId, message: "An undo couldn't be replayed." });
        continue;
      }
      const replay = replayIds(entry.ids ?? [], this.newId);
      try {
        const outcome = applyChange(text, entry.target, entry.change, replay);
        reapplied.push({ ...entry, patch: diffPatch(text, outcome.html) });
        text = outcome.html;
      } catch (error) {
        conflicts.push({ operationId: entry.operationId, message: messageOf(error) });
      }
    }

    // The undo patches' offsets describe the old text: carry them through the change, or drop what it overlaps.
    doc.undo = rebaseStack(doc.undo, diffPatch(doc.html, text));
    // What we hold is the disk's text with every edit that still fits carried forward.
    doc.html = text;
    doc.revision += 1;
    doc.lastExternalRevision = doc.revision;
    if (doc.undo.length > 0 && !isBoundary(doc.undo[doc.undo.length - 1])) doc.undo.push({ boundary: true });
    doc.redo = [];
    doc.diskHash = diskHash;
    doc.pending = reapplied;

    if (reapplied.length > 0) {
      this.rewriteJournal(documentId, doc);
      this.schedule(documentId, doc);
    } else {
      this.deleteJournal(documentId, doc);
    }
    this.report(documentId);
    if (conflicts.length > 0) this.onConflicts?.(documentId, conflicts);
    return { changed: true, conflicts };
  }

  /** True when a mutation based on an older revision collides with an edit accepted since. */
  private overlaps(doc: Document, mutation: DesignMutation, base: number): boolean {
    const keys = keysOf(mutation.change);
    const target = "id" in mutation.target ? mutation.target.id : null;
    for (const entry of doc.touched) {
      if (entry.revision <= base || entry.id !== target) continue;
      for (const key of keys) {
        if (key === "*" || entry.key === "*" || entry.key === key) return true;
      }
    }
    return false;
  }

  // --- history bookkeeping -------------------------------------------------------------------------

  private addToGroup(doc: Document, transactionId: string, patch: TextPatch, touchedId: string): void {
    const top = doc.undo[doc.undo.length - 1];
    if (
      isGroup(top) &&
      !top.closed &&
      top.transactionId === transactionId &&
      this.now() - top.lastAt <= this.idleMs
    ) {
      top.patches.push(patch);
      top.lastAt = this.now();
      if (!top.touched.includes(touchedId)) top.touched.push(touchedId);
      return;
    }
    doc.undo.push({ transactionId, lastAt: this.now(), patches: [patch], touched: [touchedId] });
    this.trimUndo(doc);
  }

  private trimUndo(doc: Document): void {
    while (doc.undo.length > MAX_UNDO) doc.undo.shift();
  }

  private removeItem(stack: StackItem[], item: StackItem): void {
    const at = stack.lastIndexOf(item);
    if (at >= 0) stack.splice(at, 1);
  }

  /** Apply a group's patches newest first (undo) or oldest first (redo), returning the new text. */
  private applyAll(html: string, patches: TextPatch[], newestFirst: boolean): string {
    let text = html;
    const ordered = newestFirst ? [...patches].reverse() : patches;
    for (const patch of ordered) text = applyPatch(text, newestFirst ? invertPatch(patch) : patch);
    return text;
  }

  private entryOf(mutation: DesignMutation, ids: string[], patch: TextPatch, op: JournalEntry["op"]): JournalEntry {
    return {
      operationId: mutation.operationId,
      transactionId: mutation.transactionId,
      target: mutation.target,
      change: mutation.change,
      ids,
      patch,
      op,
    };
  }

  private groupEntry(
    operationId: string,
    group: UndoGroup,
    before: string,
    after: string,
    op: "undo" | "redo",
    newestFirst: boolean,
  ): JournalEntry {
    const ordered = newestFirst ? [...group.patches].reverse() : group.patches;
    const patches = ordered.map((patch) => (newestFirst ? invertPatch(patch) : patch));
    // A journal entry needs a target and a change, but an undo or redo is replayed from its patch alone.
    const target: DesignMutation["target"] = { id: group.touched[0] ?? "group" };
    return {
      operationId,
      transactionId: group.transactionId,
      target,
      change: { kind: "remove" },
      ids: [...group.touched],
      patch: diffPatch(before, after),
      op,
      patches,
    };
  }

  private groupOf(entries: JournalEntry[]): UndoGroup {
    const first = entries[0];
    const touched: string[] = [];
    for (const entry of entries) {
      const target = entry.target;
      // An undo of a replayed edit is a `*` touch on whatever element it changed.
      const id = "id" in target ? target.id : (entry.ids?.[0] ?? target.locator.tag);
      if (!touched.includes(id)) touched.push(id);
    }
    return {
      transactionId: first?.transactionId ?? "",
      lastAt: this.now(),
      patches: entries.map((entry) => entry.patch),
      touched,
    };
  }

  private remember(doc: Document, result: MutationResult): void {
    doc.results.set(result.operationId, result);
    while (doc.results.size > MAX_RESULTS) {
      const oldest = doc.results.keys().next();
      if (oldest.done) break;
      doc.results.delete(oldest.value);
    }
  }

  private pruneTouched(doc: Document): void {
    if (doc.touched.length > 1000) doc.touched = doc.touched.slice(-500);
  }

  // --- results -------------------------------------------------------------------------------------

  private fail(operationId: string, reason: MutationFailure, currentRevision: number, message?: string): MutationResult {
    return { ok: false, operationId, reason, currentRevision, ...(message !== undefined ? { message } : {}) };
  }

  private statusOf(documentId: string, report: boolean): DocumentStatus {
    const doc = this.docs.get(documentId);
    if (!doc) {
      return {
        documentId,
        revision: 0,
        save: "saved",
        canUndo: false,
        canRedo: false,
        atExternalBoundary: false,
        readOnly: true,
      };
    }
    const status: DocumentStatus = {
      documentId,
      revision: doc.revision,
      save: this.saveStateOf(documentId, doc),
      canUndo: doc.undo.some((item) => isGroup(item)),
      canRedo: doc.redo.some((item) => isGroup(item)),
      atExternalBoundary: isBoundary(doc.undo[doc.undo.length - 1]) && doc.undo.some((item) => isGroup(item)),
      readOnly: doc.readOnly,
    };
    if (report) this.onStatus?.(status);
    return status;
  }

  private saveStateOf(documentId: string, doc: Document): SaveState {
    if (this.failed.has(documentId)) return "not-saved";
    if (doc.timer !== null || doc.pending.length > 0) return "saving";
    return "saved";
  }

  private report(documentId: string): void {
    if (!this.docs.has(documentId)) return;
    this.statusOf(documentId, true);
  }
}

function cancelTimer(doc: Document): void {
  if (doc.timer === null) return;
  clearTimeout(doc.timer);
  doc.timer = null;
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function randomHex(chars: number): string {
  const bytes = new Uint8Array(Math.ceil(chars / 2));
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex.slice(0, chars);
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** True when undoing every journaled patch from the disk text lands on the journal's base: the save happened. */
function alreadySaved(diskText: string, entries: JournalEntry[], baseHash: string): boolean {
  let text = diskText;
  try {
    for (const entry of [...entries].reverse()) text = applyPatch(text, invertPatch(entry.patch));
  } catch {
    return false;
  }
  return entries.length > 0 && hash(text) === baseHash;
}

/** Swap "`first`, then `later`" so `later` happens first; null when the two touch the same text. */
function commute(first: TextPatch, later: TextPatch): { first: TextPatch; later: TextPatch } | null {
  if (later.start + later.removed.length <= first.start) {
    return { later, first: { ...first, start: first.start + later.inserted.length - later.removed.length } };
  }
  if (later.start >= first.start + first.inserted.length) {
    return { first, later: { ...later, start: later.start - first.inserted.length + first.removed.length } };
  }
  return null;
}

/**
 * Carry an undo stack through a change made after its newest patch, so each patch's offsets hold on the new
 * text. A group the change touched can't be undone, and neither can anything older, so those are dropped.
 */
function rebaseStack(stack: StackItem[], change: TextPatch): StackItem[] {
  if (change.removed === "" && change.inserted === "") return stack;
  let later = change;
  const kept: StackItem[] = [];
  for (let i = stack.length - 1; i >= 0; i--) {
    const item = stack[i];
    if (!isGroup(item)) {
      if (item) kept.unshift(item);
      continue;
    }
    const patches: TextPatch[] = [];
    for (let at = item.patches.length - 1; at >= 0; at--) {
      const patch = item.patches[at];
      const swapped = patch ? commute(patch, later) : null;
      if (!swapped) return kept;
      later = swapped.later;
      patches.unshift(swapped.first);
    }
    kept.unshift({ ...item, patches });
  }
  return kept;
}

/** The index of the last boundary in a stack, or -1 when there is none. */
function lastBoundaryIndex(stack: StackItem[]): number {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (isBoundary(stack[i])) return i;
  }
  return -1;
}

/** Read a persisted stack back, dropping anything that does not have the shape a group needs. */
function sanitizeStack(value: unknown): StackItem[] | null {
  if (!Array.isArray(value)) return null;
  const out: StackItem[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    if ((item as { boundary?: unknown }).boundary === true) {
      out.push({ boundary: true });
      continue;
    }
    const group = item as { transactionId?: unknown; lastAt?: unknown; patches?: unknown; touched?: unknown };
    if (typeof group.transactionId !== "string" || !Array.isArray(group.patches)) continue;
    const patches: TextPatch[] = [];
    let whole = true;
    for (const patch of group.patches) {
      if (!isTextPatch(patch)) {
        whole = false;
        break;
      }
      patches.push(patch);
    }
    if (!whole) continue;
    out.push({
      transactionId: group.transactionId,
      lastAt: typeof group.lastAt === "number" ? group.lastAt : 0,
      patches,
      touched: Array.isArray(group.touched) ? group.touched.filter((id): id is string => typeof id === "string") : [],
      closed: true,
    });
  }
  return out;
}

function isTextPatch(value: unknown): value is TextPatch {
  const patch = value as Partial<TextPatch> | null;
  return (
    typeof patch === "object" &&
    patch !== null &&
    typeof patch.start === "number" &&
    typeof patch.removed === "string" &&
    typeof patch.inserted === "string"
  );
}
