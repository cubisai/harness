import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_COMMENT_CHARS,
  MAX_COMMENTS,
  commentsMessage,
  readComment,
  readComments,
  readTarget,
  type DesignComment,
} from "../src/shared/comments";
import { COMMENTS_FILE, addComment, deleteComment, loadComments, saveComments, updateComment } from "../src/main/design/comments";
import { tempDir } from "./helpers";

const target = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ selector: "body > main", tag: "MAIN", text: "Hello", ...over });
const comment = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "c1",
  page: "index.html",
  target: target(),
  label: "Spacing",
  text: "Tighten this up.",
  createdAt: 1000,
  ...over,
});
const valid = (over: Record<string, unknown> = {}): DesignComment => readComment(comment(over)) as DesignComment;
const input = (over: Partial<{ page: string; target: { selector: string; tag: string; text: string }; label: string; text: string }> = {}): {
  page: string;
  target: { selector: string; tag: string; text: string };
  label: string;
  text: string;
} => ({ page: "index.html", target: { selector: ".hero", tag: "SECTION", text: "" }, label: "Hero", text: "Make it taller.", ...over });

describe("readTarget", () => {
  it("accepts a valid target and omits an absent id", () => {
    expect(readTarget(target())).toEqual({ selector: "body > main", tag: "MAIN", text: "Hello" });
    expect("id" in (readTarget(target()) as object)).toBe(false);
  });

  it("keeps a valid data-agent-id", () => {
    expect(readTarget(target({ id: "hero_1" }))).toEqual({ selector: "body > main", tag: "MAIN", text: "Hello", id: "hero_1" });
  });

  it("allows an empty text and the maximum lengths", () => {
    expect(readTarget(target({ text: "" }))?.text).toBe("");
    expect(readTarget(target({ selector: "x".repeat(2000) }))).not.toBeNull();
    expect(readTarget(target({ tag: "x".repeat(64) }))).not.toBeNull();
  });

  it("rejects non-objects and each bad field", () => {
    expect(readTarget(null)).toBeNull();
    expect(readTarget("x")).toBeNull();
    expect(readTarget([])).toBeNull();
    expect(readTarget(target({ selector: "" }))).toBeNull();
    expect(readTarget(target({ selector: "x".repeat(2001) }))).toBeNull();
    expect(readTarget(target({ selector: 5 }))).toBeNull();
    expect(readTarget(target({ tag: "" }))).toBeNull();
    expect(readTarget(target({ tag: "x".repeat(65) }))).toBeNull();
    expect(readTarget(target({ text: 5 }))).toBeNull();
    expect(readTarget(target({ text: "x".repeat(301) }))).toBeNull();
    expect(readTarget(target({ id: "Bad ID" }))).toBeNull();
    expect(readTarget(target({ id: 5 }))).toBeNull();
  });

  it("returns a fresh object", () => {
    const raw = target();
    expect(readTarget(raw)).not.toBe(raw);
  });
});

