import { mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CRITIQUE_ARTIFACT,
  PLAN_ARTIFACT,
  PREVIEWABLE,
  artifactDiff,
  artifactKind,
  editedFilesInTurn,
  filesWrittenSince,
  isPreviewable,
  listArtifacts,
  readArtifact,
  recordPlan,
  recordPseudo,
  recordTurnArtifacts,
  resolveInside,
  type ArtifactDeps,
} from "../src/main/artifacts";
import type { PreviewResult } from "../src/main/preview/host";
import type { ArtifactKind, ArtifactVersion, StoredEvent, ThreadEvent } from "../src/shared/types";
import { tempDir } from "./helpers";

let seq = 0;
function at(event: ThreadEvent): StoredEvent {
  seq += 1;
  return { seq, createdAt: seq, event };
}

const user = (text: string): StoredEvent => at({ kind: "user", text });
const edit = (id: string, summary: string): StoredEvent => at({ kind: "tool-use", toolUseId: id, name: "Edit", summary });
const use = (id: string, name: string, summary: string): StoredEvent => at({ kind: "tool-use", toolUseId: id, name, summary });
const result = (id: string, isError = false): StoredEvent => at({ kind: "tool-result", toolUseId: id, isError, summary: isError ? "failed" : "+1 −1" });

/** An in-memory ArtifactDeps: versions by thread+path, blobs by sha. */
function fakeDeps(overrides: Partial<ArtifactDeps> = {}): { deps: ArtifactDeps; store: Map<string, ArtifactVersion[]> } {
  const store = new Map<string, ArtifactVersion[]>();
  const blobs = new Map<string, Buffer>();
  const deps: ArtifactDeps = {
    addVersion(threadId, path, sha256, bytes, turnSeq) {
      const key = `${threadId}\u0000${path}`;
      const versions = store.get(key) ?? [];
      const last = versions.at(-1);
      if (last && last.sha256 === sha256) return null;
      const version: ArtifactVersion = { version: (last?.version ?? 0) + 1, sha256, bytes, createdAt: 0, turnSeq };
      versions.push(version);
      store.set(key, versions);
      return version;
    },
    listVersions(threadId) {
      const out: { path: string; versions: ArtifactVersion[] }[] = [];
      for (const [key, versions] of store) {
        const [tid, path] = key.split("\u0000") as [string, string];
        if (tid === threadId) out.push({ path, versions });
      }
      return out;
    },
    writeBlob(sha256, content) {
      blobs.set(sha256, content);
    },
    readBlob(sha256) {
      return blobs.get(sha256) ?? Buffer.alloc(0);
    },
    gitHead: async () => null,
    preview: async (): Promise<PreviewResult> => ({ ok: false, error: "no preview" }),
    fileUrl: (threadId, relPath) => `cubiq-file://${threadId}/${relPath}`,
    ...overrides,
  };
  return { deps, store };
}

describe("artifactKind", () => {
  it("maps extensions to kinds, case-insensitively", () => {
    const cases: [string, ArtifactKind][] = [
      ["a.md", "md"],
      ["a.MARKDOWN", "md"],
      ["a.mdx", "md"],
      ["a.html", "html"],
      ["a.htm", "html"],
      ["a.svg", "svg"],
      ["a.pdf", "pdf"],
      ["a.PNG", "image"],
      ["a.jpeg", "image"],
      ["a.avif", "image"],
      ["a.csv", "csv"],
      ["a.tsv", "csv"],
      ["a.docx", "docx"],
      ["a.xlsx", "sheet"],
      ["a.ods", "sheet"],
      ["a.xls", "sheet"],
      ["a.pptx", "pptx"],
      ["a.ts", "code"],
      ["a.tsx", "code"],
      ["a.py", "code"],
      ["a.rs", "code"],
      ["a.sh", "code"],
      ["a.css", "code"],
      ["a.yaml", "code"],
      ["a.xml", "code"],
      ["a.r", "code"],
      ["a.txt", "text"],
      ["noext", "text"],
      ["a.bin", "text"],
    ];
    for (const [path, kind] of cases) expect(artifactKind(path), path).toBe(kind);
    expect(artifactKind("a.MD")).toBe("md");
  });

  it("previews every kind but code and text", () => {
    expect(PREVIEWABLE.has("code")).toBe(false);
    expect(PREVIEWABLE.has("text")).toBe(false);
    expect(isPreviewable("a.md")).toBe(true);
    expect(isPreviewable("a.png")).toBe(true);
    expect(isPreviewable("a.docx")).toBe(true);
    expect(isPreviewable("a.ts")).toBe(false);
    expect(isPreviewable("a.txt")).toBe(false);
  });
});

