import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type CliRunner,
  getIssue,
  issueLine,
  issueNote,
  listIssues,
  parseGithubIssue,
  parseGithubIssues,
  parseGitlabIssue,
  parseGitlabIssues,
  parseLocalIssue,
  readIssueConfig,
} from "../src/main/issues";
import { tempDir } from "./helpers";

function project(config: unknown): string {
  const dir = tempDir();
  mkdirSync(join(dir, ".cubiq"));
  writeFileSync(join(dir, ".cubiq", "issues.json"), typeof config === "string" ? config : JSON.stringify(config));
  return dir;
}

/** A runner that answers each call from `answers` (by order) and records the args. */
function fake(...answers: (unknown | Error)[]): CliRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const run: CliRunner = async (command, args) => {
    calls.push([command, ...args]);
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return JSON.stringify(next);
  };
  return Object.assign(run, { calls });
}

const LABELS = readIssueConfig(project({ tracker: "github", labels: { "ready-for-agent": "agent-ready" } }))!.labels;

const LOCAL = `---
id: 7
title: "Thread list doesn't refresh"
type: bug
state: ready-for-agent
created: 2026-10-29
---

It stays stale after a merge.

## Comments

### 2026-10-29
First look.

### 2026-10-30
Found it.
`;

describe("readIssueConfig", () => {
  it("is null without a file, or with an unknown tracker", () => {
    expect(readIssueConfig(tempDir())).toBeNull();
    expect(readIssueConfig(project({ tracker: "jira" }))).toBeNull();
    expect(readIssueConfig(project("{not json"))).toBeNull();
  });

  it("fills in the folder and the label defaults, keeping renamed labels", () => {
    const c = readIssueConfig(project({ tracker: "local", labels: { enhancement: "feature" } }))!;
    expect(c.folder).toBe("docs/issues");
    expect(c.labels.enhancement).toBe("feature");
    expect(c.labels["needs-triage"]).toBe("needs-triage");
    expect(c.repo).toBeUndefined();
  });
});

describe("parsers", () => {
  it("GitHub: drops pull requests and reads the roles through renamed labels", () => {
    const list = parseGithubIssues(
      [
        { number: 3, title: "Add controls", html_url: "https://h/3", labels: [{ name: "enhancement" }, { name: "agent-ready" }], comments: 2, pull_request: null },
        { number: 4, title: "A PR", labels: [], comments: 0, pull_request: { url: "x" } },
        { title: "no number" },
      ],
      LABELS,
    );
    expect(list).toEqual([{ number: 3, title: "Add controls", url: "https://h/3", labels: ["enhancement", "agent-ready"], commentCount: 2, type: "enhancement", state: "ready-for-agent" }]);
  });

  it("GitHub: one issue, a null body, comments newest first", () => {
    const i = parseGithubIssue(
      { number: 3, title: "T", body: null, labels: [], comments: 2 },
      [
        { user: { login: "a" }, created_at: "1", body: "old" },
        { user: { login: "b" }, created_at: "2", body: "new" },
      ],
      LABELS,
    )!;
    expect(i.body).toBe("");
    expect(i.comments.map((c) => c.body)).toEqual(["new", "old"]);
    expect(i.comments[0]!.author).toBe("b");
  });

  it("GitLab: iid, string labels, and no system notes", () => {
    expect(parseGitlabIssues([{ iid: 5, title: "G", web_url: "u", labels: ["bug"], user_notes_count: 1 }], LABELS)).toEqual([
      { number: 5, title: "G", url: "u", labels: ["bug"], commentCount: 1, type: "bug" },
    ]);
    const i = parseGitlabIssue(
      { iid: 5, title: "G", description: "D", labels: [] },
      [
        { author: { username: "a" }, created_at: "1", body: "said", system: false },
        { author: { username: "bot" }, created_at: "2", body: "added label", system: true },
      ],
      LABELS,
    )!;
    expect(i.body).toBe("D");
    expect(i.comments).toEqual([{ author: "a", createdAt: "1", body: "said" }]);
  });

  it("local: frontmatter, the body up to Comments, comments newest first", () => {
    const i = parseLocalIssue(LOCAL, LABELS)!;
    expect(i).toMatchObject({ number: 7, title: "Thread list doesn't refresh", type: "bug", state: "ready-for-agent", labels: ["bug", "ready-for-agent"], commentCount: 2, closed: false });
    expect(i.body).toBe("It stays stale after a merge.");
    expect(i.comments).toEqual([
      { author: "", createdAt: "2026-10-30", body: "Found it." },
      { author: "", createdAt: "2026-10-29", body: "First look." },
    ]);
    expect(parseLocalIssue("---\ntitle: no id\n---\nbody", LABELS)).toBeNull();
    expect(parseLocalIssue("no frontmatter", LABELS)).toBeNull();
  });
});

