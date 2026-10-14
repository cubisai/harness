import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BLOCK_CAP, GLOBAL_SCOPE, INDEX_CAP, MemoryStore, parseFact, serializeFact, slugFor } from "../src/main/memory/store";
import { tempDir } from "./helpers";

/** The fact files a memory block names, in the order they appear. */
function blockFiles(text: string): string[] {
  return text.split("\n").flatMap((line) => {
    const m = /^- \[[^\]]*\]\(([^)]+)\)/.exec(line);
    return m ? [m[1]!] : [];
  });
}

describe("parseFact / serializeFact", () => {
  it("round-trips a fact through the wire format", () => {
    const fact = { name: "Commit Style", description: 'Keep "quotes" and a\nnewline under 150', type: "feedback" as const, body: "# Body\n\nSome text." };
    expect(parseFact("commit-style.md", serializeFact(fact))).toEqual({ file: "commit-style.md", ...fact });
  });

  it("accepts CRLF, a BOM, a top-level type, and quoted values", () => {
    const text = '\uFEFF---\r\nname: "My Fact"\r\ndescription: \'Quoted desc\'\r\ntype: reference\r\n---\r\n\r\nBody line\r\n';
    const fact = parseFact("my-fact.md", text);
    expect(fact.name).toBe("My Fact");
    expect(fact.description).toBe("Quoted desc");
    expect(fact.type).toBe("reference");
    expect(fact.body.trim()).toBe("Body line");
  });

  it("falls back to the basename and project type when frontmatter is missing", () => {
    const fact = parseFact("plain-note.md", "Just a note.");
    expect(fact.name).toBe("plain-note");
    expect(fact.type).toBe("project");
    expect(fact.description).toBe("");
    expect(fact.body).toBe("Just a note.");
  });

  it("treats an unknown type as project", () => {
    expect(parseFact("x.md", '---\nname: x\ndescription: "d"\nmetadata:\n  type: mystery\n---\n\nb').type).toBe("project");
  });

  it("reads an updated date and omits the key when the file has none", () => {
    const dated = parseFact("x.md", '---\nname: x\ndescription: "d"\nupdated: 2026-10-14\nmetadata:\n  type: project\n---\n\nb');
    expect(dated.updated).toBe("2026-10-14");
    const plain = parseFact("x.md", '---\nname: x\ndescription: "d"\nmetadata:\n  type: project\n---\n\nb');
    expect(plain).toEqual({ file: "x.md", name: "x", description: "d", type: "project", body: "b" });
    expect("updated" in plain).toBe(false);
  });

  it("writes updated right after description, and leaves the old output untouched without it", () => {
    expect(serializeFact({ name: "Plain", description: "d", type: "project", body: "b" })).toBe('---\nname: Plain\ndescription: "d"\nmetadata:\n  type: project\n---\n\nb');
    expect(serializeFact({ name: "Plain", description: "d", type: "project", body: "b", updated: "2026-01-02" })).toBe('---\nname: Plain\ndescription: "d"\nupdated: 2026-01-02\nmetadata:\n  type: project\n---\n\nb');
  });
});

describe("slugFor", () => {
  it("lowercases and dashes non-alphanumerics", () => {
    expect(slugFor("Commit Style!", new Set())).toBe("commit-style.md");
  });

  it("prefixes Windows reserved names", () => {
    expect(slugFor("CON", new Set())).toBe("m-con.md");
  });

  it("appends a counter on a collision", () => {
    expect(slugFor("Commit Style!", new Set(["commit-style.md"]))).toBe("commit-style-2.md");
    expect(slugFor("Commit Style!", new Set(["commit-style.md", "commit-style-2.md"]))).toBe("commit-style-3.md");
  });

  it("caps the slug at 60 characters and falls back for an empty one", () => {
    expect(slugFor("a".repeat(100), new Set())).toBe(`${"a".repeat(60)}.md`);
    expect(slugFor("***", new Set())).toBe("memory.md");
  });
});

