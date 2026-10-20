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
      onScope={noop}
      onMessage={noop}
      onGenerate={noop}
      onCommit={noop}
      onMerge={noop}
      onMode={noop}
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
    expect(html).toMatch(labelled("Merge into main"));
    expect(html).not.toMatch(disabled("Merge into main"));
  });

  it("asks to switch the project branch when it is not the base", () => {
    const html = render({ review: { ...review, projectBranch: "dev" } });
    expect(html).toContain("The project is on dev; switch it to main to merge.");
  });

  it("shows Remove worktree once merged, and no merge button", () => {
    const html = render({ merged: true, notice: "Merged into main (2222222)." });
    expect(html).toContain("Remove worktree");
    expect(html).not.toContain("Merge into");
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