describe("listIssues", () => {
  it("asks gh for the folder's own repo when none is configured", async () => {
    const run = fake([{ number: 1, title: "One", labels: [], comments: 0 }]);
    const r = await listIssues(project({ tracker: "github" }), run);
    expect(run.calls).toEqual([["gh", "api", "repos/{owner}/{repo}/issues?state=open&per_page=50"]]);
    expect(r).toEqual({ ok: true, tracker: "github", value: [{ number: 1, title: "One", labels: [], commentCount: 0 }] });
  });

  it("encodes a configured GitLab path, and uses tea for Gitea", async () => {
    const lab = fake([]);
    await listIssues(project({ tracker: "gitlab", repo: "group/sub/name" }), lab);
    expect(lab.calls[0]).toEqual(["glab", "api", "projects/group%2Fsub%2Fname/issues?state=opened&per_page=50"]);
    const tea = fake([]);
    await listIssues(project({ tracker: "gitea", repo: "o/r" }), tea);
    expect(tea.calls[0]).toEqual(["tea", "api", "repos/o/r/issues?state=open&type=issues&limit=50"]);
  });

  it("says when the CLI is missing, signed out, or there's no config", async () => {
    const dir = project({ tracker: "github" });
    const missing = await listIssues(dir, fake(Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" })));
    expect(missing).toMatchObject({ ok: false, error: "cli-missing" });
    const out = await listIssues(dir, fake(new Error("To get started with GitHub CLI, please run:  gh auth login")));
    expect(out).toEqual({ ok: false, error: "signed-out", message: "gh isn't signed in. Run: gh auth login" });
    expect(await listIssues(tempDir(), fake())).toMatchObject({ ok: false, error: "no-config" });
    expect(await listIssues(dir, fake(new Error("HTTP 404: Not Found\nmore")))).toEqual({ ok: false, error: "failed", message: "HTTP 404: Not Found" });
  });

  it("reads open local issues from the folder, skipping closed ones and the README", async () => {
    const dir = project({ tracker: "local" });
    const folder = join(dir, "docs", "issues");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "0007-a.md"), LOCAL);
    writeFileSync(join(folder, "0002-b.md"), "---\nid: 2\ntitle: Done\nstate: closed\n---\n");
    writeFileSync(join(folder, "README.md"), "See .cubiq/issue-tracker.md");
    const r = await listIssues(dir);
    expect(r.ok && r.value.map((i) => i.number)).toEqual([7]);
    expect(r.ok && "body" in r.value[0]!).toBe(false);
    const one = await getIssue(dir, 7);
    expect(one.ok && one.value.comments.length).toBe(2);
    expect(await getIssue(dir, 9)).toEqual({ ok: false, error: "failed", message: "No local issue #9." });
    expect(await listIssues(project({ tracker: "local", folder: "nowhere" }))).toEqual({ ok: true, tracker: "local", value: [] });
  });
});

describe("getIssue", () => {
  it("reads a GitHub issue and its comments", async () => {
    const run = fake({ number: 3, title: "T", body: "B", labels: [], comments: 0 }, []);
    const r = await getIssue(project({ tracker: "github", repo: "o/r" }), 3, run);
    expect(run.calls.map((c) => c[2])).toEqual(["repos/o/r/issues/3", "repos/o/r/issues/3/comments?per_page=100"]);
    expect(r).toMatchObject({ ok: true, value: { number: 3, body: "B", comments: [] } });
  });
});

describe("issueNote", () => {
  const base = { number: 3, title: "T", labels: [], commentCount: 0, body: "Body", comments: [] };

  it("leaves out empty labels and comments", () => {
    expect(issueNote(base)).toBe("Working on issue #3: T\n\nBody");
    expect(issueLine(base)).toBe("Working on #3: T");
  });

  it("lists labels, the url and comments", () => {
    const note = issueNote({ ...base, url: "https://h/3", labels: ["bug"], comments: [{ author: "a", createdAt: "d", body: "hi" }] });
    expect(note).toBe("Working on issue #3: T\nhttps://h/3\nLabels: bug\n\nBody\n\nComments (newest first):\n- a (d): hi");
  });

  it("is cut to the budget as a whole", () => {
    const note = issueNote({ ...base, body: "x".repeat(10_000) }, 200);
    expect(note).toHaveLength(200);
    expect(note.endsWith("…")).toBe(true);
  });
});
