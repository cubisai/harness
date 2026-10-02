/// <reference types="vite/client" />
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArtifactContent, ArtifactKind } from "../src/shared/types";

// The panel imports the api, which reads window.unskilled at call time only;
// the static render tests call no api method, but stub the bridge anyway.
vi.stubGlobal("window", { unskilled: { readArtifact: vi.fn(), artifactDiff: vi.fn() } });

const load = () => import("../src/renderer/src/components/ArtifactPanel");

describe("visibleRows", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns the top window with the overscan clamped at 0", async () => {
    const { visibleRows } = await load();
    expect(visibleRows(0, 260, 26, 1000)).toEqual({ start: 0, end: 30 });
  });

  it("windows the middle with overscan on both sides", async () => {
    const { visibleRows } = await load();
    expect(visibleRows(2600, 260, 26, 1000, 20)).toEqual({ start: 80, end: 130 });
  });

  it("clamps the end at total near the bottom", async () => {
    const { visibleRows } = await load();
    expect(visibleRows(25740, 260, 26, 1000)).toEqual({ start: 970, end: 1000 });
  });

  it("returns the whole set when total fits inside the viewport", async () => {
    const { visibleRows } = await load();
    expect(visibleRows(0, 1000, 26, 5)).toEqual({ start: 0, end: 5 });
  });
});

describe("defaultTab", () => {
  it("sends code and text to Source, everything else to Preview", async () => {
    const { defaultTab } = await load();
    expect(defaultTab("code")).toBe("source");
    expect(defaultTab("text")).toBe("source");
    const previewKinds: ArtifactKind[] = ["md", "html", "svg", "pdf", "image", "csv", "docx", "sheet", "pptx"];
    for (const kind of previewKinds) expect(defaultTab(kind)).toBe("preview");
  });
});

describe("svgDataUri", () => {
  it("encodes the SVG as a data: URI and never leaves raw markup", async () => {
    const { svgDataUri } = await load();
    const uri = svgDataUri('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');
    expect(uri.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
    expect(uri).not.toContain("<svg");
  });
});

describe("ArtifactBody", () => {
  afterEach(() => vi.unstubAllGlobals());

  const render = async (content: ArtifactContent | null, tab: "preview" | "source" | "diff", diff: string | null | undefined = null) => {
    const { ArtifactBody } = await load();
    return renderToStaticMarkup(<ArtifactBody content={content} tab={tab} diff={diff} />);
  };

  it("renders markdown as headings, not raw HTML", async () => {
    const content: ArtifactContent = { ok: true, path: "docs/a.md", kind: "md", bytes: 12, version: null, text: "# Title\n\nBody text" };
    const html = await render(content, "preview");
    expect(html).toContain("<h1");
    expect(html).toContain("Title");
  });

  it("sandboxes html in an iframe with no scripts", async () => {
    const content: ArtifactContent = { ok: true, path: "a.html", kind: "html", bytes: 12, version: null, text: "<h1>hi</h1>" };
    const html = await render(content, "preview");
    expect(html).toContain("<iframe");
    expect(html).toContain('sandbox=""');
    expect(html).not.toContain("allow-scripts");
  });

  it("renders svg as an img data URI, never inline markup", async () => {
    const content: ArtifactContent = { ok: true, path: "a.svg", kind: "svg", bytes: 12, version: null, text: "<svg><circle/></svg>" };
    const html = await render(content, "preview");
    expect(html).toContain("data:image/svg+xml;charset=utf-8,");
    expect(html).not.toContain("<svg");
  });

  it("renders a sheet as a table with a header row and a truncation note", async () => {
    const content: ArtifactContent = {
      ok: true,
      path: "data.xlsx",
      kind: "sheet",
      bytes: 12,
      version: null,
      office: {
        kind: "sheet",
        sheets: [{ name: "Sheet1", rows: [["Name", "Age"], ["Ada", "36"], ["Alan", "41"]], totalRows: 900, truncated: true }],
      },
    };
    const html = await render(content, "preview");
    expect(html).toContain("<table");
    expect(html).toContain("<thead");
    expect(html).toContain("Name");
    expect(html).toContain("Showing the first");
  });

  it("renders each pptx slide's label and title", async () => {
    const content: ArtifactContent = {
      ok: true,
      path: "deck.pptx",
      kind: "pptx",
      bytes: 12,
      version: null,
      office: {
        kind: "pptx",
        slides: [
          { index: 1, title: "Intro", texts: ["Hello"], images: [] },
          { index: 2, title: "End", texts: [], images: [] },
        ],
      },
    };
    const html = await render(content, "preview");
    expect(html).toContain("Slide 1");
    expect(html).toContain("Intro");
    expect(html).toContain("Slide 2");
    expect(html).toContain("End");
  });

  it("renders source with a line-number gutter", async () => {
    const content: ArtifactContent = { ok: true, path: "a.ts", kind: "code", bytes: 12, version: null, text: "const a = 1;\nconst b = 2;" };
    const html = await render(content, "source");
    expect(html).toContain("artifact-gutter");
    expect(html).toContain(">1<");
    expect(html).toContain(">2<");
    expect(html).toContain("const a = 1;");
  });

  it("tints added and deleted diff lines", async () => {
    const text = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n-old line\n+new line\n context\n";
    const content: ArtifactContent = { ok: true, path: "a.ts", kind: "code", bytes: 12, version: null, text: "" };
    const html = await render(content, "diff", text);
    expect(html).toContain("artifact-diff-line add");
    expect(html).toContain("artifact-diff-line del");
    expect(html).toContain("new line");
    expect(html).toContain("old line");
  });

  it("says there is no diff for a binary or null diff", async () => {
    const content: ArtifactContent = { ok: true, path: "a.png", kind: "image", bytes: 12, version: null, url: "cubiq-file://x" };
    const html = await render(content, "diff", null);
    expect(html).toContain("No diff for this file type");
  });

  it("says there are no changes when the diff has no hunks", async () => {
    const content: ArtifactContent = { ok: true, path: "a.ts", kind: "code", bytes: 12, version: null, text: "" };
    const html = await render(content, "diff", "diff --git a/a.ts b/a.ts\n");
    expect(html).toContain("No changes");
  });

  it("shows the error state with the message", async () => {
    const content: ArtifactContent = { ok: false, error: "Permission denied" };
    const html = await render(content, "preview");
    expect(html).toContain("Can&#x27;t preview");
    expect(html).toContain("Permission denied");
  });
});
