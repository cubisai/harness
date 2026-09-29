import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { INDEX_CAP, MemoryStore, parseFact, serializeFact, slugFor } from "../src/main/memory/store";
import { tempDir } from "./helpers";

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
    const store = new MemoryStore(tempDir());
    const file = store.write("p1", { name: "Commit Style", description: "Max 150 chars", type: "feedback", body: "Keep it short." });
    expect(file).toBe("commit-style.md");
    expect(store.list("p1")).toEqual([{ file: "commit-style.md", name: "Commit Style", description: "Max 150 chars", type: "feedback" }]);
    expect(store.read("p1", file)).toEqual({ file: "commit-style.md", name: "Commit Style", description: "Max 150 chars", type: "feedback", body: "Keep it short." });
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
    expect(lines[2]).toBe("- [Alpha](alpha.md) — first");
    expect(lines[3]).toBe("- note to self");
    expect(text).not.toContain("gone.md");
    expect(lines).toContain("- [Beta](beta.md) — second");
    expect(lines).toContain("- [Gamma](gamma.md) — third");
    expect(text.endsWith("\n")).toBe(true);
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
