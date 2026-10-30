import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { IssueComment, IssueDetail, IssueResult, IssueState, IssueSummary, IssueTracker, IssueType } from "../shared/types";
import { killTree, spawnCommand } from "./winspawn";

/**
 * A project's issues, read through its git host's CLI (`gh`, `glab`, `tea`) or
 * from local markdown files, as `.cubiq/issues.json` says (written by the
 * bundled `issue-setup` skill). Read-only: the agent's skills do the writing.
 */

export interface IssueConfig {
  tracker: IssueTracker;
  /** The host's path for the repo; absent = the CLI's own guess from the folder's remote. */
  repo?: string;
  /** Local issues' folder, relative to the project. */
  folder: string;
  /** Label role → the name used on the host. */
  labels: Record<string, string>;
}

/** Runs a CLI: stdout on exit 0, else a rejection carrying `code` (ENOENT) or `stderr`. */
export type CliRunner = (command: string, args: string[], cwd: string) => Promise<string>;

const TRACKERS: IssueTracker[] = ["github", "gitlab", "gitea", "local"];
const TYPES: IssueType[] = ["bug", "enhancement", "documentation"];
const STATES: IssueState[] = ["ready-for-agent", "ready-for-human", "needs-triage", "needs-info"];
const CLI: Record<Exclude<IssueTracker, "local">, { command: string; login: string }> = {
  github: { command: "gh", login: "gh auth login" },
  gitlab: { command: "glab", login: "glab auth login" },
  gitea: { command: "tea", login: "tea login add" },
};
const LIMIT = 50;

/** The project's tracker config, with defaults filled in; null when there's none or it's unreadable. */
export function readIssueConfig(projectDir: string): IssueConfig | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(projectDir, ".cubiq", "issues.json"), "utf8"));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const c = raw as { tracker?: unknown; repo?: unknown; folder?: unknown; labels?: unknown };
  if (!TRACKERS.includes(c.tracker as IssueTracker)) return null;
  const labels: Record<string, string> = {};
  for (const role of [...TYPES, ...STATES, "wontfix"]) labels[role] = role;
  if (c.labels && typeof c.labels === "object") {
    for (const [role, name] of Object.entries(c.labels)) if (typeof name === "string" && name.trim()) labels[role] = name.trim();
  }
  return {
    tracker: c.tracker as IssueTracker,
    ...(typeof c.repo === "string" && c.repo.trim() ? { repo: c.repo.trim() } : {}),
    folder: typeof c.folder === "string" && c.folder.trim() ? c.folder.trim() : "docs/issues",
    labels,
  };
}

/** The default runner: async, through winspawn (Windows shims), killed after 20 s. */
export const runCli: CliRunner = (command, args, cwd) =>
  new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnCommand(command, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = "";
    let stderr = "";
    let done = false;
    const timer = setTimeout(() => {
      killTree(child);
      finish(new Error(`${command} timed out.`));
    }, 20_000);
    const finish = (err: Error | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(stdout);
    };
    child.stdout?.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr?.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", (err) => finish(err));
    child.on("close", (code) => {
      if (code === 0) finish(null);
      else finish(Object.assign(new Error(stderr.trim() || `${command} exited with ${code}`), { stderr }));
    });
  });

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function labelNames(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((l) => (typeof l === "string" ? l : str((l as { name?: unknown } | null)?.name))).filter(Boolean);
}

/** The type and state roles whose configured label names an issue carries. */
function roles(names: string[], labels: Record<string, string>): { type?: IssueType; state?: IssueState } {
  const type = TYPES.find((r) => names.includes(labels[r] ?? r));
  const state = STATES.find((r) => names.includes(labels[r] ?? r));
  return { ...(type ? { type } : {}), ...(state ? { state } : {}) };
}

function summary(number: unknown, title: unknown, url: unknown, names: string[], commentCount: unknown, labels: Record<string, string>): IssueSummary | null {
  if (typeof number !== "number" || !Number.isInteger(number) || typeof title !== "string" || !title) return null;
  return {
    number,
    title,
    ...(typeof url === "string" && url ? { url } : {}),
    labels: names,
    commentCount: typeof commentCount === "number" ? commentCount : 0,
    ...roles(names, labels),
  };
}

function newestFirst(comments: IssueComment[]): IssueComment[] {
  return comments.reverse();
}

type Json = Record<string, unknown>;
const rows = (data: unknown): Json[] => (Array.isArray(data) ? data.filter((x): x is Json => !!x && typeof x === "object") : []);

/** GitHub's (and Gitea's) REST `issues` list; pull requests are dropped. */
export function parseGithubIssues(data: unknown, labels: Record<string, string>): IssueSummary[] {
  return rows(data)
    .filter((i) => i.pull_request === undefined || i.pull_request === null)
    .map((i) => summary(i.number, i.title, i.html_url, labelNames(i.labels), i.comments, labels))
    .filter((i): i is IssueSummary => i !== null);
}

