import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { WorktreeReview } from "../src/shared/types";
import { ReviewMergeBarView, type ReviewMergeBarViewProps } from "../src/renderer/src/components/ReviewMergeBar";

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
};

const noop = () => {};

function render(overrides: Partial<ReviewMergeBarViewProps> = {}): string {
  return renderToStaticMarkup(
    <ReviewMergeBarView
      review={review}
      scope="uncommitted"
      message="Add the review bar"
      busy={null}
      error={null}
      notice={null}
      merged={false}
      mode="squash"
      target="main"
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

const labelled = (label: string) => new RegExp(`<button[^>]*>${label}</button>`);
const disabled = (label: string) => new RegExp(`<button[^>]*disabled[^>]*>${label}</button>`);

describe("ReviewMergeBarView", () => {
  it("says to commit first when the worktree has uncommitted changes", () => {
    const html = render({ review: { ...review, uncommitted: 1 } });
    expect(html).toContain("Commit the worktree&#x27;s changes first.");
    expect(html).toMatch(labelled("Commit"));
    expect(html).not.toMatch(disabled("Commit"));
  });

  it("offers the merge when the worktree is clean and on the base branch", () => {
    const html = render();
    expect(html).not.toContain("review-hint");
    expect(html).toMatch(labelled("Merge"));
    expect(html).not.toMatch(disabled("Merge"));
    expect(html).toContain('aria-label="Branch to merge into"');
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
    expect(render({ review: { ...review, ahead: 0 } })).toContain("Nothing to merge yet.");
    expect(render({ review: { ...review, ahead: 0 }, target: "dev" })).not.toContain("Nothing to merge yet.");
  });

  it("offers Push with a remote and holds it without one or when all is pushed", () => {
    expect(render()).not.toMatch(disabled("Push"));
    expect(render({ review: { ...review, remote: null } })).toMatch(disabled("Push"));
    const pushed = render({ review: { ...review, unpushed: 0 } });
    expect(pushed).toMatch(disabled("Push"));
    expect(pushed).toContain('title="Everything is pushed."');
    expect(render({ review: { ...review, unpushed: 2 } })).toContain("· 2 unpushed");
  });

  it("shows Remove worktree once merged, and no merge button", () => {
    const html = render({ merged: true, notice: "Merged into main (2222222)." });
    expect(html).toContain("Remove worktree");
    expect(html).not.toMatch(labelled("Merge"));
  });

  it("renders an error as an alert", () => {
    const html = render({ error: "The branch moved." });
    expect(html).toContain('role="alert"');
    expect(html).toContain("The branch moved.");
  });

  it("says Writing… while the message is generated", () => {
    const html = render({ busy: "message" });
    expect(html).toContain("Writing…");
  });
});