describe("readComment", () => {
  it("accepts a valid comment with only its fields", () => {
    expect(readComment(comment())).toEqual({
      id: "c1",
      page: "index.html",
      target: { selector: "body > main", tag: "MAIN", text: "Hello" },
      label: "Spacing",
      text: "Tighten this up.",
      createdAt: 1000,
    });
  });

  it("keeps sentAt and resolved when present", () => {
    expect(readComment(comment({ sentAt: 2000, resolved: true }))).toMatchObject({ sentAt: 2000, resolved: true });
  });

  it("drops unknown fields and returns a fresh object", () => {
    const out = readComment(comment({ extra: "no" })) as DesignComment;
    expect("extra" in out).toBe(false);
    expect("sentAt" in out).toBe(false);
    expect("resolved" in out).toBe(false);
  });

  it("accepts .htm and pages at both length bounds", () => {
    expect(readComment(comment({ page: "page.htm" }))).not.toBeNull();
    expect(readComment(comment({ page: "x".repeat(195) + ".html" }))).not.toBeNull();
  });

  it("rejects each bad field", () => {
    expect(readComment(null)).toBeNull();
    expect(readComment(comment({ id: "" }))).toBeNull();
    expect(readComment(comment({ id: "bad id" }))).toBeNull();
    expect(readComment(comment({ id: "x".repeat(41) }))).toBeNull();
    expect(readComment(comment({ page: "" }))).toBeNull();
    expect(readComment(comment({ page: "index.txt" }))).toBeNull();
    expect(readComment(comment({ page: "../index.html" }))).toBeNull();
    expect(readComment(comment({ page: "a/../b.html" }))).toBeNull();
    expect(readComment(comment({ page: "a\\b.html" }))).toBeNull();
    expect(readComment(comment({ page: "/index.html" }))).toBeNull();
    expect(readComment(comment({ page: "x".repeat(196) + ".html" }))).toBeNull();
    expect(readComment(comment({ target: null }))).toBeNull();
    expect(readComment(comment({ target: target({ tag: "" }) }))).toBeNull();
    expect(readComment(comment({ label: "" }))).toBeNull();
    expect(readComment(comment({ label: "x".repeat(81) }))).toBeNull();
    expect(readComment(comment({ text: "" }))).toBeNull();
    expect(readComment(comment({ text: "x".repeat(MAX_COMMENT_CHARS + 1) }))).toBeNull();
    expect(readComment(comment({ createdAt: "1000" }))).toBeNull();
    expect(readComment(comment({ createdAt: Number.NaN }))).toBeNull();
    expect(readComment(comment({ sentAt: "x" }))).toBeNull();
    expect(readComment(comment({ resolved: "yes" }))).toBeNull();
  });
});

describe("readComments", () => {
  it("returns [] for a non-array", () => {
    expect(readComments(null)).toEqual([]);
    expect(readComments("x")).toEqual([]);
    expect(readComments({})).toEqual([]);
  });

  it("drops malformed entries and duplicate ids, keeping the first", () => {
    const out = readComments([comment({ id: "a" }), comment({ id: "b" }), comment({ id: "a", text: "second" }), 5, null]);
    expect(out.map((c) => c.id)).toEqual(["a", "b"]);
    expect(out[0]?.text).toBe("Tighten this up.");
  });

  it("keeps the last MAX_COMMENTS", () => {
    const many = Array.from({ length: MAX_COMMENTS + 20 }, (_, i) => comment({ id: `c${i}` }));
    const out = readComments(many);
    expect(out).toHaveLength(MAX_COMMENTS);
    expect(out[0]?.id).toBe("c20");
    expect(out[out.length - 1]?.id).toBe(`c${MAX_COMMENTS + 19}`);
  });
});

describe("commentsMessage", () => {
  it("returns an empty string for no comments", () => {
    expect(commentsMessage("index.html", [])).toBe("");
  });

  it("lists each comment with its target, id, selector and text", () => {
    const a = valid({ id: "c1", page: "index.html", target: { id: "hero", selector: ".hero", tag: "SECTION", text: "Welcome home" }, text: "Make the hero taller." });
    const b = valid({ id: "c2", page: "index.html", target: { selector: "#cta", tag: "BUTTON", text: "" }, text: "Use the accent colour." });
    expect(commentsMessage("index.html", [a, b])).toBe(
      [
        "Address these comments on index.html. Change only what each one is about; if one needs bigger changes, say so instead.",
        '1. <SECTION> data-agent-id="hero" · selector `.hero` · text "Welcome home": Make the hero taller.',
        "2. <BUTTON> · selector `#cta`: Use the accent colour.",
      ].join("\n"),
    );
  });

  it("truncates long target text with an ellipsis", () => {
    const a = valid({ target: { selector: ".x", tag: "DIV", text: "y".repeat(90) } });
    expect(commentsMessage("index.html", [a])).toContain(`text "${"y".repeat(80)}…"`);
  });
});

