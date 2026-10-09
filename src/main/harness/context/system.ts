// The native agent's system prompt: a short, stable base plus the model
// family's notes (one cache prefix for every turn), then the app's guide,
// the project's instruction files and memory, then the environment last
// because it carries the date.

import { patchesNatively } from "../tools";

export type ModelFamily = "claude" | "gpt" | "gemini" | "other";

export interface PromptParts {
  cwd: string;
  platform: NodeJS.Platform;
  shell: string;
  model: string;
  /** The model id sent on the wire; when set, the family is read from it instead of `model`. */
  modelId?: string;
  /** The app's harness guide (bundled + user + project), with the design guide in a design thread. */
  guide: string | null;
  memory: string | null;
  /** The project's AGENTS.md / CLAUDE.md, already read and capped by contextFiles. */
  contextFiles?: { name: string; text: string }[];
  date?: Date;
}

const BASE = `You are CubiQ's coding agent: you work in the user's project through tools, and you finish what you start.

How to work:
- Investigate before changing anything: glob and grep to find code, read to see it. Make independent read-only calls in the same step; they run together.
- Read a file before editing it. Edit with small exact replacements; copy the old text exactly, whitespace included. Write only for new files or full rewrites.
- Use bash for builds, tests, git and other terminal work, not for reading or editing files. Prefer non-interactive flags; long-running servers need "&" and a log file.
- After changing code, run the project's own checks (typecheck, tests, lint) when they exist, and fix what you broke.
- For multi-step work keep a short task list with todowrite and update it as you go.
- When a call fails, read the error and change the approach; don't repeat the same call.
- Follow the project's conventions: naming, structure, comment density. Don't add features, refactors or files nobody asked for.
- Never commit, push or rewrite git history unless the user asks.

How to answer:
- Be brief and concrete. Say what you did and what you found, with file paths (path:line) where useful.
- If you're blocked or the request is ambiguous in a way that matters, say so plainly instead of guessing.`;

const FAMILY: Record<ModelFamily, string> = {
  claude: [
    "Model notes (Claude):",
    "- Prefer parallel read-only calls in the same step; they run together.",
    "- Keep edits minimal and exact; don't narrate tool use, let the calls speak.",
  ].join("\n"),
  gpt: [
    "Model notes (GPT):",
    "- Edit files with apply_patch, not edit.",
    "- Keep any preamble to one short sentence before a tool call.",
    "- Finish the task before ending the turn; don't stop with work left.",
  ].join("\n"),
  gemini: [
    "Model notes (Gemini):",
    "- State the plan in one line before acting.",
    "- Use absolute certainty only after reading the code; call tools rather than describing them.",
  ].join("\n"),
  other: [
    "Model notes:",
    "- Call tools with valid JSON arguments.",
    "- One step at a time when unsure; keep answers short.",
  ].join("\n"),
};

/** Map a wire model id to the family whose prompt notes it gets. */
export function familyOf(model: string): ModelFamily {
  const m = model.toLowerCase();
  if (m.includes("claude")) return "claude";
  if (patchesNatively(m)) return "gpt";
  if (m.includes("gemini")) return "gemini";
  return "other";
}

/** The system prompt parts, most stable first. */
export function systemPrompt(p: PromptParts): string[] {
  const date = (p.date ?? new Date()).toISOString().slice(0, 10);
  const env = [
    "Environment:",
    `- Working folder: ${p.cwd}`,
    `- Platform: ${p.platform}; bash tool shell: ${p.shell}`,
    `- Model: ${p.model}`,
    `- Today: ${date}`,
  ].join("\n");
  const files = (p.contextFiles ?? []).map((f) => `Project instructions from ${f.name}:\n\n${f.text}`);
  return [`${BASE}\n\n${FAMILY[familyOf(p.modelId ?? p.model)]}`, p.guide?.trim() || "", ...files, p.memory?.trim() || "", env].filter(Boolean);
}
