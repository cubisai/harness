// Comments pinned to elements of a design page: pure, dependency-free, safe in node and the page.

/** The most comments a design folder may hold. */
export const MAX_COMMENTS = 100;

/** The longest a comment's text may be. */
export const MAX_COMMENT_CHARS = 1000;

/** Where a comment is pinned: its element's data-agent-id (when any), CSS selector, tag and text. */
export interface CommentTarget {
  id?: string;
  selector: string;
  tag: string;
  text: string;
}

/** One comment a user pinned to an element of a design page. */
export interface DesignComment {
  id: string;
  page: string;
  target: CommentTarget;
  label: string;
  text: string;
  createdAt: number;
  sentAt?: number;
  resolved?: boolean;
}

const AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const COMMENT_ID_RE = /^[a-z0-9-]{1,40}$/i;
const PAGE_RE = /\.html?$/i;

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const asRecord = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const inRange = (v: unknown, min: number, max: number): v is string => typeof v === "string" && v.length >= min && v.length <= max;

const isPage = (v: unknown): v is string => {
  if (!inRange(v, 1, 200)) return false;
  if (v.startsWith("/") || v.includes("\\") || !PAGE_RE.test(v)) return false;
  return !v.split("/").includes("..");
};

/** Validates one element target; returns a fresh object, or null when malformed. */
export function readTarget(raw: unknown): CommentTarget | null {
  const e = asRecord(raw);
  if (!e) return null;
  const selector = e.selector;
  const tag = e.tag;
  const text = e.text;
  if (!inRange(selector, 1, 2000)) return null;
  if (!inRange(tag, 1, 64)) return null;
  if (typeof text !== "string" || text.length > 300) return null;
  const out: CommentTarget = { selector, tag, text };
  const id = e.id;
  if (id !== undefined) {
    if (typeof id !== "string" || !AGENT_ID_RE.test(id)) return null;
    out.id = id;
  }
  return out;
}

/** Validates one comment; returns a fresh object with only its fields, or null when malformed. */
export function readComment(raw: unknown): DesignComment | null {
  const e = asRecord(raw);
  if (!e) return null;
  const id = e.id;
  const page = e.page;
  const label = e.label;
  const text = e.text;
  if (typeof id !== "string" || !COMMENT_ID_RE.test(id)) return null;
  if (!isPage(page)) return null;
  const target = readTarget(e.target);
  if (!target) return null;
  if (!inRange(label, 1, 80)) return null;
  if (!inRange(text, 1, MAX_COMMENT_CHARS)) return null;
  if (!isFiniteNumber(e.createdAt)) return null;
  const out: DesignComment = { id, page, target, label, text, createdAt: e.createdAt };
  const sentAt = e.sentAt;
  const resolved = e.resolved;
  if (sentAt !== undefined) {
    if (!isFiniteNumber(sentAt)) return null;
    out.sentAt = sentAt;
  }
  if (resolved !== undefined) {
    if (typeof resolved !== "boolean") return null;
    out.resolved = resolved;
  }
  return out;
}

/** Reads a comment list; never throws, drops malformed entries and duplicates, keeps the last MAX_COMMENTS. */
export function readComments(raw: unknown): DesignComment[] {
  if (!Array.isArray(raw)) return [];
  const out: DesignComment[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const comment = readComment(entry);
    if (!comment || seen.has(comment.id)) continue;
    seen.add(comment.id);
    out.push(comment);
  }
  return out.length > MAX_COMMENTS ? out.slice(-MAX_COMMENTS) : out;
}

/** The message sent to the agent describing a page's open comments, or "" when there are none. */
export function commentsMessage(page: string, comments: DesignComment[]): string {
  if (comments.length === 0) return "";
  const lines = [`Address these comments on ${page}. Change only what each one is about; if one needs bigger changes, say so instead.`];
  comments.forEach((c, i) => {
    const id = c.target.id ? ` data-agent-id="${c.target.id}"` : "";
    const text = c.target.text ? ` · text "${c.target.text.slice(0, 80)}${c.target.text.length > 80 ? "…" : ""}"` : "";
    lines.push(`${i + 1}. <${c.target.tag}>${id} · selector \`${c.target.selector}\`${text}: ${c.text}`);
  });
  return lines.join("\n");
}