describe("loadComments", () => {
  it("returns [] for a missing file", () => {
    expect(loadComments(tempDir())).toEqual([]);
  });

  it("returns [] for bad or non-list JSON", () => {
    const dir = tempDir();
    writeFileSync(join(dir, COMMENTS_FILE), "{ not json", "utf8");
    expect(loadComments(dir)).toEqual([]);
    writeFileSync(join(dir, COMMENTS_FILE), "42", "utf8");
    expect(loadComments(dir)).toEqual([]);
  });

  it("reads a valid file", () => {
    const dir = tempDir();
    const list = [valid({ id: "a" }), valid({ id: "b" })];
    writeFileSync(join(dir, COMMENTS_FILE), JSON.stringify(list), "utf8");
    expect(loadComments(dir)).toEqual(list);
  });
});

describe("saveComments", () => {
  it("round trips through loadComments", () => {
    const dir = tempDir();
    const list = [valid({ id: "a" }), valid({ id: "b" })];
    saveComments(dir, list);
    expect(loadComments(dir)).toEqual(list);
    expect(readFileSync(join(dir, COMMENTS_FILE), "utf8")).toBe(JSON.stringify(list, null, 2) + "\n");
  });

  it("makes a missing folder", () => {
    const dir = join(tempDir(), "nested");
    saveComments(dir, []);
    expect(loadComments(dir)).toEqual([]);
  });
});

describe("addComment", () => {
  it("trims the text and appends a fresh comment", () => {
    const list: DesignComment[] = [];
    const out = addComment(list, input({ text: "  hi  " }));
    expect(out[0]?.text).toBe("hi");
    expect(out).not.toBe(list);
    expect(list).toHaveLength(0);
  });

  it("uses injected id and now", () => {
    const out = addComment([], input(), 5000, () => "fixed-id");
    expect(out[0]).toMatchObject({ id: "fixed-id", createdAt: 5000 });
  });

  it("rejects empty, oversized, excessive and malformed input", () => {
    expect(() => addComment([], input({ text: "   " }))).toThrow("Write a comment first.");
    expect(() => addComment([], input({ text: "x".repeat(MAX_COMMENT_CHARS + 1) }))).toThrow("That comment is too long.");
    const full = Array.from({ length: MAX_COMMENTS }, (_, i) => valid({ id: `c${i}` }));
    expect(() => addComment(full, input())).toThrow("Too many comments; resolve or delete some first.");
    expect(() => addComment([], input({ page: "nope.txt" }))).toThrow("Bad comment.");
  });
});

describe("updateComment", () => {
  const list = [valid({ id: "a" })];

  it("resolves without mutating the old list", () => {
    const out = updateComment(list, "a", { resolved: true });
    expect(out[0]?.resolved).toBe(true);
    expect(out).not.toBe(list);
    expect(list[0]?.resolved).toBeUndefined();
  });

  it("removes the resolved field when set to false", () => {
    const resolved = updateComment(list, "a", { resolved: true });
    const cleared = updateComment(resolved, "a", { resolved: false });
    expect("resolved" in (cleared[0] as DesignComment)).toBe(false);
  });

  it("stamps sentAt when sent", () => {
    expect(updateComment(list, "a", { sent: true }, 777)[0]?.sentAt).toBe(777);
  });

  it("throws for a missing id", () => {
    expect(() => updateComment(list, "nope", { resolved: true })).toThrow("No such comment.");
  });
});

describe("deleteComment", () => {
  it("removes a comment without mutating the old list", () => {
    const list = [valid({ id: "a" }), valid({ id: "b" })];
    const out = deleteComment(list, "a");
    expect(out.map((c) => c.id)).toEqual(["b"]);
    expect(out).not.toBe(list);
    expect(list).toHaveLength(2);
  });

  it("throws for a missing id", () => {
    expect(() => deleteComment([valid({ id: "a" })], "nope")).toThrow("No such comment.");
  });
});
