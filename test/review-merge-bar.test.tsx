import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FolderGit, WorktreeReview } from "../src/shared/types";
import { currentStep, ReviewMergeBarView, type ReviewMergeBarViewProps } from "../src/renderer/src/components/ReviewMergeBar";

const review: WorktreeReview = {
  branch: "harness/demo",
  base: "main",
  baseSha: "0000000",
  ahead: 2,
  behind: 0,
  uncommitted: 0,
  projectBranch: "main",
  projectDirty: false,
  files: [],
  targets: ["dev", "main"],
  remote: "origin",
  unpushed: null,
  merged: null,
};

const folder: FolderGit = { branch: "harness/demo", worktree: true, uncommitted: 0, remote: "origin", unpushed: null, hasCommits: true };

const noop = () => {};

function render(overrides: Partial<ReviewMergeBarViewProps> = {}): string {
  const r = overrides.review === undefined ? review : overrides.review;
  return renderToStaticMarkup(
    <ReviewMergeBarView
      folder={folder}
      review={r}
      open={r ? currentStep(r) : "commit"}
      scope="uncommitted"
      message="Add the review bar"
      busy={null}
      error={null}
      notice={null}
      mode="squash"
      target="main"
      onOpen={noop}
      onScope={noop}
      onMessage={noop}
      onGenerate={noop}
      onCommit={noop}
      onMerge={noop}
      onMode={noop}
      onTarget={noop}
      onPush={noop}
      onRemove={noop}
      {...overrides}
    />,
  );
}

const dirty = (n: number) => ({ review: { ...review, uncommitted: n }, folder: { ...folder, uncommitted: n } });
const labelled = (label: string) => new RegExp(`<button[^>]*>${label}</button>`);
const disabled = (label: string) => new RegExp(`<button[^>]*disabled[^>]*>${label}</button>`);

describe("currentStep", () => {
  it("is commit while anything is uncommitted, merge with commits ahead, clean up once merged", () => {
    expect(currentStep({ ...review, uncommitted: 1 })).toBe("commit");
    expect(currentStep(review)).toBe("merge");
    expect(currentStep({ ...review, merged: { into: "main", upToDate: true } })).toBe("cleanup");
    // New commits after a merge are something to merge again.
    expect(currentStep({ ...review, merged: { into: "main", upToDate: false } })).toBe("merge");
    expect(currentStep({ ...review, ahead: 0 })).toBe("commit");
  });
});

describe("ReviewMergeBarView", () => {
  it("shows where the thread works: its branch, its own worktree and the base", () => {
    const html = render();
    expect(html).toContain("harness/demo");
    expect(html).toContain("own worktree · from main");
  });

  it("opens the commit step when the worktree has uncommitted changes", () => {
    const html = render(dirty(1));
    expect(html).toContain("1 file to commit");
    expect(html).toMatch(labelled("Commit"));
    expect(html).not.toMatch(disabled("Commit"));
    expect(html).not.toContain('aria-label="Branch to merge into"');
  });

  it("says why Commit is off when the message is empty", () => {
    const html = render({ ...dirty(2), message: "" });
    expect(html).toMatch(disabled("Commit"));
    expect(html).toContain("Write a message, or Generate one.");
  });

  it("offers the merge when the worktree is clean and on the base branch", () => {
    const html = render();
    expect(html).not.toContain("review-hint");
    expect(html).toMatch(labelled("Merge"));
    expect(html).not.toMatch(disabled("Merge"));
    expect(html).toContain('aria-label="Branch to merge into"');
    expect(html).toContain("2 commits to merge");
  });

  it("merges into the base even when the project folder is on another branch", () => {
    const html = render({ review: { ...review, projectBranch: "dev", projectDirty: true } });
    expect(html).not.toContain("review-hint");
    expect(html).not.toMatch(disabled("Merge"));
  });

  it("blocks a dirty project folder only when it has the target checked out", () => {
    const html = render({ review: { ...review, projectDirty: true } });
    expect(html).toContain("The project folder has uncommitted changes.");
    expect(html).toMatch(disabled("Merge"));
  });

  it("says why Merge is off when the message is empty, instead of a silent grey button", () => {
    const html = render({ message: "" });
    expect(html).toContain("Write the merge commit&#x27;s message, or Generate one.");
    expect(html).toMatch(disabled("Merge"));
  });

  it("counts commits ahead against the base only, not another target", () => {
    expect(render({ review: { ...review, ahead: 0 }, open: "merge" })).toContain("Nothing to merge yet.");
    expect(render({ review: { ...review, ahead: 0 }, open: "merge", target: "dev" })).not.toContain("Nothing to merge yet.");
  });

  it("remembers a merge: clean up is next, and merging the same commits again is refused", () => {
    const merged = { ...review, merged: { into: "main", upToDate: true } };
    const html = render({ review: merged });
    expect(html).toContain("Merged into main");
    expect(html).toContain("Remove worktree");
    expect(html).not.toMatch(labelled("Merge"));
    const again = render({ review: merged, open: "merge" });
    expect(again).toContain("Already merged into main: no new commits since.");
    expect(again).toMatch(disabled("Merge"));
  });

  it("offers Push with a remote, says Pushed when all is pushed, and hides it without a remote", () => {
    expect(render()).toMatch(labelled("Push"));
    expect(render({ folder: { ...folder, unpushed: 2 } })).toMatch(labelled("Push 2"));
    expect(render({ folder: { ...folder, unpushed: 0 } })).toContain("Pushed");
    expect(render({ folder: { ...folder, remote: null } })).not.toMatch(/>Push/);
  });

  it("gives a project-folder thread Commit and Push but no merge steps or scopes", () => {
    const project: FolderGit = { branch: "main", worktree: false, uncommitted: 3, remote: "origin", unpushed: 1, hasCommits: true };
    const html = render({ folder: project, review: null });
    expect(html).toContain("project folder");
    expect(html).toContain("3 files not committed");
    expect(html).toMatch(labelled("Commit"));
    expect(html).toMatch(labelled("Push 1"));
    expect(html).not.toContain("git-steps");
    expect(html).not.toContain("Changes scope");
  });

  it("labels the scopes in plain words", () => {
    const html = render();
    expect(html).toContain("Not committed");
    expect(html).toContain("Whole branch");
  });

  it("renders an error as an alert", () => {
    const html = render({ error: "The branch moved." });
    expect(html).toContain('role="alert"');
    expect(html).toContain("The branch moved.");
  });

  it("says Writing… while the message is generated", () => {
    expect(render({ busy: "message" })).toContain("Writing…");
  });
});
