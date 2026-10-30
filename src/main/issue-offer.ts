import type { IssueType } from "../shared/types";

/**
 * The reply check behind the "File issue?" card: in a project with an issue
 * tracker, a finished turn's reply that reports a problem it didn't fix gets an
 * offer under it. Agents rarely offer on their own, so the app asks a cheap
 * background model instead. Pure helpers; the service runs them.
 */

export interface IssueOffer {
  type: IssueType;
  title: string;
  summary: string;
}

/** Words a reply about an unfixed problem nearly always has; replies without any skip the model call. */
const PROBLEM =
  /\b(bugs?|broken|fail(s|ed|ing|ure)?|errors?|wrong|regress\w*|crash\w*|pre-existing|unrelated|out of scope|outside (this|the) (task|scope)|didn't (fix|touch|change)|left \w+ (alone|untouched)|missing|doesn't work|isn't working|not working)\b/i;

/** Whether a reply might report a problem worth an issue: a cheap filter before the model. */
export function mightReportProblem(answer: string): boolean {
  return PROBLEM.test(answer);
}

/** Whether a turn already filed one (the tool's name may carry an MCP or agent prefix). */
export function filedThisTurn(toolNames: string[]): boolean {
  return toolNames.some((n) => n === "issue_create" || n.endsWith("__issue_create") || n.endsWith("_issue_create"));
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The background model's prompt: the user's request and the agent's reply, and the one-line JSON to answer with. */
export function offerPrompt(request: string, answer: string): string {
  return [
    "You check an AI coding agent's final reply for a problem worth tracking as an issue. Answer with one line of JSON and nothing else.",
    'If the reply reports a real problem (a bug, a missing feature or a documentation gap) that this turn did NOT fix, that is not simply the user\'s own request still in progress, and that the reply does not already offer to file as an issue, answer {"file":true,"type":"bug"|"enhancement"|"documentation","title":"…","summary":"…"}.',
    "title: sentence case, under 70 characters, no prefix; a bug names the symptom the user sees, an enhancement starts with a verb. summary: one or two sentences on the problem itself (what happens and where), not on the reply or this check.",
    'Otherwise answer {"file":false}.',
    "",
    `<request>\n${clip(request.trim(), 1500)}\n</request>`,
    `<reply>\n${clip(answer.trim(), 4000)}\n</reply>`,
  ].join("\n");
}

const TYPES: IssueType[] = ["bug", "enhancement", "documentation"];

/** The offer in the model's answer; null for "no", or anything that isn't one. */
export function parseOffer(text: string): IssueOffer | null {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(m[0]);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const o = raw as { file?: unknown; type?: unknown; title?: unknown; summary?: unknown };
  if (o.file !== true || !TYPES.includes(o.type as IssueType) || typeof o.title !== "string") return null;
  const title = o.title.trim().replace(/\.$/, "");
  if (title.length < 3) return null;
  const summary = typeof o.summary === "string" ? o.summary.trim() : "";
  return { type: o.type as IssueType, title: clip(title, 120), summary: clip(summary, 600) };
}
