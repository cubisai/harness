import { describe, expect, it } from "vitest";
import { folderPaths, mentionQueryAt, mentionsIn, rankMentions } from "../src/renderer/src/mentions";

describe("mentionQueryAt", () => {
  it("opens on an @ at the start of the text", () => {
    expect(mentionQueryAt("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionQueryAt("@src/ap", 7)).toEqual({ start: 0, query: "src/ap" });
  });

  it("opens on an @ after whitespace", () => {
    expect(mentionQueryAt("look @src", 9)).toEqual({ start: 5, query: "src" });
    expect(mentionQueryAt("@a @b", 5)).toEqual({ start: 3, query: "b" });
  });

  it("reads only up to the caret, so the middle of the text works", () => {
    expect(mentionQueryAt("look @src file", 9)).toEqual({ start: 5, query: "src" });
  });

  it("does not open inside an email", () => {
    expect(mentionQueryAt("a@b.com", 7)).toBeNull();
  });

  it("closes once whitespace follows the @", () => {
    expect(mentionQueryAt("@foo ", 5)).toBeNull();
    expect(mentionQueryAt("no mention", 10)).toBeNull();
  });
});

describe("folderPaths", () => {
  it("derives every parent folder with a trailing slash", () => {
    expect(folderPaths(["src/a.ts", "src/lib/b.ts", "README.md", "src/lib/c.ts"])).toEqual(["src/", "src/lib/"]);
    expect(folderPaths([])).toEqual([]);
  });
});

describe("rankMentions", () => {
  it("puts a basename prefix ahead of a path substring", () => {
    expect(rankMentions(["src/comp.ts", "src/components/x.ts"], "comp")).toEqual(["src/comp.ts", "src/components/x.ts"]);
  });

  it("mixes folders and files, shortest path first on ties", () => {
    expect(rankMentions(["src/components/", "src/comp/"], "comp")).toEqual(["src/comp/", "src/components/"]);
    expect(rankMentions(["src/components/", "src/components/Button.tsx"], "comp")).toEqual([
      "src/components/",
      "src/components/Button.tsx",
    ]);
  });

  it("matches case-insensitively", () => {
    expect(rankMentions(["src/App.ts"], "app")).toEqual(["src/App.ts"]);
  });

  it("falls back to a fuzzy subsequence", () => {
    expect(rankMentions(["src/button.ts", "notes.txt"], "sbt")).toEqual(["src/button.ts"]);
  });

  it("caps the result at the limit", () => {
    expect(rankMentions(["a.ts", "b.ts", "c.ts"], "", 2)).toEqual(["a.ts", "b.ts"]);
  });
});

describe("mentionsIn", () => {
  const known = new Set(["src/a.ts", "src/lib/"]);

  it("finds the distinct @paths the project knows", () => {
    expect(mentionsIn("see @src/a.ts and @src/lib/ please", known)).toEqual(["src/a.ts", "src/lib/"]);
    expect(mentionsIn("@src/a.ts @src/a.ts", known)).toEqual(["src/a.ts"]);
  });

  it("ignores unknown paths and email addresses", () => {
    expect(mentionsIn("see @src/missing.ts", known)).toEqual([]);
    expect(mentionsIn("mail a@src/a.ts", known)).toEqual([]);
    expect(mentionsIn("nothing here", known)).toEqual([]);
  });
});