describe("resolveInside", () => {
  function project(): string {
    const root = tempDir();
    mkdirSync(join(root, "sub"), { recursive: true });
    writeFileSync(join(root, "sub", "a.txt"), "a");
    return root;
  }

  it("accepts nested relative and absolute-inside paths", () => {
    const root = project();
    expect(resolveInside(root, "sub/a.txt")).toBe("sub/a.txt");
    expect(resolveInside(root, join(root, "sub", "a.txt"))).toBe("sub/a.txt");
  });

  it("accepts a not-yet-existing file in an existing directory", () => {
    expect(resolveInside(project(), "sub/new.txt")).toBe("sub/new.txt");
  });

  it("rejects traversal and absolute paths outside the root", () => {
    const root = project();
    const outside = tempDir();
    writeFileSync(join(outside, "out.txt"), "x");
    expect(resolveInside(root, "../x")).toBeNull();
    expect(resolveInside(root, join(outside, "out.txt"))).toBeNull();
  });

  it("rejects a symlink inside the root that points outside", () => {
    const root = project();
    const outside = tempDir();
    writeFileSync(join(outside, "out.txt"), "x");
    symlinkSync(join(outside, "out.txt"), join(root, "link.txt"));
    expect(resolveInside(root, "link.txt")).toBeNull();
  });

  it("rejects the root itself and a missing parent", () => {
    const root = project();
    expect(resolveInside(root, ".")).toBeNull();
    expect(resolveInside(root, "nope/deep.txt")).toBeNull();
  });
});

describe("editedFilesInTurn", () => {
  it("takes only the current turn's successful edits", () => {
    const events = [user("old"), edit("e0", "old.ts"), result("e0"), user("new"), edit("e1", "a.ts, b.ts"), result("e1")];
    expect(editedFilesInTurn(events)).toEqual(["a.ts", "b.ts"]);
  });

  it("ignores failed results, non-Edit tools, and clipped summaries", () => {
    const events = [
      user("go"),
      edit("e1", "fail.ts"),
      result("e1", true),
      use("r1", "Read", "read.ts"),
      result("r1"),
      edit("e2", "ok.ts, clipped.ts…"),
      result("e2"),
    ];
    expect(editedFilesInTurn(events)).toEqual(["ok.ts"]);
  });

  it("moves a re-edited file to the end, deduplicated", () => {
    const events = [user("go"), edit("e1", "a.ts, b.ts"), result("e1"), edit("e2", "a.ts"), result("e2")];
    expect(editedFilesInTurn(events)).toEqual(["b.ts", "a.ts"]);
  });
});

