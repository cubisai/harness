/// <reference types="vite/client" />
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchHit } from "../src/shared/types";

// Follows test/about.test.tsx: stub the bridge, then import the component.
const load = async () => {
  vi.stubGlobal("window", {
    unskilled: {
      search: vi.fn(() => Promise.resolve({ threads: [], messages: [] })),
      listFiles: vi.fn(() => Promise.resolve({ files: [], truncated: false })),
    },
  });
  return import("../src/renderer/src/components/SearchDialog");
};

const hit = (kind: SearchHit["kind"], threadId: string, seq: number | null): SearchHit => ({
  threadId,
  projectId: "p1",
  title: "Thread one",
  agent: "claude",
  seq,
  kind,
  snippet: "",
  updatedAt: 0,
});

describe("snippetParts", () => {
  it("splits marked spans from the plain text", async () => {
    const { snippetParts } = await load();
    expect(snippetParts("a\u0001b\u0002c")).toEqual([
      { text: "a", mark: false },
      { text: "b", mark: true },
      { text: "c", mark: false },
    ]);
  });

  it("tolerates an unclosed mark and drops a stray end marker", async () => {
    const { snippetParts } = await load();
    expect(snippetParts("a\u0001b")).toEqual([
      { text: "a", mark: false },
      { text: "b", mark: true },
    ]);
    expect(snippetParts("a\u0002b")).toEqual([{ text: "ab", mark: false }]);
  });
});

describe("rankFiles", () => {
  it("ranks a basename substring over a path substring over a subsequence", async () => {
    const { rankFiles } = await load();
    const files = ["src/b/u/t/t/o/n.ts", "docs/readme.md", "src/buttoncss/x.ts", "src/deep/Button.tsx"];
    expect(rankFiles(files, "button", 10)).toEqual([
      "src/deep/Button.tsx",
      "src/buttoncss/x.ts",
      "src/b/u/t/t/o/n.ts",
    ]);
  });

  it("matches nothing for empty text, and honors the limit", async () => {
    const { rankFiles } = await load();
    expect(rankFiles(["a/button.ts"], "  ", 10)).toEqual([]);
    expect(rankFiles(["a/button.ts", "b/button.ts"], "button", 1)).toEqual(["a/button.ts"]);
  });
});

describe("searchKeyOf", () => {
  it("is null when the input asks for no full-text search", async () => {
    const { searchKeyOf } = await load();
    expect(searchKeyOf("", { id: "all" }, "p1")).toBeNull();
    expect(searchKeyOf("   ", { id: "all" }, "p1")).toBeNull();
    expect(searchKeyOf(">x", { id: "all" }, "p1")).toBeNull();
    expect(searchKeyOf("abc", { id: "files" }, "p1")).toBeNull();
  });

  it("is equal for the same trimmed text, filter and project", async () => {
    const { searchKeyOf } = await load();
    const filter = { id: "all" } as const;
    expect(searchKeyOf("abc", filter, "p1")).toBe(searchKeyOf("  abc  ", filter, "p1"));
  });

  it("differs when the filter or the project changes", async () => {
    const { searchKeyOf } = await load();
    const base = searchKeyOf("abc", { id: "all" }, "p1");
    expect(searchKeyOf("abc", { id: "running" }, "p1")).not.toBe(base);
    expect(searchKeyOf("abc", { id: "all" }, "p2")).not.toBe(base);
  });
});

describe("flattenRows", () => {
  it("orders Threads, then Messages, then Files", async () => {
    const { flattenRows } = await load();
    const rows = flattenRows({
      threads: [hit("title", "t", null)],
      messages: [hit("user", "m1", 1), hit("assistant-text", "m2", 2)],
      files: ["src/a.ts"],
    });
    expect(rows.map((r) => r.kind)).toEqual(["thread", "message", "message", "file"]);
  });
});

describe("emptyListState", () => {
  it("shows the hint when the query is empty, whatever else is set", async () => {
    const { emptyListState } = await load();
    expect(emptyListState({ hint: true, rows: 0, pending: true, failed: "boom" })).toBe("hint");
    expect(emptyListState({ hint: true, rows: 3, pending: false, failed: null })).toBe("hint");
  });

  it("returns null while there are rows", async () => {
    const { emptyListState } = await load();
    expect(emptyListState({ hint: false, rows: 1, pending: true, failed: "boom" })).toBeNull();
  });

  it("shows the error over the searching line", async () => {
    const { emptyListState } = await load();
    expect(emptyListState({ hint: false, rows: 0, pending: true, failed: "boom" })).toBe("error");
  });

  it("shows a searching line while a request is pending", async () => {
    const { emptyListState } = await load();
    expect(emptyListState({ hint: false, rows: 0, pending: true, failed: null })).toBe("searching");
  });

  it("falls back to the empty message", async () => {
    const { emptyListState } = await load();
    expect(emptyListState({ hint: false, rows: 0, pending: false, failed: null })).toBe("empty");
  });
});

describe("relativeTime", () => {
  it("uses relative buckets, then a short date", async () => {
    const { relativeTime } = await load();
    const now = 1_700_000_000_000;
    expect(relativeTime(now - 30_000, now)).toBe("now");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5m");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3h");
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe("2d");
    const older = new Date(2026, 8, 4, 12).getTime();
    const later = new Date(2026, 8, 20, 12).getTime();
    expect(relativeTime(older, later)).toBe("Sep 4");
  });
});

describe("SearchDialog static render", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows the input, the chips (one per agent), and the footer hints", async () => {
    const { SearchDialog } = await load();
    const html = renderToStaticMarkup(
      <SearchDialog
        projectId={null}
        projects={[{ id: "p1", name: "CubiQ" }]}
        agents={[{ id: "claude", label: "Claude" }]}
        runningThreadIds={[]}
        onOpenThread={() => {}}
        onOpenFile={() => {}}
        onActions={() => {}}
        onClose={() => {}}
      />,
    );
    expect(html).toMatch(/<input[^>]*class="search-input"/);
    expect(html).toContain("Search threads, messages and files");
    expect(html).toContain(">All<");
    expect(html).toContain(">This project<");
    expect(html).toContain(">Running<");
    expect(html).toContain(">Claude<");
    expect(html).toContain(">Files<");
    expect(html).toContain("↑↓ move");
    expect(html).toContain("esc close");
  });

  it("disables This project and Files without a selected project", async () => {
    const { SearchDialog } = await load();
    const html = renderToStaticMarkup(
      <SearchDialog
        projectId={null}
        projects={[]}
        agents={[]}
        runningThreadIds={[]}
        onOpenThread={() => {}}
        onOpenFile={() => {}}
        onActions={() => {}}
        onClose={() => {}}
      />,
    );
    expect(html).toMatch(/<button[^>]*disabled[^>]*>This project<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Files<\/button>/);
  });
});

describe("SearchSnippet", () => {
  it("wraps matched terms in mark and escapes script text", async () => {
    const { SearchSnippet } = await load();
    const html = renderToStaticMarkup(<SearchSnippet snippet={"before \u0001<script>\u0002 after"} />);
    expect(html).toContain('<mark class="search-mark">');
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
});