export function parseGithubIssue(issue: unknown, comments: unknown, labels: Record<string, string>): IssueDetail | null {
  const i = (issue && typeof issue === "object" ? issue : {}) as Json;
  const s = summary(i.number, i.title, i.html_url, labelNames(i.labels), i.comments, labels);
  if (!s) return null;
  const list = rows(comments).map((c) => ({ author: str((c.user as Json | null)?.login), createdAt: str(c.created_at), body: str(c.body) }));
  return { ...s, commentCount: Math.max(s.commentCount, list.length), body: str(i.body), comments: newestFirst(list) };
}

/** GitLab's REST `issues` list. */
export function parseGitlabIssues(data: unknown, labels: Record<string, string>): IssueSummary[] {
  return rows(data)
    .map((i) => summary(i.iid, i.title, i.web_url, labelNames(i.labels), i.user_notes_count, labels))
    .filter((i): i is IssueSummary => i !== null);
}

/** One GitLab issue; system notes (label changes, mentions) are dropped. `notes` come oldest first. */
export function parseGitlabIssue(issue: unknown, notes: unknown, labels: Record<string, string>): IssueDetail | null {
  const i = (issue && typeof issue === "object" ? issue : {}) as Json;
  const s = summary(i.iid, i.title, i.web_url, labelNames(i.labels), i.user_notes_count, labels);
  if (!s) return null;
  const list = rows(notes)
    .filter((n) => n.system !== true)
    .map((n) => ({ author: str((n.author as Json | null)?.username), createdAt: str(n.created_at), body: str(n.body) }));
  return { ...s, body: str(i.description), comments: newestFirst(list) };
}

/** A local issue file: `key: value` frontmatter, the body, then `### <date>` comments under `## Comments`. */
export function parseLocalIssue(text: string, labels: Record<string, string>): (IssueDetail & { closed: boolean }) | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text.replace(/^﻿/, ""));
  if (!m) return null;
  const front: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (kv) front[kv[1]!] = kv[2]!.trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  const id = Number(front.id);
  if (!Number.isInteger(id) || !front.title) return null;
  const [body, after] = splitAt(m[2]!, /^## Comments\s*$/m);
  const comments: IssueComment[] = [];
  if (after !== null) {
    for (const part of after.split(/^### /m).slice(1)) {
      const nl = part.indexOf("\n");
      comments.push({ author: "", createdAt: (nl < 0 ? part : part.slice(0, nl)).trim(), body: nl < 0 ? "" : part.slice(nl + 1).trim() });
    }
  }
  const names = [front.type, front.state].filter((v): v is string => !!v);
  // Local files name roles directly; `labels` only matters for a role renamed on the host.
  const type = TYPES.find((r) => r === front.type || labels[r] === front.type);
  const state = STATES.find((r) => r === front.state || labels[r] === front.state);
  return {
    number: id,
    title: front.title,
    labels: names,
    commentCount: comments.length,
    ...(type ? { type } : {}),
    ...(state ? { state } : {}),
    body: body.trim(),
    comments: newestFirst(comments),
    closed: front.state === "closed" || front.state === "wontfix" || front.state === labels.wontfix,
  };
}

function splitAt(text: string, re: RegExp): [string, string | null] {
  const m = re.exec(text);
  return m ? [text.slice(0, m.index), text.slice(m.index + m[0].length)] : [text, null];
}

async function localIssues(projectDir: string, config: IssueConfig): Promise<(IssueDetail & { closed: boolean })[]> {
  const dir = join(projectDir, config.folder);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: (IssueDetail & { closed: boolean })[] = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith(".md") || name.toLowerCase() === "readme.md") continue;
    try {
      const issue = parseLocalIssue(await readFile(join(dir, name), "utf8"), config.labels);
      if (issue) out.push(issue);
    } catch {
      // An unreadable file isn't an issue.
    }
  }
  return out.sort((a, b) => a.number - b.number);
}

function fail(tracker: IssueTracker, err: unknown): IssueResult<never> {
  const cli = tracker === "local" ? null : CLI[tracker];
  const e = err as { code?: unknown; message?: unknown; stderr?: unknown } | null;
  if (cli && e?.code === "ENOENT") return { ok: false, error: "cli-missing", message: `${cli.command} isn't installed or isn't on PATH.` };
  const text = `${str(e?.message)}\n${str(e?.stderr)}`;
  if (cli && /auth login|not logged in|authenticat|\b401\b|token/i.test(text)) {
    return { ok: false, error: "signed-out", message: `${cli.command} isn't signed in. Run: ${cli.login}` };
  }
  return { ok: false, error: "failed", message: (str(e?.message) || String(err)).split("\n")[0]!.slice(0, 300) };
}

const NO_CONFIG: IssueResult<never> = { ok: false, error: "no-config", message: "No issue tracker set up for this project. Run /issue-setup." };

