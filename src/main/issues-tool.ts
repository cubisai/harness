import { isAbsolute, join } from "node:path";
import { z } from "zod";
import type { IssueSummary } from "../shared/types";
import type { HarnessTool, ToolOutput } from "./agents/types";
import { resolveInside } from "./artifacts";
import { createIssue, MAX_ATTACHMENTS, type CliRunner, type CreatedIssue, type NewIssue } from "./issues";

/** The harness tool an agent files a new issue with, in projects that have a tracker (`.cubiq/issues.json`). */
export const ISSUE_CREATE_TOOL = "issue_create";

export interface IssueToolDeps {
  /** The project folder (tracker config, CLI cwd) and the thread's folder (where attachments may come from); null when the thread is gone. */
  folders(threadId: string): { project: string; thread: string } | null;
  /** Where browser screenshots are saved: attachments may come from there too. */
  screenshotsDir: string;
  /** Point the thread at the filed issue, so the composer shows its chip. */
  link(threadId: string, issue: IssueSummary): void;
  /** Tell the user in the thread, with the issue's link. */
  notice(threadId: string, text: string): void;
  create?: (projectDir: string, issue: NewIssue, run?: CliRunner) => Promise<CreatedIssue>;
}

const error = (text: string): ToolOutput => ({ text, isError: true });

function define<S extends z.ZodRawShape>(t: HarnessTool<S>): HarnessTool {
  return t as unknown as HarnessTool;
}

/** An attachment path as an absolute path inside the thread's folder or the screenshots folder; null outside both. */
function allowedPath(p: string, roots: string[]): string | null {
  for (const root of roots) {
    const rel = resolveInside(root, p.trim());
    if (rel) return join(root, rel);
  }
  return null;
}

export function issueTools(deps: IssueToolDeps, threadId: string): HarnessTool[] {
  const create = deps.create ?? createIssue;
  return [define({
    name: ISSUE_CREATE_TOOL,
    description:
      "File a new issue (labels: its type + needs-triage), only after the user said yes. Search for a duplicate first; write up what you saw, no root-cause digging. Title: sentence case, no prefix. Body: bug = What happens / Steps to reproduce / Expected / Notes; enhancement = Purpose / Acceptance criteria / Notes.",
    input: {
      type: z.enum(["bug", "enhancement", "documentation"]),
      title: z.string().min(3).max(120),
      body: z.string().min(1).max(20_000),
      attachments: z
        .array(z.string())
        .max(MAX_ATTACHMENTS)
        .optional()
        .describe(`Up to ${MAX_ATTACHMENTS} evidence files (screenshots, artifacts, logs) from the working folder or CubiQ's screenshots`),
      link: z.boolean().optional().describe("Make it this thread's issue"),
    },
    autoAllow: true,
    effect: "mutate",
    async run(args) {
      const folders = deps.folders(threadId);
      if (!folders) return error("This thread has no project folder.");
      const roots = [folders.thread, deps.screenshotsDir];
      const attachments: string[] = [];
      for (const p of args.attachments ?? []) {
        const path = allowedPath(p, roots);
        if (!path) return error(`${p} is outside the working folder and CubiQ's screenshots; attach files from there only.${isAbsolute(p) ? "" : " Relative paths start at the working folder."}`);
        attachments.push(path);
      }
      const res = await create(folders.project, { type: args.type, title: args.title.trim(), body: args.body, attachments });
      if (!res.ok) return error(res.message);
      const { leftOut, ...issue } = res.value;
      if (args.link) deps.link(threadId, issue);
      const where = issue.url ?? (res.tracker === "local" ? "local issue" : "");
      deps.notice(threadId, `Filed #${issue.number}: ${issue.title}${where ? ` · ${where}` : ""}`);
      const lines = [`Filed #${issue.number}: ${issue.title}`, ...(issue.url ? [issue.url] : []), `Labels: ${issue.labels.join(", ")}`];
      if (leftOut.length) lines.push(`Not attached: ${leftOut.join("; ")}`);
      return { text: lines.join("\n") };
    },
  })];
}
