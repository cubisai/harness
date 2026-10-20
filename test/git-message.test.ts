import { describe, expect, it } from "vitest";
import {
  CO_AUTHORS,
  DEFAULT_PATCH_BUDGET,
  buildCommitPrompt,
  coAuthorFor,
  fitPatches,
  formatCommitMessage,
  isNoisePath,
  parseCommitMessage,
  type CommitDiffFile,
} from "../src/main/git-message";

describe("isNoisePath", () => {
  it("matches lockfiles and generated files", () => {
    expect(isNoisePath("bun.lock")).toBe(true);
    expect(isNoisePath("app/package-lock.json")).toBe(true);
    expect(isNoisePath("a/dist/x.js")).toBe(true);
    expect(isNoisePath("out/bundle.js")).toBe(true);
    expect(isNoisePath("a\\node_modules\\b.js")).toBe(true);
    expect(isNoisePath("bundle.min.js")).toBe(true);
    expect(isNoisePath("styles.min.css")).toBe(true);
    expect(isNoisePath("bundle.js.map")).toBe(true);
  });

  it("leaves ordinary source files alone", () => {
    expect(isNoisePath("src/a.ts")).toBe(false);
    expect(isNoisePath("src/output.ts")).toBe(false);
    expect(isNoisePath("test/git-message.test.ts")).toBe(false);
  });
});

describe("fitPatches", () => {
  it("lists noise files, then keeps the original order", () => {
    const files: CommitDiffFile[] = [
      { path: "bun.lock", patch: "lockfile" },
      { path: "b.ts", patch: "b" },
      { path: "a.ts", patch: "aa" },
    ];
    expect(fitPatches(files, 100)).toBe("Omitted (generated or lock files): bun.lock\n\n--- b.ts\nb\n\n--- a.ts\naa");
  });

  it("cuts a large patch at a line boundary and names the lines left out", () => {
    const files: CommitDiffFile[] = [
      { path: "big.ts", patch: "line one\nline two\nline three\nline four" },
      { path: "small.ts", patch: "ok" },
    ];
    expect(fitPatches(files, 31)).toBe(
      "--- big.ts\nline one\n… (3 more lines cut)\n\n--- small.ts\nok",
    );
  });

  it("omits files once the budget is spent", () => {
    const files: CommitDiffFile[] = [
      { path: "a.ts", patch: "aaaa" },
      { path: "b.ts", patch: "bbbb" },
    ];
    expect(fitPatches(files, 5)).toBe("--- a.ts\naaaa\n\nb.ts: diff omitted (budget)");
  });

  it("is deterministic for equal-sized patches", () => {
    const files: CommitDiffFile[] = [
      { path: "b.ts", patch: "xx" },
      { path: "a.ts", patch: "yy" },
    ];
    expect(fitPatches(files, 4)).toBe(fitPatches(files, 4));
    expect(fitPatches(files, 4)).toBe("--- b.ts\nxx\n\n--- a.ts\nyy");
  });
});

describe("buildCommitPrompt", () => {
  const input = {
    threadTitle: null,
    nameStatus: "M\tsrc/a.ts",
    stat: " 1 file changed, 1 insertion(+)",
    files: [{ path: "src/a.ts", patch: "+x" }],
  };

  it("includes the title only when it is non-empty", () => {
    expect(buildCommitPrompt(input)).not.toContain("Thread:");
    expect(buildCommitPrompt({ ...input, threadTitle: "Fix login" })).toContain("Thread: Fix login");
    expect(buildCommitPrompt({ ...input, threadTitle: "   " })).not.toContain("Thread:");
  });

  it("puts the files, summary and diff sections in order", () => {
    const prompt = buildCommitPrompt(input);
    expect(prompt).toContain("Files changed:\nM\tsrc/a.ts");
    expect(prompt).toContain("Summary:\n 1 file changed, 1 insertion(+)");
    expect(prompt).toContain("Diff:\n--- src/a.ts\n+x");
    const filesAt = prompt.indexOf("Files changed:");
    const summaryAt = prompt.indexOf("Summary:");
    const diffAt = prompt.indexOf("Diff:");
    expect(filesAt).toBeGreaterThan(-1);
    expect(summaryAt).toBeGreaterThan(filesAt);
    expect(diffAt).toBeGreaterThan(summaryAt);
  });

  it("uses the default patch budget when none is given", () => {
    expect(DEFAULT_PATCH_BUDGET).toBe(12_000);
    expect(buildCommitPrompt(input)).toContain("+x");
  });
});