describe("recordTurnArtifacts", () => {
  it("records v1, nothing on an unchanged re-record, and v2 after a change", () => {
    const root = tempDir();
    writeFileSync(join(root, "a.md"), "one\n");
    const { deps } = fakeDeps();
    const events = [user("go"), edit("e1", "a.md"), result("e1")];

    expect(recordTurnArtifacts(deps, { threadId: "t", root, events, turnSeq: 1 })).toEqual({ files: ["a.md"], changed: ["a.md"] });
    const list = listArtifacts(deps, "t");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ path: "a.md", kind: "md" });
    expect(list[0]!.versions.map((v) => v.version)).toEqual([1]);

    expect(recordTurnArtifacts(deps, { threadId: "t", root, events, turnSeq: 2 })).toEqual({ files: ["a.md"], changed: [] });
    expect(deps.listVersions("t")[0]!.versions).toHaveLength(1);

    writeFileSync(join(root, "a.md"), "two\n");
    expect(recordTurnArtifacts(deps, { threadId: "t", root, events, turnSeq: 3 })).toEqual({ files: ["a.md"], changed: ["a.md"] });
    expect(deps.listVersions("t")[0]!.versions.map((v) => v.version)).toEqual([1, 2]);
  });

  it("skips missing files and paths outside the root", () => {
    const root = tempDir();
    const { deps } = fakeDeps();
    const events = [user("go"), edit("e1", "missing.md, ../escape.md"), result("e1")];
    expect(recordTurnArtifacts(deps, { threadId: "t", root, events, turnSeq: 1 })).toEqual({ files: [], changed: [] });
  });

  it("also records a deliverable the turn wrote by command, after the edited files", () => {
    const root = tempDir();
    writeFileSync(join(root, "a.md"), "one\n");
    mkdirSync(join(root, "out-docs"));
    writeFileSync(join(root, "out-docs", "Summary.docx"), "PK");
    const { deps } = fakeDeps();
    const events = [user("go"), edit("e1", "a.md"), result("e1")];
    expect(recordTurnArtifacts(deps, { threadId: "t", root, events, turnSeq: 1, turnStartedAt: Date.now() - 2000 })).toEqual({
      files: ["a.md", "out-docs/Summary.docx"],
      changed: ["a.md", "out-docs/Summary.docx"],
    });
  });

  it("doesn't record a deliverable twice when an Edit already named it", () => {
    const root = tempDir();
    writeFileSync(join(root, "page.html"), "<p>hi</p>");
    const { deps } = fakeDeps();
    const events = [user("go"), edit("e1", "page.html"), result("e1")];
    expect(recordTurnArtifacts(deps, { threadId: "t", root, events, turnSeq: 1, turnStartedAt: Date.now() - 2000 }).files).toEqual(["page.html"]);
  });

  it("doesn't record what another thread wrote in its design folder meanwhile", () => {
    const root = tempDir();
    mkdirSync(join(root, "designs/bbbbbbbb"), { recursive: true });
    writeFileSync(join(root, "designs/bbbbbbbb/index.html"), "<p>theirs</p>");
    writeFileSync(join(root, "chart.png"), "png");
    const { deps } = fakeDeps();
    const input = { threadId: "t", root, events: [user("go")], turnSeq: 1, turnStartedAt: Date.now() - 2000 };
    expect(recordTurnArtifacts(deps, { ...input, skipDirs: ["designs/bbbbbbbb"] }).files).toEqual(["chart.png"]);
  });
});

describe("filesWrittenSince", () => {
  const old = (path: string) => utimesSync(path, new Date(1_000_000), new Date(1_000_000));

  it("finds deliverables changed since the turn began, oldest first", () => {
    const root = tempDir();
    const since = Date.now() - 2000;
    writeFileSync(join(root, "first.pdf"), "%PDF");
    utimesSync(join(root, "first.pdf"), new Date(since + 100), new Date(since + 100));
    writeFileSync(join(root, "report.docx"), "PK");
    writeFileSync(join(root, "stale.xlsx"), "PK");
    old(join(root, "stale.xlsx"));
    expect(filesWrittenSince(root, since)).toEqual(["first.pdf", "report.docx"]);
  });

  it("leaves out code, markdown and text, which a command writes all the time", () => {
    const root = tempDir();
    for (const f of ["build.js", "notes.md", "log.txt", "chart.png"]) writeFileSync(join(root, f), "x");
    expect(filesWrittenSince(root, Date.now() - 2000)).toEqual(["chart.png"]);
  });

  it("skips dot-folders, dependencies and build output", () => {
    const root = tempDir();
    for (const dir of [".git", ".venv", "node_modules", "dist", "build"]) {
      mkdirSync(join(root, dir));
      writeFileSync(join(root, dir, "x.pdf"), "%PDF");
    }
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs", "kept.pdf"), "%PDF");
    expect(filesWrittenSince(root, Date.now() - 2000)).toEqual(["docs/kept.pdf"]);
  });

  it("skips the folders it is told to (other threads' designs), and only those", () => {
    const root = tempDir();
    for (const dir of ["designs/aaaaaaaa", "designs/bbbbbbbb/refs"]) mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, "designs/aaaaaaaa/index.html"), "<p>mine</p>");
    writeFileSync(join(root, "designs/bbbbbbbb/index.html"), "<p>theirs</p>");
    writeFileSync(join(root, "designs/bbbbbbbb/refs/ref-1.png"), "png");
    const since = Date.now() - 2000;
    expect(filesWrittenSince(root, since, ["designs/bbbbbbbb"])).toEqual(["designs/aaaaaaaa/index.html"]);
    expect(filesWrittenSince(root, since).sort()).toEqual(["designs/aaaaaaaa/index.html", "designs/bbbbbbbb/index.html", "designs/bbbbbbbb/refs/ref-1.png"]);
  });

  it("returns nothing for a folder that doesn't exist", () => {
    expect(filesWrittenSince(join(tempDir(), "gone"), 0)).toEqual([]);
  });
});

