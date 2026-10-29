import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildTree, FilesPanel } from "../src/renderer/src/components/FilesPanel";

describe("buildTree", () => {
  it("nests by directory, directories first, each alphabetical ignoring case", () => {
    const tree = buildTree(["b.txt", "src/z.ts", "src/a/x.ts", "A.md"]);
    expect(tree.map((n) => n.name)).toEqual(["src", "A.md", "b.txt"]);
    expect(tree[0]!.children?.map((n) => n.name)).toEqual(["a", "z.ts"]);
  });
});

describe("FilesPanel", () => {
  it("shows Loading… before the first result", () => {
    expect(renderToStaticMarkup(<FilesPanel projectId="p" refreshKey={0} />)).toContain("Loading…");
  });
});