describe("MemoryStore", () => {
  it("writes, lists, and reads a fact", () => {
    const store = new MemoryStore(tempDir(), () => new Date("2026-10-14T10:00:00Z"));
    const file = store.write("p1", { name: "Commit Style", description: "Max 150 chars", type: "feedback", body: "Keep it short." });
    expect(file).toBe("commit-style.md");
    expect(store.list("p1")).toEqual([{ file: "commit-style.md", name: "Commit Style", description: "Max 150 chars", type: "feedback", updated: "2026-10-14" }]);
    expect(store.read("p1", file)).toEqual({ file: "commit-style.md", name: "Commit Style", description: "Max 150 chars", type: "feedback", updated: "2026-10-14", body: "Keep it short." });
  });

  it("rejects path-shaped and index filenames", () => {
    const store = new MemoryStore(tempDir());
    for (const bad of ["../x.md", "a/b.md", "a\\b.md", "MEMORY.md"]) {
      expect(store.read("p1", bad)).toBeNull();
      expect(store.remove("p1", bad)).toBe(false);
      expect(() => store.write("p1", { name: "x", description: "", type: "project", body: "", file: bad })).toThrow();
    }
  });

  it("rebuilds the index, keeping hand-written lines and dropping dead links", () => {
    const store = new MemoryStore(tempDir());
    store.write("p1", { name: "Alpha", description: "first", type: "project", body: "a" });
    store.write("p1", { name: "Beta", description: "second", type: "project", body: "b" });
    const indexPath = join(store.dir("p1"), "MEMORY.md");
    writeFileSync(indexPath, "# Memory\n\n- [Alpha](alpha.md) — old hook\n- note to self\n- [Gone](gone.md) — dead\n");
    store.write("p1", { name: "Gamma", description: "third", type: "project", body: "c" });
    const text = readFileSync(indexPath, "utf8");
    const lines = text.replace(/\n$/, "").split("\n");
    expect(lines[0]).toBe("# Memory");
    expect(lines[1]).toBe("");
    // Claude's own hook survives a write of a different fact untouched.
    expect(lines[2]).toBe("- [Alpha](alpha.md) — old hook");
    expect(lines[3]).toBe("- note to self");
    expect(text).not.toContain("gone.md");
    expect(lines).toContain("- [Beta](beta.md) — second");
    expect(lines).toContain("- [Gamma](gamma.md) — third");
    expect(text.endsWith("\n")).toBe(true);
  });

  it("keeps a Claude-written line on another fact's write and rewrites only the written fact's line", () => {
    const store = new MemoryStore(tempDir());
    store.write("p1", { name: "Tabs", description: "starter", type: "project", body: "tabs" });
    const indexPath = join(store.dir("p1"), "MEMORY.md");
    writeFileSync(indexPath, "# Memory\n\n- [Tabs over spaces](tabs.md) — use tabs\n");
    // A different fact: Claude's nicer title/hook stays verbatim.
    store.write("p1", { name: "Deploy", description: "ship it", type: "project", body: "d" });
    let text = readFileSync(indexPath, "utf8");
    expect(text).toContain("- [Tabs over spaces](tabs.md) — use tabs");
    // tabs.md itself: its line is rebuilt from the file.
    store.write("p1", { name: "Tabs over spaces", description: "keep tabs", type: "project", body: "tabs", file: "tabs.md" });
    text = readFileSync(indexPath, "utf8");
    expect(text).toContain("- [Tabs over spaces](tabs.md) — keep tabs");
    expect(text).not.toContain("use tabs");
  });

  it("removes a fact and its index line", () => {
    const store = new MemoryStore(tempDir());
    store.write("p1", { name: "Alpha", description: "first", type: "project", body: "a" });
    expect(store.remove("p1", "alpha.md")).toBe(true);
    expect(store.remove("p1", "alpha.md")).toBe(false);
    expect(store.list("p1")).toEqual([]);
    expect(store.index("p1").text).toBe("");
  });

  it("returns an empty index for an empty store", () => {
    const store = new MemoryStore(tempDir());
    expect(store.index("p1")).toEqual({ text: "", lines: 0, tokens: 0 });
  });

  it("caps the index by lines and characters, ending with the truncation notice", () => {
    const store = new MemoryStore(tempDir());
    const dir = store.dir("p1");
    for (let i = 0; i < 250; i++) {
      const n = String(i).padStart(3, "0");
      writeFileSync(join(dir, `fact-${n}.md`), serializeFact({ name: `Fact ${n}`, description: `hook ${i}`, type: "project", body: `body ${i}` }));
    }
    store.rebuildIndex("p1");
    const idx = store.index("p1");
    expect(idx.lines).toBeLessThanOrEqual(INDEX_CAP.lines);
    expect(idx.text.split("\n").pop()!.startsWith("- … ")).toBe(true);
    expect(idx.text.length).toBeLessThanOrEqual(INDEX_CAP.chars);
    expect(idx.tokens).toBe(Math.ceil(idx.text.length / 4));
  });
});

