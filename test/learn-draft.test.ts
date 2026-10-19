import { describe, expect, it } from "vitest";
import type { TurnSignal } from "../src/shared/learn";
import { POISON_TOOLS, buildDraftPrompt, findDuplicate, parseLesson, pulledOutsideContent, similarity, tokens, type DraftInput } from "../src/main/learn/draft";

function input(over: Partial<DraftInput> = {}): DraftInput {
  return { request: "do the thing", answer: "done", signals: [], commands: [], checkTail: null, contrast: null, existing: [], ...over };
}

const SIGNALS: TurnSignal[] = [{ kind: "check-failed", level: "fail", detail: "npm test failed" }];

const GOOD = '{"rule":"Run the unit tests before claiming a fix","why":"the project check failed","paths":["src/main"],"keywords":["tests","fix"]}';

describe("buildDraftPrompt", () => {
  it("names the reader's job and asks for only the JSON object", () => {
    const p = buildDraftPrompt(input());
    expect(p).toContain("ONE coding-agent turn that went wrong");
    expect(p).toContain('{"rule":"...","why":"...","paths":["..."],"keywords":["..."]} or {"none":true}');
    expect(p).toContain("never on guesses");
    expect(p).toContain("Never include secrets, keys or tokens.");
  });

  it("lists signals one per line and says (none) for existing rules", () => {
    const p = buildDraftPrompt(input({ signals: SIGNALS }));
    expect(p).toContain("SIGNALS:");
    expect(p).toContain("- check-failed (fail): npm test failed");
    expect(p).toContain("EXISTING:\n(none)");
  });

  it("explains a revert only when one is among the signals", () => {
    const reverted: TurnSignal[] = [{ kind: "reverted", level: "fail", detail: "The user restored these files to how they were before the turn: src/a.ts" }];
    expect(buildDraftPrompt(input({ signals: reverted }))).toContain("the edit did land; the user then put the files back");
    expect(buildDraftPrompt(input({ signals: SIGNALS }))).not.toContain("the edit did land");
  });

  it("lists existing rules", () => {
    const p = buildDraftPrompt(input({ existing: ["Use tabs", "Keep commits short"] }));
    expect(p).toContain("- Use tabs");
    expect(p).toContain("- Keep commits short");
  });

  it("includes Commands joined, and Check output only when non-null", () => {
    const p = buildDraftPrompt(input({ commands: ["npm test", "npm run lint"], checkTail: "2 failing" }));
    expect(p).toContain("Commands: npm test; npm run lint");
    expect(p).toContain("Check output: 2 failing");
    expect(buildDraftPrompt(input()).includes("Check output:")).toBe(false);
  });

  it("adds the later-turn section only when contrast is given", () => {
    expect(buildDraftPrompt(input()).includes("A LATER TURN THAT WENT RIGHT:")).toBe(false);
    const p = buildDraftPrompt(input({ contrast: "used the right command" }));
    expect(p).toContain("A LATER TURN THAT WENT RIGHT:");
    expect(p).toContain("used the right command");
  });

  it("clips every free-text block to 1500 chars with a trailing ellipsis", () => {
    const p = buildDraftPrompt(input({ request: "x".repeat(2000) }));
    expect(p).toContain(`User: ${"x".repeat(1500)}…`);
    expect(p.includes("x".repeat(1501))).toBe(false);
  });
});