describe("readArtifact", () => {
  it("reads markdown text from disk", async () => {
    const root = tempDir();
    writeFileSync(join(root, "note.md"), "# hi\n");
    const { deps } = fakeDeps();
    const content = await readArtifact(deps, { threadId: "t", root, path: "note.md" });
    expect(content).toMatchObject({ ok: true, path: "note.md", kind: "md", version: null, text: "# hi\n" });
  });

  it("reads a saved version from the blob store", async () => {
    const root = tempDir();
    writeFileSync(join(root, "note.md"), "v1\n");
    const { deps } = fakeDeps();
    const events = [user("go"), edit("e1", "note.md"), result("e1")];
    recordTurnArtifacts(deps, { threadId: "t", root, events, turnSeq: 1 });
    writeFileSync(join(root, "note.md"), "v2\n");
    const content = await readArtifact(deps, { threadId: "t", root, path: "note.md", version: 1 });
    expect(content).toMatchObject({ ok: true, kind: "md", version: 1, text: "v1\n" });
  });

  it("refuses a path outside the root", async () => {
    const { deps } = fakeDeps();
    expect(await readArtifact(deps, { threadId: "t", root: tempDir(), path: "../secret.md" })).toEqual({ ok: false, error: "Outside the project folder" });
  });

  it("returns a file URL for an image", async () => {
    const root = tempDir();
    writeFileSync(join(root, "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const { deps } = fakeDeps();
    const content = await readArtifact(deps, { threadId: "t", root, path: "pic.png" });
    expect(content).toMatchObject({ ok: true, kind: "image", bytes: 4, url: "cubiq-file://t/pic.png" });
  });

  it("renders docx through the preview dependency", async () => {
    const root = tempDir();
    writeFileSync(join(root, "doc.docx"), "not really a docx");
    const preview: PreviewResult = { ok: true, result: { kind: "docx", html: "<p>hi</p>", warnings: [] } };
    const { deps } = fakeDeps({ preview: async () => preview });
    const content = await readArtifact(deps, { threadId: "t", root, path: "doc.docx" });
    expect(content).toMatchObject({ ok: true, kind: "docx", office: { kind: "docx", html: "<p>hi</p>" } });
  });

  it("reports a missing file", async () => {
    expect(await readArtifact(fakeDeps().deps, { threadId: "t", root: tempDir(), path: "nope.md" })).toEqual({ ok: false, error: "File not found" });
  });
});

describe("artifactDiff", () => {
  it("diffs the first version against git HEAD", async () => {
    const root = tempDir();
    writeFileSync(join(root, "f.md"), "new line\n");
    const { deps } = fakeDeps({ gitHead: async () => "old line\n" });
    const events = [user("go"), edit("e1", "f.md"), result("e1")];
    recordTurnArtifacts(deps, { threadId: "t", root, events, turnSeq: 1 });

    const diff = await artifactDiff(deps, { threadId: "t", root, path: "f.md", version: 1 });
    expect(diff).toContain("-old line");
    expect(diff).toContain("+new line");
  });

  it("diffs a later version against the one before it", async () => {
    const root = tempDir();
    const { deps } = fakeDeps({ gitHead: async () => "old line\n" });
    const events = [user("go"), edit("e1", "f.md"), result("e1")];
    writeFileSync(join(root, "f.md"), "new line\n");
    recordTurnArtifacts(deps, { threadId: "t", root, events, turnSeq: 1 });
    writeFileSync(join(root, "f.md"), "newer line\n");
    recordTurnArtifacts(deps, { threadId: "t", root, events, turnSeq: 2 });

    const diff = await artifactDiff(deps, { threadId: "t", root, path: "f.md", version: 2 });
    expect(diff).toContain("-new line");
    expect(diff).toContain("+newer line");
  });

  it("is null for non-text kinds and escaping paths", async () => {
    const root = tempDir();
    writeFileSync(join(root, "pic.png"), "x");
    const { deps } = fakeDeps();
    expect(await artifactDiff(deps, { threadId: "t", root, path: "pic.png" })).toBeNull();
    expect(await artifactDiff(deps, { threadId: "t", root, path: "../x.md" })).toBeNull();
  });
});

describe("plan artifact", () => {
  it("keeps one version per changed plan, served from the store with nothing on disk", async () => {
    const root = tempDir();
    let gitAsked = false;
    const { deps } = fakeDeps({ gitHead: async () => ((gitAsked = true), "git") });
    expect(recordPlan(deps, { threadId: "t", text: "# One\n", turnSeq: 3 })?.version).toBe(1);
    expect(recordPlan(deps, { threadId: "t", text: "# One\n", turnSeq: 5 })).toBeNull();
    expect(recordPlan(deps, { threadId: "t", text: "   ", turnSeq: 6 })).toBeNull();
    expect(recordPlan(deps, { threadId: "t", text: "# Two\n", turnSeq: 7 })?.version).toBe(2);

    expect(listArtifacts(deps, "t")).toEqual([expect.objectContaining({ path: PLAN_ARTIFACT, kind: "md" })]);
    expect(await readArtifact(deps, { threadId: "t", root, path: PLAN_ARTIFACT })).toMatchObject({ ok: true, kind: "md", text: "# Two\n", version: null });
    expect(await readArtifact(deps, { threadId: "t", root, path: PLAN_ARTIFACT, version: 1 })).toMatchObject({ ok: true, text: "# One\n", version: 1 });
    expect(await readArtifact(deps, { threadId: "t", root, path: PLAN_ARTIFACT, version: 9 })).toEqual({ ok: false, error: "No such version" });
    expect(await readArtifact(deps, { threadId: "other", root, path: PLAN_ARTIFACT })).toEqual({ ok: false, error: "No plan yet" });

    const first = await artifactDiff(deps, { threadId: "t", root, path: PLAN_ARTIFACT, version: 1 });
    expect(first).toContain("+# One");
    const second = await artifactDiff(deps, { threadId: "t", root, path: PLAN_ARTIFACT });
    expect(second).toContain("-# One");
    expect(second).toContain("+# Two");
    // The diff names the plan, not its internal path.
    expect(second).not.toContain(PLAN_ARTIFACT);
    expect(await artifactDiff(deps, { threadId: "other", root, path: PLAN_ARTIFACT })).toBeNull();
    expect(gitAsked).toBe(false);
  });
});

describe("opensByItself", () => {
  it("opens deliverables at turn end, never markdown or code", async () => {
    const { opensByItself } = await import("../src/shared/artifact-kind");
    expect(["deck.pptx", "report.docx", "data.xlsx", "page.html", "chart.svg", "a.pdf", "shot.png", "t.csv"].every(opensByItself)).toBe(true);
    expect(["notes/limits.md", "src/a.ts", "README", "x.txt"].some(opensByItself)).toBe(false);
  });
});

describe("critique artifact", () => {
  it("is stored like the plan, under its own path, named Critique in diffs", async () => {
    const root = tempDir();
    const { deps } = fakeDeps({ gitHead: async () => "git" });
    expect(recordPseudo(deps, CRITIQUE_ARTIFACT, { threadId: "t", text: "# A\n", turnSeq: 1 })?.version).toBe(1);
    expect(recordPseudo(deps, CRITIQUE_ARTIFACT, { threadId: "t", text: "# A\n", turnSeq: 2 })).toBeNull();
    expect(recordPseudo(deps, CRITIQUE_ARTIFACT, { threadId: "t", text: "# B\n", turnSeq: 3 })?.version).toBe(2);
    expect(await readArtifact(deps, { threadId: "t", root, path: CRITIQUE_ARTIFACT })).toMatchObject({ ok: true, kind: "md", text: "# B\n", path: CRITIQUE_ARTIFACT });
    expect(await readArtifact(deps, { threadId: "other", root, path: CRITIQUE_ARTIFACT })).toEqual({ ok: false, error: "No critique yet" });
    const diff = await artifactDiff(deps, { threadId: "t", root, path: CRITIQUE_ARTIFACT });
    expect(diff).toContain("+# B");
    expect(diff).toContain("Critique");
    expect(diff).not.toContain(CRITIQUE_ARTIFACT);
    // The plan's own record is untouched.
    expect(await readArtifact(deps, { threadId: "t", root, path: PLAN_ARTIFACT })).toEqual({ ok: false, error: "No plan yet" });
  });
});
