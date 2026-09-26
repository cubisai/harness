import { createHash } from "node:crypto";
import type { StoredEvent, Thread, ThreadExport } from "../shared/types";
import { blobRefOf, type Store } from "./db";

/**
 * Thread export/import: the rollback path for the bindings migration, and
 * how a thread moves to another machine. Later, the handoff checkpoint.
 */

export const THREAD_EXPORT_VERSION = 1;

export function exportThread(store: Store, threadId: string): ThreadExport {
  const thread = store.getThread(threadId);
  const events = store.listEvents(threadId);
  const blobs: Record<string, string> = {};
  for (const { event } of events) {
    const ref = blobRefOf(event);
    if (ref && !(ref.sha256 in blobs)) blobs[ref.sha256] = store.readBlob(ref.sha256);
  }
  return { schemaVersion: THREAD_EXPORT_VERSION, exportedAt: Date.now(), thread, events, blobs };
}

/** Restore an export as a new thread in `projectId`. Everything is checked before anything is written. */
export function importThread(store: Store, projectId: string, data: unknown): Thread {
  const { thread, events, blobs } = validateExport(data);
  store.getProject(projectId);
  for (const [sha, content] of Object.entries(blobs)) store.writeBlob(sha, content);
  return store.restoreThread(projectId, { thread, events });
}

function validateExport(data: unknown): ThreadExport {
  if (!isObject(data)) throw new Error("This file isn't a thread export.");
  const version = data.schemaVersion;
  if (version !== THREAD_EXPORT_VERSION) {
    const which = typeof version === "number" ? `schema version ${version}` : "an unknown schema version";
    throw new Error(`This export is ${which}; this version of the app reads schema version ${THREAD_EXPORT_VERSION}.`);
  }
  const { thread, events, blobs } = data;
  if (
    !isObject(thread) ||
    typeof thread.agent !== "string" ||
    typeof thread.title !== "string" ||
    typeof thread.model !== "string" ||
    typeof thread.permissionMode !== "string"
  ) {
    throw new Error("The export's thread is incomplete.");
  }
  if (!Array.isArray(events) || !events.every((e) => isObject(e) && typeof e.seq === "number" && isObject(e.event) && typeof e.event.kind === "string")) {
    throw new Error("The export's events are incomplete.");
  }
  if (!isObject(blobs) || !Object.values(blobs).every((b) => typeof b === "string")) {
    throw new Error("The export's attached tool outputs are unreadable.");
  }
  for (const stored of events as StoredEvent[]) {
    const ref = blobRefOf(stored.event);
    if (!ref) continue;
    const content = blobs[ref.sha256];
    if (typeof content !== "string") throw new Error(`The export is missing an attached tool output (${ref.sha256}).`);
    if (createHash("sha256").update(content).digest("hex") !== ref.sha256) {
      throw new Error(`An attached tool output in the export is corrupted (${ref.sha256}).`);
    }
  }
  return data as unknown as ThreadExport;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
