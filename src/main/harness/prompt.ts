// The native agent's system prompt: a short, stable base (one cache prefix for
// every turn), then the app's guide and memory, then the environment last
// because it carries the date.

export interface PromptParts {
  cwd: string;
  platform: NodeJS.Platform;
  shell: string;
  model: string;
  /** The app's harness guide (bundled + user + project), with the design guide in a design thread. */
  guide: string | null;
  memory: string | null;
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
  return [BASE, p.guide?.trim() || "", p.memory?.trim() || "", env].filter(Boolean);
}
