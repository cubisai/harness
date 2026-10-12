import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  MAX_COMMENTS,
  MAX_COMMENT_CHARS,
  readComment,
  readComments,
  type CommentTarget,
  type DesignComment,
} from "../../shared/comments";

/** The name of the file a design folder keeps its comments in. */
export const COMMENTS_FILE = "comments.json";

/** Reads a design folder's comments; a missing, unreadable or malformed file reads as none. */
export function loadComments(root: string): DesignComment[] {
  const file = join(root, COMMENTS_FILE);
  if (!existsSync(file)) return [];
  try {
    return readComments(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return [];
  }
}

/** Writes a design folder's comments, making the folder when needed. */
export function saveComments(root: string, list: DesignComment[]): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, COMMENTS_FILE), JSON.stringify(list, null, 2) + "\n", "utf8");
}

/** Adds a comment, trimming its text and rejecting empty, oversized, excessive or malformed input. */
export function addComment(
  list: DesignComment[],
  input: { page: string; target: CommentTarget; label: string; text: string },
  now = Date.now(),
  newId: () => string = () => randomUUID(),
): DesignComment[] {
  const text = input.text.trim();
  if (text.length === 0) throw new Error("Write a comment first.");
  if (text.length > MAX_COMMENT_CHARS) throw new Error("That comment is too long.");
  if (list.length >= MAX_COMMENTS) throw new Error("Too many comments; resolve or delete some first.");
  const comment: DesignComment = { id: newId(), page: input.page, target: input.target, label: input.label, text, createdAt: now };
  if (!readComment(comment)) throw new Error("Bad comment.");
  return [...list, comment];
}

/** Applies a resolve or send patch to a comment; returns a new list and never mutates the old one. */
export function updateComment(list: DesignComment[], id: string, patch: { resolved?: boolean; sent?: boolean }, now = Date.now()): DesignComment[] {
  if (!list.some((c) => c.id === id)) throw new Error("No such comment.");
  return list.map((c) => {
    if (c.id !== id) return c;
    const next: DesignComment = { ...c };
    if (patch.resolved !== undefined) {
      if (patch.resolved) next.resolved = true;
      else delete next.resolved;
    }
    if (patch.sent) next.sentAt = now;
    return next;
  });
}

/** Removes a comment by id; returns a new list and never mutates the old one. */
export function deleteComment(list: DesignComment[], id: string): DesignComment[] {
  if (!list.some((c) => c.id === id)) throw new Error("No such comment.");
  return list.filter((c) => c.id !== id);
}