describe("parseLesson", () => {
  it("parses a fenced JSON object", () => {
    const lesson = parseLesson(`Here you go:\n\`\`\`json\n${GOOD}\n\`\`\``);
    expect(lesson).toEqual({
      rule: "Run the unit tests before claiming a fix",
      why: "the project check failed",
      scope: { paths: ["src/main"], keywords: ["tests", "fix"] },
    });
  });

  it("returns null for {\"none\":true}", () => {
    expect(parseLesson('{"none":true}')).toBeNull();
  });

  it("returns null for bad JSON or no object", () => {
    expect(parseLesson("{not json}")).toBeNull();
    expect(parseLesson("no object here")).toBeNull();
  });

  it("requires a non-empty rule of at least 8 chars and cuts it to 200", () => {
    expect(parseLesson('{"rule":"short","why":"x"}')).toBeNull();
    expect(parseLesson('{"rule":"","why":"x"}')).toBeNull();
    const long = parseLesson(JSON.stringify({ rule: "R".repeat(300), why: "evidence" }));
    expect(long?.rule.length).toBe(200);
  });

  it("cuts why to 300 and requires it", () => {
    expect(parseLesson('{"rule":"A long enough rule","why":""}')).toBeNull();
    const lesson = parseLesson(JSON.stringify({ rule: "A long enough rule", why: "w".repeat(400) }));
    expect(lesson?.why.length).toBe(300);
  });

  it("filters paths: no .., no absolute, no drive letter; backslashes become /", () => {
    const lesson = parseLesson(
      JSON.stringify({ rule: "A long enough rule", why: "evidence", paths: ["src\\main\\a.ts", "../outside", "/etc/passwd", "C:\\Users\\x", "src/app.ts", ""] }),
    );
    expect(lesson?.scope.paths).toEqual(["src/main/a.ts", "src/app.ts"]);
  });

  it("caps paths at 8", () => {
    const lesson = parseLesson(JSON.stringify({ rule: "A long enough rule", why: "evidence", paths: Array.from({ length: 20 }, (_, n) => `p${n}.ts`) }));
    expect(lesson?.scope.paths.length).toBe(8);
  });

  it("keeps only lowercase [a-z0-9-] keywords of 2..30 chars, unique, capped at 5", () => {
    const lesson = parseLesson(
      JSON.stringify({ rule: "A long enough rule", why: "evidence", keywords: ["Tests", "a", "UPPER", "ok-word", "x".repeat(31), "one", "two", "three", "one"] }),
    );
    expect(lesson?.scope.keywords).toEqual(["tests", "upper", "ok-word", "one", "two"]);
  });

  it("rejects a rule, why, path or keyword that smells like a secret", () => {
    expect(parseLesson(JSON.stringify({ rule: "Set api_key=abcdef123456", why: "evidence" }))).toBeNull();
    expect(parseLesson(JSON.stringify({ rule: "A long enough rule", why: "token=abcdef123456" }))).toBeNull();
    expect(parseLesson(JSON.stringify({ rule: "A long enough rule", why: "evidence", paths: ["token=abcdef123456"] }))).toBeNull();
    expect(parseLesson(JSON.stringify({ rule: "A long enough rule", why: "evidence", keywords: ["sk-abcdefghijklmnop"] }))).toBeNull();
  });
});

describe("tokens and similarity", () => {
  it("drops stop words and short words", () => {
    const t = tokens("the cat and the dog");
    expect(t.has("the")).toBe(false);
    expect(t.has("cat")).toBe(true);
    expect(t.has("dog")).toBe(true);
  });

  it("is 0 when both are empty, 1 when identical", () => {
    expect(similarity("", "")).toBe(0);
    expect(similarity("run the tests", "run the tests")).toBe(1);
  });
});

describe("findDuplicate", () => {
  const existing = [
    { id: "a", rule: "Run the unit tests before claiming a fix" },
    { id: "b", rule: "Keep commit messages short" },
  ];

  it("returns the id of the most similar entry at or above the threshold", () => {
    expect(findDuplicate("Before claiming a fix, run the unit tests", existing)).toBe("a");
  });

  it("returns null when nothing is close enough", () => {
    expect(findDuplicate("Rename every module to lower case", existing)).toBeNull();
  });

  it("respects a custom threshold", () => {
    expect(findDuplicate("Run the tests", existing, 0.99)).toBeNull();
  });
});

describe("pulledOutsideContent", () => {
  it("matches web, browser and mcp tool names, case-insensitively", () => {
    expect(POISON_TOOLS.test("WebFetch")).toBe(true);
    expect(pulledOutsideContent(["web_fetch"])).toBe(true);
    expect(pulledOutsideContent(["browser_open"])).toBe(true);
    expect(pulledOutsideContent(["mcp__github__x"])).toBe(true);
    expect(pulledOutsideContent(["WebSearch"])).toBe(true);
  });

  it("is false for local tools", () => {
    expect(pulledOutsideContent(["read_file", "bash", "search_files"])).toBe(false);
    expect(pulledOutsideContent([])).toBe(false);
  });
});
