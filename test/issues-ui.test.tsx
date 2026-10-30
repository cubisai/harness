import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Composer } from "../src/renderer/src/components/Composer";
import { groupIssues, issueMeta } from "../src/renderer/src/components/IssuesSubmenu";
import { useStore } from "../src/renderer/src/store";
import type { IssueSummary, Thread } from "../src/shared/types";

const issue = (number: number, state?: IssueSummary["state"], title = `Issue ${number}`): IssueSummary => ({
  number,
  title,
  labels: [],
  commentCount: 0,
  ...(state ? { state } : {}),
});

describe("groupIssues", () => {
  it("groups by state in the picker's order, with unlabelled ones last", () => {
    const groups = groupIssues([issue(1), issue(2, "needs-info"), issue(3, "ready-for-agent"), issue(4, "needs-triage"), issue(5, "ready-for-human")], "");
    expect(groups.map((g) => [g.label, g.issues.map((i) => i.number)])).toEqual([
      ["Ready for agent", [3]],
      ["Ready for human", [5]],
      ["Needs triage", [4]],
      ["Needs info", [2]],
      ["Other", [1]],
    ]);
  });

  it("shows at most eight, and matches a number (with or without #) or the title", () => {
    const many = Array.from({ length: 12 }, (_, i) => issue(i + 1, "ready-for-agent"));
    expect(groupIssues(many, "").flatMap((g) => g.issues)).toHaveLength(8);
    expect(groupIssues([issue(12), issue(3, undefined, "Fix the login")], "#1").flatMap((g) => g.issues.map((i) => i.number))).toEqual([12]);
    expect(groupIssues([issue(12), issue(3, undefined, "Fix the login")], "LOGIN").flatMap((g) => g.issues.map((i) => i.number))).toEqual([3]);
  });

  it("describes a row by type and comments", () => {
    expect(issueMeta({ ...issue(1), type: "bug", commentCount: 1 })).toBe("bug · 1 comment");
    expect(issueMeta({ ...issue(1), commentCount: 3 })).toBe("3 comments");
    expect(issueMeta({ ...issue(1), type: "enhancement" })).toBe("enhancement");
    expect(issueMeta(issue(1))).toBe("");
  });
});

describe("the issue chip", () => {
  const thread = (extra: Partial<Thread>): Thread =>
    ({ id: "t", projectId: "p", agent: "claude", title: "T", sessionId: null, bindings: {}, model: "m", effort: null, permissionMode: "ask", createdAt: 0, updatedAt: 0, ...extra }) as Thread;

  const render = (t: Thread) => {
    const state = useStore.getInitialState();
    const saved = state.threads;
    try {
      state.threads = { p: [t] };
      return renderToStaticMarkup(<Composer threadId="t" />);
    } finally {
      state.threads = saved;
    }
  };

  it("shows the thread's issue with its number, title, labels in the tooltip, and a clear button", () => {
    const html = render(thread({ issue: { number: 3, title: "Add controls", labels: ["enhancement", "ready-for-agent"], source: "github" } }));
    expect(html).toContain('class="skill-chip context-chip issue-chip" title="#3 Add controls\nenhancement, ready-for-agent"');
    expect(html).toContain('<span class="issues-num">#3</span><span class="chip-label">Add controls</span>');
    expect(html).toContain('aria-label="Clear issue #3"');
    expect(html).toContain("composer-input has-chips");
  });

  it("shows nothing for a thread without one", () => {
    const html = render(thread({}));
    expect(html).not.toContain("issue-chip");
    expect(html).not.toContain("has-chips");
  });
});