/** The folder's `origin` remote URL, with any credentials in it dropped; null when there's none or git can't say. */
export async function originRemote(projectDir: string, run: CliRunner = runCli): Promise<string | null> {
  try {
    const url = (await run("git", ["remote", "get-url", "origin"], projectDir)).trim().split("\n")[0]!.trim();
    return url ? url.replace(/^(https?:\/\/)[^/@]*@/, "$1") : null;
  } catch {
    return null;
  }
}

/** The REST path prefix for the repo: the configured one, or the CLI's own placeholder. */
function repoPath(config: IssueConfig): string {
  if (config.tracker === "gitlab") return `projects/${config.repo ? encodeURIComponent(config.repo) : ":fullpath"}`;
  return `repos/${config.repo ?? "{owner}/{repo}"}`;
}

/** The project's open issues (up to 50), in the host's order; local ones by number. */
export async function listIssues(projectDir: string, run: CliRunner = runCli): Promise<IssueResult<IssueSummary[]>> {
  const config = readIssueConfig(projectDir);
  if (!config) return NO_CONFIG;
  const { tracker } = config;
  try {
    if (tracker === "local") {
      const value = (await localIssues(projectDir, config)).filter((i) => !i.closed).map(({ body: _b, comments: _c, closed: _x, ...s }) => s);
      return { ok: true, tracker, value };
    }
    const base = repoPath(config);
    const path =
      tracker === "github"
        ? `${base}/issues?state=open&per_page=${LIMIT}`
        : tracker === "gitea"
          ? `${base}/issues?state=open&type=issues&limit=${LIMIT}`
          : `${base}/issues?state=opened&per_page=${LIMIT}`;
    const data: unknown = JSON.parse(await run(CLI[tracker].command, ["api", path], projectDir));
    const value = (tracker === "gitlab" ? parseGitlabIssues : parseGithubIssues)(data, config.labels).slice(0, LIMIT);
    return { ok: true, tracker, value };
  } catch (err) {
    return fail(tracker, err);
  }
}

/** One issue with its body and comments (newest first). */
export async function getIssue(projectDir: string, n: number, run: CliRunner = runCli): Promise<IssueResult<IssueDetail>> {
  const config = readIssueConfig(projectDir);
  if (!config) return NO_CONFIG;
  const { tracker } = config;
  try {
    if (tracker === "local") {
      const found = (await localIssues(projectDir, config)).find((i) => i.number === n);
      if (!found) return { ok: false, error: "failed", message: `No local issue #${n}.` };
      const { closed: _x, ...value } = found;
      return { ok: true, tracker, value };
    }
    const base = `${repoPath(config)}/issues/${n}`;
    const { command } = CLI[tracker];
    const comments = tracker === "gitlab" ? `${base}/notes?sort=asc&per_page=100` : `${base}/comments?per_page=100`;
    const [issue, notes] = await Promise.all([run(command, ["api", base], projectDir), run(command, ["api", comments], projectDir)]);
    const parse = tracker === "gitlab" ? parseGitlabIssue : parseGithubIssue;
    const value = parse(JSON.parse(issue), JSON.parse(notes), config.labels);
    return value ? { ok: true, tracker, value } : { ok: false, error: "failed", message: `Couldn't read issue #${n}.` };
  } catch (err) {
    return fail(tracker, err);
  }
}

/** An issue the renderer picked, checked at the IPC boundary; null when it isn't one. */
export function readIssueSummary(v: unknown): IssueSummary | null {
  if (!v || typeof v !== "object") return null;
  const i = v as Json;
  if (typeof i.number !== "number" || !Number.isInteger(i.number) || i.number < 0) return null;
  if (typeof i.title !== "string" || !i.title.trim() || i.title.length > 500) return null;
  const labels = Array.isArray(i.labels) ? i.labels.filter((l): l is string => typeof l === "string" && l.length <= 100).slice(0, 30) : [];
  const url = typeof i.url === "string" && /^https?:\/\//.test(i.url) && i.url.length <= 2000 ? i.url : undefined;
  return { number: i.number, title: i.title.trim(), ...(url ? { url } : {}), labels, commentCount: typeof i.commentCount === "number" ? i.commentCount : 0 };
}

/** The one-line reminder later turns carry. */
export function issueLine(issue: { number: number; title: string }): string {
  return `Working on #${issue.number}: ${issue.title}`;
}

/** The full issue, sent to the agent once: cut to `maxChars` as a whole. */
export function issueNote(issue: IssueDetail, maxChars = 4000): string {
  const lines = [`Working on issue #${issue.number}: ${issue.title}`];
  if (issue.url) lines.push(issue.url);
  if (issue.labels.length) lines.push(`Labels: ${issue.labels.join(", ")}`);
  if (issue.body.trim()) lines.push("", issue.body.trim());
  if (issue.comments.length) {
    lines.push("", "Comments (newest first):");
    for (const c of issue.comments) lines.push(`- ${c.author || "comment"}${c.createdAt ? ` (${c.createdAt})` : ""}: ${c.body.trim()}`);
  }
  const text = lines.join("\n");
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}
