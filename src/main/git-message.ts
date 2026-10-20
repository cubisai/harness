/**
 * The commit-message prompt: a pure builder for the diff context an agent
 * gets, plus the cleanup and Co-authored-by trailer applied to its answer.
 * No I/O and no model calls, so it can be tested on its own.
 */

/** A changed file and its unified-diff patch. */
export interface CommitDiffFile {
  path: string;
  patch: string;
}

/** Everything the commit-message prompt shows the model. */
export interface CommitPromptInput {
  threadTitle: string | null;
  nameStatus: string;
  stat: string;
  files: CommitDiffFile[];
  budget?: number;
}

/** The patch characters a prompt spends before omitting the rest. */
export const DEFAULT_PATCH_BUDGET = 12_000;

const SUBJECT_LIMIT = 72;

const LOCKFILES = new Set([
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "cargo.lock",
  "poetry.lock",
  "go.sum",
  "composer.lock",
]);

/** Whether a path is a lockfile or generated output, so its diff isn't worth the prompt space. */
export function isNoisePath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  const segments = normalized.split("/");
  const base = segments.at(-1) ?? "";
  if (LOCKFILES.has(base)) return true;
  if (base.endsWith(".min.js") || base.endsWith(".min.css") || base.endsWith(".map")) return true;
  return segments.some((segment) => segment === "dist" || segment === "out" || segment === "node_modules");
}

/**
 * The diff block for a prompt: noise files named on one line, then patches
 * smallest-first until `budget` characters are spent, and every file still in
 * its original order. A patch too large for its room is cut at a line boundary.
 */
export function fitPatches(files: CommitDiffFile[], budget: number): string {
  const noise: string[] = [];
  const candidates: { file: CommitDiffFile; index: number }[] = [];
  files.forEach((file, index) => {
    if (isNoisePath(file.path)) noise.push(file.path);
    else candidates.push({ file, index });
  });

  const bySize = [...candidates].sort((a, b) => a.file.patch.length - b.file.patch.length || a.index - b.index);
  const kept = new Map<number, string>();
  let used = 0;
  let spent = false;
  for (const { file, index } of bySize) {
    if (spent) continue;
    const room = budget - used;
    if (file.patch.length <= room) {
      kept.set(index, file.patch);
      used += file.patch.length;
      continue;
    }
    const cut = cutPatch(file.patch, room);
    if (cut === null) {
      spent = true;
      continue;
    }
    kept.set(index, cut);
    spent = true;
  }

  const parts: string[] = [];
  if (noise.length > 0) parts.push(`Omitted (generated or lock files): ${noise.join(", ")}`);
  for (const { file, index } of candidates) {
    const patch = kept.get(index);
    parts.push(patch === undefined ? `${file.path}: diff omitted (budget)` : `--- ${file.path}\n${patch}`);
  }
  return parts.join("\n\n");
}

/** The longest prefix of `patch` (plus its cut marker) that fits in `room`, or null when even the marker doesn't. */
function cutPatch(patch: string, room: number): string | null {
  if (room <= 0) return null;
  const lines = patch.split("\n");
  if (lines.at(-1) === "") lines.pop();
  let prefix = "";
  let best: string | null = null;
  for (let keep = 0; keep < lines.length; keep++) {
    if (keep > 0) prefix += (keep === 1 ? "" : "\n") + lines[keep - 1];
    if (prefix.length >= room) break;
    const marker = `… (${lines.length - keep} more lines cut)`;
    const text = prefix ? `${prefix}\n${marker}` : marker;
    if (text.length <= room) best = text;
  }
  return best;
}

/** The full prompt for an AI-written commit message, with the diff fitted to the budget. */
export function buildCommitPrompt(i: CommitPromptInput): string {
  const sections = [
    [
      "Write a git commit message for the changes below.",
      "- First line: an imperative summary of at most 72 characters, with no trailing period.",
      "- If the change needs it, add a blank line and a short body (wrapped at 72 columns) saying what changed and why.",
      "- Describe only what the diff shows.",
      '- Output only the message: no code fences, no quotes, no "Subject:" label, no Co-authored-by or Signed-off-by lines.',
    ].join("\n"),
  ];
  const title = i.threadTitle?.trim();
  if (title) sections.push(`Thread: ${title}`);
  sections.push(`Files changed:\n${i.nameStatus}`);
  sections.push(`Summary:\n${i.stat}`);
  sections.push(`Diff:\n${fitPatches(i.files, i.budget ?? DEFAULT_PATCH_BUDGET)}`);
  return sections.join("\n\n");
}

/** Clean a model's answer into a subject/body pair, or null when it wrote no subject. */
export function parseCommitMessage(raw: string): { subject: string; body: string } | null {
  let text = raw.replace(/\r\n/g, "\n").trim();
  const fenced = text.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
  if (fenced) text = fenced[1] ?? "";

  const lines = text
    .split("\n")
    .filter((line) => !/^(co-authored-by|signed-off-by):/i.test(line.trim()));
  if (lines.length > 0) {
    lines[0] = (lines[0] ?? "").replace(/^\s*(?:commit message|message|subject)\s*:\s*/i, "");
  }

  const start = lines.findIndex((line) => line.trim() !== "");
  if (start === -1) return null;

  const line = (lines[start] ?? "").trim();
  const quoted = line.length >= 2 ? line[0] : "";
  const unquoted =
    (quoted === '"' || quoted === "'" || quoted === "`") && line.at(-1) === quoted
      ? line.slice(1, -1).trim()
      : line;
  let subject = unquoted.replace(/\.$/, "");
  subject = shortenSubject(subject);
  if (!subject) return null;

  const body = lines
    .slice(start + 1)
    .join("\n")
    .trim()
    .replace(/\n{3,}/g, "\n\n");
  return { subject, body };
}

/** Trim a subject to 72 characters at the last word boundary (or hard-cut when it has no spaces). */
function shortenSubject(subject: string): string {
  if (subject.length <= SUBJECT_LIMIT) return subject;
  const head = subject.slice(0, SUBJECT_LIMIT);
  const space = head.lastIndexOf(" ");
  return (space > 0 ? head.slice(0, space) : head).trimEnd();
}

/** An agent that can be credited as a commit co-author. */
export interface CoAuthor {
  name: string;
  email: string;
}

/** The co-author trailers for the agents that can write code here. */
export const CO_AUTHORS: Record<string, CoAuthor> = {
  claude: { name: "Claude", email: "noreply@anthropic.com" },
  codex: { name: "Codex", email: "noreply@openai.com" },
  opencode: { name: "OpenCode", email: "noreply@opencode.ai" },
  cursor: { name: "Cursor Agent", email: "cursoragent@cursor.com" },
};

/** The trailer for an agent id, or null when it isn't a known coding agent. */
export function coAuthorFor(agentId: string): CoAuthor | null {
  return CO_AUTHORS[agentId] ?? null;
}

/** The commit message text, with the co-author trailer appended once and no trailing newline. */
export function formatCommitMessage(m: { subject: string; body: string }, coAuthor?: CoAuthor | null): string {
  const parts = [m.subject];
  const body = m.body.trim();
  if (body) parts.push(body);
  const out = parts.join("\n\n");
  if (!coAuthor) return out;
  const trailer = `Co-authored-by: ${coAuthor.name} <${coAuthor.email}>`;
  if (out.split("\n").some((line) => line.trim() === trailer)) return out;
  return `${out}\n\n${trailer}`;
}