describe("parseCommitMessage", () => {
  it("strips a fenced block, with or without a language tag", () => {
    expect(parseCommitMessage("```\nfeat: add x\n\nWhy.\n```")).toEqual({ subject: "feat: add x", body: "Why." });
    expect(parseCommitMessage("```text\nFix x\n```")).toEqual({ subject: "Fix x", body: "" });
  });

  it("strips a leading label and a trailing period", () => {
    expect(parseCommitMessage("Subject: Fix x.")).toEqual({ subject: "Fix x", body: "" });
    expect(parseCommitMessage("Commit message: Fix x.")).toEqual({ subject: "Fix x", body: "" });
  });

  it("strips matching quotes or backticks around the subject", () => {
    expect(parseCommitMessage('"Fix x"')).toEqual({ subject: "Fix x", body: "" });
    expect(parseCommitMessage("'Fix x'")).toEqual({ subject: "Fix x", body: "" });
    expect(parseCommitMessage("`Fix x`")).toEqual({ subject: "Fix x", body: "" });
    expect(parseCommitMessage('"Fix x."')).toEqual({ subject: "Fix x", body: "" });
  });

  it("normalises CRLF", () => {
    expect(parseCommitMessage("Fix x\r\n\r\nBody line")).toEqual({ subject: "Fix x", body: "Body line" });
  });

  it("drops co-author and sign-off lines from the body", () => {
    const raw = [
      "Fix x",
      "",
      "Body line",
      "",
      "Co-authored-by: Claude <noreply@anthropic.com>",
      "Signed-off-by: Someone <someone@example.com>",
    ].join("\n");
    expect(parseCommitMessage(raw)).toEqual({ subject: "Fix x", body: "Body line" });
  });

  it("cuts a long subject at the last word boundary", () => {
    const long = "word ".repeat(19) + "abcde";
    const parsed = parseCommitMessage(long);
    expect(parsed?.subject).toBe("word ".repeat(13) + "word");
    expect(parsed?.subject.length).toBeLessThanOrEqual(72);
  });

  it("hard-cuts a long subject with no spaces", () => {
    expect(parseCommitMessage("x".repeat(100))?.subject).toBe("x".repeat(72));
  });

  it("collapses 3+ newlines in the body", () => {
    expect(parseCommitMessage("Fix x\n\nFirst\n\n\n\nSecond")).toEqual({ subject: "Fix x", body: "First\n\nSecond" });
  });

  it("returns null for empty or trailer-only output", () => {
    expect(parseCommitMessage("")).toBeNull();
    expect(parseCommitMessage("   \n\n")).toBeNull();
    expect(parseCommitMessage("Co-authored-by: Claude <noreply@anthropic.com>")).toBeNull();
  });
});

describe("co-author trailers", () => {
  it("looks up known agents", () => {
    expect(coAuthorFor("claude")).toEqual(CO_AUTHORS.claude);
    expect(coAuthorFor("native")).toBeNull();
    expect(CO_AUTHORS.codex).toEqual({ name: "Codex", email: "noreply@openai.com" });
  });

  it("formats the message with and without a body", () => {
    expect(formatCommitMessage({ subject: "Fix x", body: "" })).toBe("Fix x");
    expect(formatCommitMessage({ subject: "Fix x", body: "Why." })).toBe("Fix x\n\nWhy.");
  });

  it("appends the exact trailer once", () => {
    const message = formatCommitMessage({ subject: "Fix x", body: "Why." }, CO_AUTHORS.claude);
    expect(message).toBe("Fix x\n\nWhy.\n\nCo-authored-by: Claude <noreply@anthropic.com>");
    expect(message.endsWith("\n")).toBe(false);

    const already = "Co-authored-by: Claude <noreply@anthropic.com>";
    const body = `Why.\n\n${already}`;
    const deduped = formatCommitMessage({ subject: "Fix x", body }, CO_AUTHORS.claude);
    expect(deduped).toBe(`Fix x\n\n${body}`);
    expect(deduped.split(already)).toHaveLength(2);
  });
});
