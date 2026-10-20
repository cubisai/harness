// S2, drafting a lesson from a bad turn: pure prompt-building and parsing for
// the learner. No I/O, no model calls — everything here is text in, text out.

import type { LessonScope, TurnSignal } from "../../shared/learn";
import { SECRETISH } from "../memory/extractor";

/** One turn that went wrong, as the drafter sees it. */
export interface DraftInput {
  request: string;
  answer: string;
  signals: TurnSignal[];
  commands: string[];
  /** The failing project check's tail, or null when none ran. */
  checkTail: string | null;
  /** Project-relative paths the turn changed. */
  changed: string[];
  /** The project's tracked file names (no contents), for naming real files; [] when unknown. */
  files: string[];
  /** The answer of a later turn that went right, or null. */
  contrast: string | null;
  /** Rule texts of lessons/notes that already exist. */
  existing: string[];
}

/** One lesson the model drafted, ready to store. */
export interface DraftedLesson {
  rule: string;
  why: string;
  scope: LessonScope;
}

const CLIP_AT = 1500;
const MAX_FILES = 80;

/** Clip a block to the prompt's budget, marking that it was cut. */
function clip(text: string): string {
  return text.length > CLIP_AT ? `${text.slice(0, CLIP_AT)}…` : text;
}

/** The plain-text instruction the drafter sends: one bad turn, for one rule. */
export function buildDraftPrompt(i: DraftInput): string {
  const lines = [
    "You are reviewing ONE coding-agent turn that went wrong, to add at most one rule to a project's lesson list.",
    'Given the SIGNALS (external evidence), the EXISTING rules and the TURN, output ONLY a JSON object {"rule":"...","why":"...","paths":["..."],"keywords":["..."]} or {"none":true}.',
    "rule: one imperative sentence, at most 200 characters, specific to this project, telling a future agent what to do differently.",
    "why: one sentence naming the evidence (the signal) that justifies the rule.",
    "paths: project-relative files, folders or globs the rule applies to ([] when it is general).",
    "Name a file (in rule or paths) only if it appears in CHANGED, PROJECT FILES or the check output; never guess a file name.",
    "keywords: up to 5 lowercase words from the kind of request the rule applies to.",
    "Base the rule only on the SIGNALS (external evidence), never on guesses.",
    'Output {"none":true} when the failure was the user\'s change of mind, a flaky tool, or nothing generalisable.',
    "Never include secrets, keys or tokens.",
    "Do not repeat an EXISTING rule.",
    "",
    "SIGNALS:",
    ...i.signals.map((s) => `- ${s.kind} (${s.level}): ${s.detail}`),
    // "Undone" read as "the edit didn't stick" once (2026-10-19): say what a revert means.
    ...(i.signals.some((s) => s.kind === "reverted")
      ? ["(reverted: the edit did land; the user then put the files back, so they didn't want that change. Unless the TURN shows the agent misread the request, that is a change of mind.)"]
      : []),
    "",
    "EXISTING:",
    ...(i.existing.length ? i.existing.map((r) => `- ${r}`) : ["(none)"]),
    "",
    "TURN:",
    `User: ${clip(i.request)}`,
    `Commands: ${clip(i.commands.join("; "))}`,
    `CHANGED: ${i.changed.length ? clip(i.changed.join(", ")) : "(none)"}`,
    ...(i.files.length > 0
      ? [`PROJECT FILES: ${clip(i.files.slice(0, MAX_FILES).join(", "))}${i.files.length > MAX_FILES ? ` (+${i.files.length - MAX_FILES} more)` : ""}`]
      : []),
  ];
  if (i.checkTail !== null) lines.push(`Check output: ${clip(i.checkTail)}`);
  lines.push(`Assistant: ${clip(i.answer)}`);
  if (i.contrast !== null) {
    lines.push("", "A LATER TURN THAT WENT RIGHT:", clip(i.contrast));
  }
  return lines.join("\n");
}

/** The first balanced top-level {...} in `text`, or null. */
function firstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/** A project-relative path: no "..", no leading "/", no drive letter, "/" separators. */
function cleanPath(raw: string): string | null {
  const path = raw.trim().replace(/\\/g, "/");
  if (!path || path.includes("..") || path.startsWith("/") || /^[A-Za-z]:\//.test(path)) return null;
  return path;
}

/** A lowercase keyword made only of [a-z0-9-], 2..30 chars long. */
function cleanKeyword(raw: string): string | null {
  const word = raw.trim().toLowerCase();
  return /^[a-z0-9-]{2,30}$/.test(word) ? word : null;
}

/** Parse the model's reply into one drafted lesson, or null when there is none. */
export function parseLesson(text: string): DraftedLesson | null {
  const body = firstJsonObject(text);
  if (!body) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const obj = parsed as Record<string, unknown> | null;
  if (!obj || typeof obj !== "object") return null;
  if (obj.none === true) return null;
  if (typeof obj.rule !== "string" || typeof obj.why !== "string") return null;
  let rule = obj.rule.trim();
  if (rule.length < 8) return null;
  if (rule.length > 200) rule = rule.slice(0, 200);
  const why = obj.why.trim().slice(0, 300);
  if (!why) return null;
  const paths: string[] = [];
  if (Array.isArray(obj.paths)) {
    for (const p of obj.paths) {
      if (paths.length >= 8) break;
      if (typeof p !== "string") continue;
      const path = cleanPath(p);
      if (path) paths.push(path);
    }
  }
  const keywords: string[] = [];
  if (Array.isArray(obj.keywords)) {
    for (const k of obj.keywords) {
      if (keywords.length >= 5) break;
      if (typeof k !== "string") continue;
      const word = cleanKeyword(k);
      if (word && !keywords.includes(word)) keywords.push(word);
    }
  }
  if (SECRETISH.test(rule) || SECRETISH.test(why)) return null;
  if (paths.some((p) => SECRETISH.test(p)) || keywords.some((k) => SECRETISH.test(k))) return null;
  return { rule, why, scope: { paths, keywords } };
}

/** Words too common to tell one rule from another. */
const STOP = new Set(["the", "and", "for", "with", "that", "this", "from", "into", "when", "then", "than", "are", "was", "use", "not", "you", "your", "its", "it's", "before", "after", "always", "never"]);

/** The lowercased words (3+ letters/digits) of `text`, minus stop words. */
export function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const word of text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []) {
    if (!STOP.has(word)) out.add(word);
  }
  return out;
}

/** Jaccard overlap of two texts' token sets; 0 when both are empty. */
export function similarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size && !tb.size) return 0;
  let shared = 0;
  for (const word of ta) if (tb.has(word)) shared++;
  return shared / (ta.size + tb.size - shared);
}

/** The id of the most similar existing entry at or above `threshold`, or null. */
export function findDuplicate(rule: string, existing: { id: string; rule: string }[], threshold = 0.6): string | null {
  let best: { id: string; score: number } | null = null;
  for (const entry of existing) {
    const score = similarity(rule, entry.rule);
    if (score >= threshold && (!best || score > best.score)) best = { id: entry.id, score };
  }
  return best?.id ?? null;
}

/** Tool names that pull content from outside the repository. */
export const POISON_TOOLS = /^(?:web_?fetch|web_?search|fetch|browser_|mcp__)/i;

/** Whether any of these tool names pulls content from outside the project. */
export function pulledOutsideContent(toolNames: string[]): boolean {
  return toolNames.some((name) => POISON_TOOLS.test(name));
}
