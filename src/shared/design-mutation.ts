// The wire shape of a design mutation: one operation against one element of one design page, the
// locator that names the element when it has no id yet, and the result the main process reports back.

/** Where inserted or moved content lands relative to its target element. */
export type InsertPosition = "before" | "after" | "inside-start" | "inside-end";

/** The one edit a mutation asks for. Each is applied as a splice, never a re-serialization. */
export type DesignChange =
  /** Set an attribute (`null` removes it). */
  | { kind: "setProp"; name: string; value: string | null }
  /** Update inline style declarations (an empty value removes the declaration). */
  | { kind: "setStyle"; changes: { prop: string; value: string }[] }
  /** Replace an element's text, given as it reads before the edit. */
  | { kind: "setText"; before: string; after: string }
  /** Insert parsed HTML at a position around the target. */
  | { kind: "insert"; html: string; position: InsertPosition }
  /** Remove the target element. */
  | { kind: "remove" }
  /** Move another element's source next to the target. */
  | { kind: "move"; refId: string; position: InsertPosition }
  /** Wrap the target and its extra siblings in a new container. */
  | { kind: "wrap"; extraIds: string[]; tag: string; attrs: Record<string, string> }
  /** Remove the target's start and end tags, keeping its content. */
  | { kind: "unwrap" }
  /** Copy the target's source to right after it, with fresh ids. */
  | { kind: "duplicate" }
  /** Rename a text element's tag (`p` to `h2`), keeping its attributes and content. Only RETAG_TAGS on both sides. */
  | { kind: "retag"; tag: string }
  /** Replace the whole page's text, as one step. Main-process only: never accepted over IPC (`parseChange` refuses it). */
  | { kind: "replaceDocument"; html: string };

/** The tags `Render as` offers, and the only ones `retag` changes from or to. */
export const RETAG_TAGS = ["p", "h1", "h2", "h3", "h4", "h5", "h6", "span", "label"] as const;

/** Names an element without an id: the tag it should be, and its element-child path from `<html>`. */
export type TargetLocator = { tag: string; path: number[]; text?: string };

/** One mutation: which document, which revision it was based on, which element, and what to change. */
export type DesignMutation = {
  operationId: string;
  documentId: string;
  baseRevision: number;
  target: { id: string } | { locator: TargetLocator };
  transactionId: string;
  change: DesignChange;
};

/** Why a mutation was refused. */
export type MutationFailure = "stale" | "ambiguous" | "invalid" | "external-change" | "read-only";

/** What happened to a mutation. */
export type MutationResult =
  | { ok: true; operationId: string; newRevision: number; stampedId?: string; createdIds?: string[] }
  | { ok: false; operationId: string; reason: MutationFailure; currentRevision: number; message?: string };

/** How the open document's text stands against the file on disk. */
export type SaveState = "saved" | "saving" | "not-saved";

/** What the canvas shows about one open document. */
export interface DocumentStatus {
  documentId: string;
  revision: number;
  save: SaveState;
  canUndo: boolean;
  canRedo: boolean;
  atExternalBoundary: boolean;
  readOnly: boolean;
}

/** One recovered or refused edit found while opening or rebasing. */
export interface MutationConflict {
  operationId: string;
  message: string;
}

/** One kit the app can offer, and whether it is on this machine. */
export type DesignKitOption = {
  id: string;
  name: string;
  version: string;
  /** Foundation ships with the app; the rest are downloaded on first use. */
  bundled: boolean;
  installed: boolean;
};

/** Why a kit couldn't be made ready, in terms the picker can word: its `Unavailable offline` and `Retry` states. */
export type DesignKitEnsureResult = { ok: true } | { ok: false; code: "unknown" | "offline" | "blocked" | "hash" | "archive" | "invalid" | "cancelled"; message: string };

/** What the canvas can ask about a document's history. */
export type DesignHistoryRequest =
  | { action: "status" }
  | { action: "undo"; crossBoundary?: boolean }
  | { action: "redo" }
  | { action: "close-transaction"; transactionId: string }
  /** Save now, not after the debounce: before the frame reloads, or as a retry after a failed save. */
  | { action: "flush" };

/** The document after a history request, plus the edits that could not be carried over since the last ask. */
export type DesignHistoryResult = {
  status: DocumentStatus;
  html: string;
  conflicts: MutationConflict[];
  result?: MutationResult;
  /** Edits a crash left in the journal, replayed and saved when this page opened; told once, since the frame may hold the older file. */
  recovered?: number;
};
