// Unit tests for evals/lib/graders.ts: pure grading over temp dirs, with the
// shell injected as a fake so nothing here spawns a real command.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { grade, score } from "../evals/lib/graders";
import type { CompactEvent, GradeInput, Grader, GraderResult, Task } from "../evals/lib/types";

const dir = mkdtempSync(join(tmpdir(), "eval-graders-"));
const fixtureDir = mkdtempSync(join(tmpdir(), "eval-graders-"));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(fixtureDir, { recursive: true, force: true });
});

const task = (graders: Grader[]): Task => ({
  id: "t",
  tags: ["capability"],
  tier: "smoke",
  fixture: "f",
  prompt: "p",
  mode: "auto-edit",
  graders,
  budget: { maxSteps: 1, maxInputTokens: 1, timeoutMs: 1000 },
});

const fakeRun = async (command: string) =>
  command === "ok" ? { ok: true, exitCode: 0, tail: "" } : { ok: false, exitCode: 2, tail: "boom" };

const run = (graders: Grader[], over: Partial<GradeInput> = {}): Promise<GraderResult[]> =>
  grade({ task: task(graders), events: [], dir, fixtureDir, overBudget: false, runCommand: fakeRun, ...over });

const write = (base: string, path: string, text: string): void => {
  const full = join(base, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
};

describe("file", () => {
  it("checks existence both ways", async () => {
    write(dir, "exists.txt", "hi");
    const [present, missing] = await run([
      { type: "file", path: "exists.txt", exists: true },
      { type: "file", path: "nope.txt", exists: true },
    ]);
    expect(present).toMatchObject({ pass: true, required: true, weight: 1 });
    expect(present!.why).toBe("exists.txt exists");
    expect(missing!.pass).toBe(false);
    expect(missing!.why).toBe("nope.txt missing");
    const [absent] = await run([{ type: "file", path: "absent.txt", exists: false }]);
    expect(absent!.pass).toBe(true);
    expect(absent!.why).toBe("absent.txt missing");
  });

  it("checks contains, failing when absent", async () => {
    write(dir, "contains.txt", "hello foo world");
    const [hit, miss] = await run([
      { type: "file", path: "contains.txt", contains: "foo" },
      { type: "file", path: "contains.txt", contains: "bar" },
    ]);
    expect(hit!.pass).toBe(true);
    expect(hit!.why).toBe('contains.txt contains "foo"');
    expect(miss!.pass).toBe(false);
    expect(miss!.why).toBe('contains.txt does not contain "bar"');
  });

  it("checks matches as a regex", async () => {
    write(dir, "match.ts", "export const x = 42;");
    const [hit, miss] = await run([
      { type: "file", path: "match.ts", matches: "x = \\d+" },
      { type: "file", path: "match.ts", matches: "^nope$" },
    ]);
    expect(hit!.pass).toBe(true);
    expect(miss!.pass).toBe(false);
    expect(miss!.why).toBe("match.ts does not match /^nope$/");
  });

  it("normalises CRLF before text checks", async () => {
    write(dir, "crlf.txt", "a\r\nb\r\nc");
    const [r] = await run([{ type: "file", path: "crlf.txt", contains: "a\nb" }]);
    expect(r!.pass).toBe(true);
  });

  it("fails contains and matches when the file is missing", async () => {
    const [c, m] = await run([
      { type: "file", path: "gone.txt", contains: "x" },
      { type: "file", path: "gone.txt", matches: "x" },
    ]);
    expect(c!.pass).toBe(false);
    expect(c!.why).toBe("gone.txt missing");
    expect(m!.pass).toBe(false);
    expect(m!.why).toBe("gone.txt missing");
  });

  it("compares against the fixture by sha256", async () => {
    write(dir, "same.txt", "same");
    write(fixtureDir, "same.txt", "same");
    write(dir, "diff.txt", "A");
    write(fixtureDir, "diff.txt", "B");
    const [unchanged, changed] = await run([
      { type: "file", path: "same.txt", unchanged: true },
      { type: "file", path: "diff.txt", unchanged: true },
    ]);
    expect(unchanged!.pass).toBe(true);
    expect(unchanged!.why).toBe("same.txt unchanged");
    expect(changed!.pass).toBe(false);
    expect(changed!.why).toBe("diff.txt changed");
  });

  it("treats both-missing as unchanged and differing bytes as changed", async () => {
    const [bothMissing] = await run([{ type: "file", path: "ghost.txt", unchanged: true }]);
    expect(bothMissing!.pass).toBe(true);
    write(dir, "moved.txt", "A");
    write(fixtureDir, "moved.txt", "B");
    const [differs] = await run([{ type: "file", path: "moved.txt", unchanged: false }]);
    expect(differs!.pass).toBe(true);
  });
});

describe("command", () => {
  it("passes when runCommand reports ok", async () => {
    const [r] = await run([{ type: "command", run: "ok" }]);
    expect(r!.pass).toBe(true);
  });

  it("fails with the exit code and tail", async () => {
    const [r] = await run([{ type: "command", run: "fail" }]);
    expect(r!.pass).toBe(false);
    expect(r!.why).toContain("exit 2");
    expect(r!.why).toContain("boom");
  });

  it("defaults the timeout to 60000 and honours an override", async () => {
    const seen: number[] = [];
    const runCommand = async (_c: string, _d: string, timeoutMs: number) => {
      seen.push(timeoutMs);
      return { ok: true, exitCode: 0, tail: "" };
    };
    await run([{ type: "command", run: "a" }, { type: "command", run: "b", timeoutMs: 5 }], { runCommand });
    expect(seen).toEqual([60000, 5]);
  });
});

describe("tool", () => {
  const events: CompactEvent[] = [
    { kind: "tool-use", name: "Edit" },
    { kind: "tool-use", name: "Edit" },
    { kind: "tool-use", name: "Read" },
  ];

  it("counts tool-use events within min..max", async () => {
    const [ok, over] = await run(
      [
        { type: "tool", name: "Edit", min: 1, max: 3 },
        { type: "tool", name: "Edit", min: 0, max: 0 },
      ],
      { events },
    );
    expect(ok!.pass).toBe(true);
    expect(ok!.why).toBe("Edit called 2× (want 1..3)");
    expect(over!.pass).toBe(false);
    expect(over!.why).toBe("Edit called 2× (want 0..0)");
  });

  it("defaults min to 0 and max to Infinity", async () => {
    const [r] = await run([{ type: "tool", name: "Edit" }], { events });
    expect(r!.pass).toBe(true);
    expect(r!.why).toBe("Edit called 2× (want 0..Infinity)");
  });
});

describe("skill", () => {
  const sentinels = new Map([
    ["@@alpha@@", "alpha"],
    ["@@beta@@", "beta"],
  ]);
  const withAlpha: CompactEvent[] = [{ kind: "assistant-text", text: "loaded @@alpha@@" }];

  it("passes when every expected skill loaded", async () => {
    const [r] = await run([{ type: "skill", expect: ["alpha"] }], { events: withAlpha, sentinels });
    expect(r!.pass).toBe(true);
  });

  it("fails when an expected skill is missing", async () => {
    const [r] = await run([{ type: "skill", expect: ["alpha", "beta"] }], { events: withAlpha, sentinels });
    expect(r!.pass).toBe(false);
    expect(r!.why).toBe("missing beta");
  });

  it("fails none:true when a skill was loaded", async () => {
    const [r] = await run([{ type: "skill", none: true }], { events: withAlpha, sentinels });
    expect(r!.pass).toBe(false);
    expect(r!.why).toBe("loaded alpha");
  });

  it("passes none:true with no false call", async () => {
    const [r] = await run([{ type: "skill", none: true }], { events: [{ kind: "assistant-text", text: "nothing" }], sentinels });
    expect(r!.pass).toBe(true);
    expect(r!.why).toBe("no skill loaded");
  });

  it("fails when there is no skill kit", async () => {
    const [r] = await run([{ type: "skill", expect: ["alpha"] }], { events: withAlpha });
    expect(r!.pass).toBe(false);
    expect(r!.why).toBe("no skill kit");
  });
});

describe("event", () => {
  it("noError fails on an error event and passes otherwise", async () => {
    const [bad] = await run([{ type: "event", noError: true }], { events: [{ kind: "error", text: "boom" }] });
    expect(bad!.pass).toBe(false);
    const [ok] = await run([{ type: "event", noError: true }], { events: [{ kind: "notice", text: "hi" }] });
    expect(ok!.pass).toBe(true);
  });

  it("noFalseClaim fails on a pass claim with no Run", async () => {
    const [r] = await run([{ type: "event", noFalseClaim: true }], {
      events: [{ kind: "assistant-text", text: "Done. All tests pass." }],
    });
    expect(r!.pass).toBe(false);
  });

  it("noFalseClaim passes when a Run ran a check", async () => {
    const [r] = await run([{ type: "event", noFalseClaim: true }], {
      events: [
        { kind: "assistant-text", text: "Done. All tests pass." },
        { kind: "tool-use", name: "Run", summary: "bun test" },
      ],
    });
    expect(r!.pass).toBe(true);
  });
});

describe("budget and result metadata", () => {
  it("passes unless over budget", async () => {
    const [ok] = await run([{ type: "budget" }], { overBudget: false });
    expect(ok!.pass).toBe(true);
    const [bad] = await run([{ type: "budget" }], { overBudget: true });
    expect(bad!.pass).toBe(false);
    expect(bad!.why).toBe("over budget");
  });

  it("defaults required true and weight 1, honouring overrides", async () => {
    const results = await run([{ type: "budget" }, { type: "budget", required: false, weight: 2.5 }]);
    expect(results[0]).toMatchObject({ required: true, weight: 1 });
    expect(results[1]).toMatchObject({ required: false, weight: 2.5 });
  });
});

describe("score", () => {
  const gr = (pass: boolean, weight: number, required = true): GraderResult => ({ type: "budget", pass, required, weight, why: "" });

  it("is the weighted share of passed graders", () => {
    expect(score([gr(true, 3), gr(false, 1)])).toEqual({ pass: false, score: 0.75 });
  });

  it("keeps pass true when only an optional grader fails", () => {
    expect(score([gr(true, 1), gr(false, 1, false)])).toEqual({ pass: true, score: 0.5 });
  });

  it("fails when a required grader fails", () => {
    expect(score([gr(true, 1), gr(false, 1)]).pass).toBe(false);
  });

  it("is a full pass on an empty list", () => {
    expect(score([])).toEqual({ pass: true, score: 1 });
  });

  it("scores 1 when total weight is 0", () => {
    expect(score([gr(false, 0)])).toEqual({ pass: false, score: 1 });
  });
});

describe("answer", () => {
  const said = (text: string): CompactEvent[] => [{ kind: "assistant-text", text }];

  it("needs every contains, case-insensitively, and the regex", async () => {
    const [hit, miss, re] = await run(
      [
        { type: "answer", contains: ["SRC/config/load.js"] },
        { type: "answer", contains: ["load.js", "nowhere"] },
        { type: "answer", matches: "denied|blocked" },
      ],
      { events: said("It is in src/config/load.js; the run was Blocked.") },
    );
    expect(hit!.pass).toBe(true);
    expect(miss).toMatchObject({ pass: false, why: 'answer lacks "nowhere"' });
    expect(re!.pass).toBe(true);
  });

  it("ignores tool summaries", async () => {
    const [r] = await run([{ type: "answer", contains: ["load.js"] }], { events: [{ kind: "tool-use", name: "Read", summary: "load.js" }] });
    expect(r!.pass).toBe(false);
  });
});

describe("file exists on a folder", () => {
  it("counts a directory as existing", async () => {
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    const [r] = await run([{ type: "file", path: "node_modules", exists: false }]);
    expect(r).toMatchObject({ pass: false, why: "node_modules exists" });
  });
});
