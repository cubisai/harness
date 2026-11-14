import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CreatedIssue, NewIssue } from "../src/main/issues";
import type { IssueDetail, IssueResult, IssueSummary } from "../src/shared/types";
import { ISSUE_CREATE_TOOL, issueTools, SET_THREAD_ISSUE_TOOL } from "../src/main/issues-tool";
import { tempDir } from "./helpers";

function setup(result: CreatedIssue) {
  const project = tempDir();
  const shots = tempDir();
  mkdirSync(join(project, "out"));
  writeFileSync(join(project, "out", "page.html"), "<p>");
  writeFileSync(join(shots, "s1.png"), "png");
  const create = vi.fn(async (_dir: string, _issue: NewIssue) => result);
  const link = vi.fn((_id: string, _issue: IssueSummary) => {});
  const notice = vi.fn((_id: string, _text: string) => {});
  const [tool] = issueTools({ folders: () => ({ project, thread: project }), screenshotsDir: shots, link, notice, create }, "t1");
  return { tool: tool!, create, link, notice, project, shots };
}

const FILED: CreatedIssue = {
  ok: true,
  tracker: "github",
  value: { number: 12, title: "Thread list doesn't refresh", url: "https://github.com/o/r/issues/12", labels: ["bug", "needs-triage"], commentCount: 0, leftOut: [] },
};

describe("issue_create", () => {
  it("files with attachments from the working folder and the screenshots folder, tells the user, and links on request", async () => {
    const { tool, create, link, notice, project, shots } = setup(FILED);
    expect(tool.name).toBe(ISSUE_CREATE_TOOL);
    const out = await tool.run({ type: "bug", title: " Thread list doesn't refresh ", body: "## What happens", attachments: ["out/page.html", join(shots, "s1.png")], link: true });
    expect(create.mock.calls[0]![1]).toEqual({ type: "bug", title: "Thread list doesn't refresh", body: "## What happens", attachments: [join(project, "out/page.html"), join(shots, "s1.png")] });
    expect(out.isError).toBeUndefined();
    expect(out.text).toBe("Filed #12: Thread list doesn't refresh\nhttps://github.com/o/r/issues/12\nLabels: bug, needs-triage");
    expect(notice).toHaveBeenCalledWith("t1", "Filed #12: Thread list doesn't refresh · https://github.com/o/r/issues/12");
    expect(link.mock.calls[0]![1]).toMatchObject({ number: 12, url: "https://github.com/o/r/issues/12" });
    expect(link.mock.calls[0]![1]).not.toHaveProperty("leftOut");
  });

  it("doesn't link unless asked, and names the attachments it left out", async () => {
    const { tool, link } = setup({ ...FILED, value: { ...FILED.value, leftOut: ["page.html (gh can't upload files)"] } });
    const out = await tool.run({ type: "bug", title: "Thread list", body: "x", attachments: ["out/page.html"] });
    expect(link).not.toHaveBeenCalled();
    expect(out.text).toContain("Not attached: page.html (gh can't upload files)");
  });

  it("refuses files outside the working folder and the screenshots, filing nothing", async () => {
    const { tool, create, notice } = setup(FILED);
    const outside = join(tempDir(), "secret.txt");
    writeFileSync(outside, "x");
    for (const p of [outside, "../escape.txt"]) {
      const out = await tool.run({ type: "bug", title: "Thread list", body: "x", attachments: [p] });
      expect(out.isError).toBe(true);
    }
    expect(create).not.toHaveBeenCalled();
    expect(notice).not.toHaveBeenCalled();
  });

  it("passes the tracker's error back", async () => {
    const { tool, notice } = setup({ ok: false, error: "signed-out", message: "gh isn't signed in. Run: gh auth login" });
    const out = await tool.run({ type: "enhancement", title: "Add a thing", body: "x" });
    expect(out).toEqual({ text: "gh isn't signed in. Run: gh auth login", isError: true });
    expect(notice).not.toHaveBeenCalled();
  });
});

describe("set_thread_issue", () => {
  const ISSUE: IssueResult<IssueDetail> = {
    ok: true,
    tracker: "github",
    value: { number: 7, title: "Add controls", url: "https://github.com/o/r/issues/7", labels: ["enhancement"], commentCount: 2, body: "b", comments: [{ author: "a", createdAt: "", body: "x" }, { author: "b", createdAt: "", body: "y" }] },
  };

  function tools(result: IssueResult<IssueDetail>) {
    const project = tempDir();
    const get = vi.fn(async (_dir: string, _n: number) => result);
    const link = vi.fn((_id: string, _issue: IssueSummary) => {});
    const list = issueTools({ folders: () => ({ project, thread: project }), screenshotsDir: tempDir(), link, notice: () => {}, get }, "t1");
    return { tool: list.find((t) => t.name === SET_THREAD_ISSUE_TOOL)!, get, link, project, names: list.map((t) => t.name) };
  }

  it("comes with issue_create, reads the issue and makes it the thread's", async () => {
    const { tool, get, link, project, names } = tools(ISSUE);
    expect(names).toEqual([ISSUE_CREATE_TOOL, SET_THREAD_ISSUE_TOOL]);
    const out = await tool.run({ number: 7 });
    expect(get).toHaveBeenCalledWith(project, 7);
    expect(link).toHaveBeenCalledWith("t1", { number: 7, title: "Add controls", url: "https://github.com/o/r/issues/7", labels: ["enhancement"], commentCount: 2 });
    expect(out).toEqual({ text: "This thread now works on #7: Add controls" });
  });

  it("passes the tracker's error back and links nothing", async () => {
    const { tool, link } = tools({ ok: false, error: "failed", message: "Couldn't read issue #99." });
    expect(await tool.run({ number: 99 })).toEqual({ text: "Couldn't read issue #99.", isError: true });
    expect(link).not.toHaveBeenCalled();
  });
});