describe("MemoryStore dated notes, global scope, usage and blockIndex", () => {
  const clock = (iso: string) => () => new Date(iso);

  it("stamps updated on write and reads it back", () => {
    const store = new MemoryStore(tempDir(), clock("2026-10-14T10:00:00Z"));
    const file = store.write("p1", { name: "Commit Style", description: "Max 150", type: "feedback", body: "Keep it short." });
    expect(store.read("p1", file)?.updated).toBe("2026-10-14");
    expect(store.list("p1")[0]?.updated).toBe("2026-10-14");
    expect(readFileSync(join(store.dir("p1"), file), "utf8")).toContain('description: "Max 150"\nupdated: 2026-10-14\nmetadata:');
  });

  it("keeps GLOBAL_SCOPE notes in their own folder, out of a project's list", () => {
    const store = new MemoryStore(tempDir());
    store.write(GLOBAL_SCOPE, { name: "Terse", description: "prefers terse answers", type: "user", body: "no fluff" });
    store.write("p1", { name: "Commit Style", description: "Max 150", type: "feedback", body: "short" });
    expect(store.dir(GLOBAL_SCOPE).endsWith(GLOBAL_SCOPE)).toBe(true);
    expect(store.list(GLOBAL_SCOPE).map((f) => f.file)).toEqual(["terse.md"]);
    expect(store.list("p1").map((f) => f.file)).toEqual(["commit-style.md"]);
  });

  it("records usage timestamps and drops them when a fact is removed", () => {
    let now = new Date("2026-10-14T10:00:00Z");
    const store = new MemoryStore(tempDir(), () => now);
    store.write("p1", { name: "Alpha", description: "first", type: "project", body: "a" });
    expect(store.usage("p1")).toEqual({});
    store.touch("p1", "alpha.md");
    expect(store.usage("p1")).toEqual({ "alpha.md": Date.parse("2026-10-14T10:00:00Z") });
    now = new Date("2026-10-14T11:00:00Z");
    store.touch("p1", "alpha.md");
    expect(store.usage("p1")["alpha.md"]).toBe(Date.parse("2026-10-14T11:00:00Z"));
    store.touch("p1", "../bad.md");
    expect(Object.keys(store.usage("p1"))).toEqual(["alpha.md"]);
    expect(store.remove("p1", "alpha.md")).toBe(true);
    expect(store.usage("p1")).toEqual({});
  });

  it("never lists the usage sidecar and treats a corrupt one as empty", () => {
    const store = new MemoryStore(tempDir());
    store.write("p1", { name: "Alpha", description: "first", type: "project", body: "a" });
    store.touch("p1", "alpha.md");
    expect(store.list("p1").map((f) => f.file)).toEqual(["alpha.md"]);
    writeFileSync(join(store.dir("p1"), ".usage.json"), "{not json");
    expect(store.usage("p1")).toEqual({});
  });

  it("blocks global notes first with their header, then this project's", () => {
    const store = new MemoryStore(tempDir(), clock("2026-10-14T10:00:00Z"));
    store.write(GLOBAL_SCOPE, { name: "Terse", description: "prefers terse answers", type: "user", body: "x" });
    store.write("p1", { name: "Commit Style", description: "Max 150", type: "feedback", body: "y" });
    const block = store.blockIndex("p1");
    expect(block.text).toBe(
      'Global (about the user, every project; read with scope "global"):\n- [Terse](terse.md) — prefers terse answers\nThis project:\n- [Commit Style](commit-style.md) — Max 150',
    );
    expect(block.lines).toBe(4);
    expect(block.tokens).toBe(Math.ceil(block.text.length / 4));
    expect(block.shown).toBe(2);
    expect(block.total).toBe(2);
  });

  it("orders notes by recency, a later touch first and ties by filename", () => {
    let now = new Date("2026-10-14T10:00:00Z");
    const store = new MemoryStore(tempDir(), () => now);
    store.write("p1", { name: "Alpha", description: "a", type: "project", body: "a" });
    store.write("p1", { name: "Beta", description: "b", type: "project", body: "b" });
    // Same updated date and no usage yet: filename ascending.
    expect(blockFiles(store.blockIndex("p1").text)).toEqual(["alpha.md", "beta.md"]);
    now = new Date("2026-10-14T11:00:00Z");
    store.touch("p1", "alpha.md");
    now = new Date("2026-10-14T12:00:00Z");
    store.touch("p1", "beta.md");
    expect(blockFiles(store.blockIndex("p1").text)).toEqual(["beta.md", "alpha.md"]);
  });

  it("orders notes by a newer updated date", () => {
    const store = new MemoryStore(tempDir());
    const dir = store.dir("p1");
    writeFileSync(join(dir, "jan.md"), serializeFact({ name: "Jan", description: "old", type: "project", body: "j", updated: "2026-01-01" }));
    writeFileSync(join(dir, "jun.md"), serializeFact({ name: "Jun", description: "new", type: "project", body: "j", updated: "2026-06-01" }));
    expect(blockFiles(store.blockIndex("p1").text)).toEqual(["jun.md", "jan.md"]);
  });

  it("returns an empty block for an empty store", () => {
    const store = new MemoryStore(tempDir());
    expect(store.blockIndex("p1")).toEqual({ text: "", lines: 0, tokens: 0, shown: 0, total: 0 });
  });

  it("caps the project section, ending with the more notice", () => {
    const store = new MemoryStore(tempDir());
    const dir = store.dir("p1");
    for (let i = 0; i < 200; i++) {
      const n = String(i).padStart(3, "0");
      writeFileSync(join(dir, `fact-${n}.md`), serializeFact({ name: `Fact ${n}`, description: "d".repeat(80), type: "project", body: "b" }));
    }
    const block = store.blockIndex("p1");
    expect(block.total).toBe(200);
    expect(block.shown).toBeLessThan(block.total);
    expect(block.text.startsWith("This project:\n")).toBe(true);
    expect(block.text.length).toBeLessThanOrEqual(BLOCK_CAP.project);
    expect(block.text).toMatch(/\n- … \d+ more \(memory_read to list or search\)$/);
    expect(block.text.length).toBeLessThanOrEqual(BLOCK_CAP.global + BLOCK_CAP.project);
  });

  it("keeps both full sections together within the old 4800-char budget", () => {
    const store = new MemoryStore(tempDir());
    for (const scope of [GLOBAL_SCOPE, "p1"]) {
      const dir = store.dir(scope);
      for (let i = 0; i < 200; i++) {
        const n = String(i).padStart(3, "0");
        writeFileSync(join(dir, `fact-${n}.md`), serializeFact({ name: `Fact ${n}`, description: "d".repeat(80), type: "project", body: "b" }));
      }
    }
    const block = store.blockIndex("p1");
    expect(block.total).toBe(400);
    expect(block.text.length).toBeLessThanOrEqual(INDEX_CAP.chars);
    expect(block.text.split("\n").filter((l) => l.includes("more (memory_read"))).toHaveLength(2);
  });
});
