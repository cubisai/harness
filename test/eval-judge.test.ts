// Unit tests for evals/lib/judge.ts and the judge grader: every model call is a
// fake `ask`, and calibration files live in a temp dir (no network, no shell).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { grade } from "../evals/lib/graders";
import { calibrate, isCalibrated, judgeOnce, loadCalibration, parseVerdict, pairwise, transcriptOf } from "../evals/lib/judge";
import { trialStatus } from "../evals/lib/runner";
import type { CompactEvent, GradeInput, Grader, Task } from "../evals/lib/types";

const root = mkdtempSync(join(tmpdir(), "eval-judge-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const dir = mkdtempSync(join(tmpdir(), "eval-judge-dir-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const writeCal = (name: string, body: unknown): void => writeFileSync(join(root, `${name}.json`), JSON.stringify(body));
writeCal("good", { rubric: "r", examples: [], report: { accuracy: 0.9, agreement: 0.8, n: 10 } });
writeCal("lowacc", { rubric: "r", examples: [], report: { accuracy: 0.8, agreement: 0.6, n: 10 } });
writeCal("few", { rubric: "r", examples: [], report: { accuracy: 0.9, agreement: 0.8, n: 9 } });
writeCal("noreport", { rubric: "r", examples: [] });
writeFileSync(join(root, "broken.json"), "{not json");

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

const runCommand = async () => ({ ok: true, exitCode: 0, tail: "" });
const run = (g: Grader, over: Partial<GradeInput> = {}) =>
  grade({ task: task([g]), events: [], dir, fixtureDir: dir, overBudget: false, runCommand, judgesRoot: root, ...over });
const askReply = (reply: string) => async () => reply;

describe("transcriptOf", () => {
  it("labels each event and skips empty ones", () => {
    const events: CompactEvent[] = [
      { kind: "assistant-text", text: "hi" },
      { kind: "tool-use", name: "Edit", summary: "a.ts" },
      { kind: "turn-end" },
      { kind: "error", text: "boom" },
    ];
    expect(transcriptOf(events)).toBe("assistant: hi\ntool Edit: a.ts\nerror: boom");
  });
});

describe("parseVerdict", () => {
  it("reads the first JSON object with a boolean pass", () => {
    expect(parseVerdict('Sure! {"pass": true, "why": "ok"} done')).toEqual({ pass: true, why: "ok" });
    expect(parseVerdict('{"pass": false}')).toEqual({ pass: false, why: "" });
  });

  it("returns null without a boolean pass", () => {
    expect(parseVerdict('{"why": "no pass here"}')).toBeNull();
    expect(parseVerdict("no json at all")).toBeNull();
  });
});

describe("judgeOnce", () => {
  it("sends the rubric and transcript and flags an unparseable reply", async () => {
    let prompt = "";
    const v = await judgeOnce(async (p) => ((prompt = p), '{"pass": true, "why": "good"}'), "RUBRIC-XYZ", "TRANSCRIPT-ABC");
    expect(prompt).toContain("RUBRIC-XYZ");
    expect(prompt).toContain("TRANSCRIPT-ABC");
    expect(v).toEqual({ pass: true, why: "good" });

    const bad = await judgeOnce(askReply("not json"), "r", "t");
    expect(bad).toEqual({ pass: false, why: "judge reply unparseable", invalid: true });
  });
});

describe("pairwise", () => {
  it("blinds the pair, swaps on rng and undoes the swap", async () => {
    let prompt = "";
    const ask = async (p: string) => ((prompt = p), '{"winner": 1, "why": "clearer"}');

    const swapped = await pairwise(ask, "rubric", "AAA-text", "BBB-text", () => 0.1);
    expect(prompt).toContain("Response 1:\nBBB-text");
    expect(prompt).toContain("Response 2:\nAAA-text");
    expect(prompt).not.toMatch(/Response A|Response B| a:| b:/);
    expect(swapped).toEqual({ winner: "b", why: "clearer" });

    const plain = await pairwise(ask, "rubric", "AAA-text", "BBB-text", () => 0.9);
    expect(prompt).toContain("Response 1:\nAAA-text");
    expect(plain).toEqual({ winner: "a", why: "clearer" });
  });

  it("returns a tie for an unreadable reply", async () => {
    expect(await pairwise(askReply("no winner"), "r", "a", "b")).toEqual({ winner: "tie", why: "" });
  });
});

describe("calibrate", () => {
  it("is right on 9 of 10 with sane agreement", async () => {
    const examples = Array.from({ length: 10 }, (_, i) => ({ transcript: `t${i}`, label: i < 5 }));
    const ask = async (prompt: string) => {
      const i = Number(/t(\d+)/.exec(prompt)![1]);
      return JSON.stringify({ pass: i === 5 ? true : i < 5, why: "" });
    };
    const r = await calibrate(ask, "r", examples);
    expect(r.n).toBe(10);
    expect(r.accuracy).toBeCloseTo(0.9);
    expect(r.agreement).toBeGreaterThan(0.5);
    expect(r.agreement).toBeLessThanOrEqual(1);
  });

  it("counts an unreadable reply as a miss, even on a negative label", async () => {
    const examples = Array.from({ length: 10 }, (_, i) => ({ transcript: `t${i}`, label: false }));
    const r = await calibrate(async () => "no idea", "r", examples);
    expect(r.accuracy).toBe(0);
  });
});

describe("calibration files", () => {
  it("loads them and applies the thresholds", () => {
    expect(isCalibrated(loadCalibration(root, "good"))).toBe(true);
    expect(isCalibrated(loadCalibration(root, "noreport"))).toBe(false);
    expect(loadCalibration(root, "missing")).toBeNull();
    expect(loadCalibration(root, "broken")).toBeNull();
  });
});

describe("judge grader", () => {
  const judge = (calibration: string): Grader => ({ type: "judge", rubric: "r", calibration });

  it("is ungraded without a model", async () => {
    const [noAsk] = await run(judge("good"));
    expect(noAsk).toMatchObject({ pass: false, ungraded: true, why: "judge has no model" });
    const [noRoot] = await run(judge("good"), { ask: askReply('{"pass": true}'), judgesRoot: undefined });
    expect(noRoot).toMatchObject({ pass: false, ungraded: true, why: "judge has no model" });
  });

  it("is ungraded on a weak or too-small calibration", async () => {
    const ask = askReply('{"pass": true}');
    const [lowAcc] = await run(judge("lowacc"), { ask });
    expect(lowAcc).toMatchObject({ pass: false, ungraded: true, why: "judge uncalibrated (lowacc: accuracy 0.8 on 10)" });
    const [few] = await run(judge("few"), { ask });
    expect(few).toMatchObject({ pass: false, ungraded: true, why: "judge uncalibrated (few: accuracy 0.9 on 9)" });
    const [none] = await run(judge("no-such-file"), { ask });
    expect(none).toMatchObject({ pass: false, ungraded: true, why: "judge uncalibrated (no-such-file: no calibration report)" });
  });

  it("is ungraded when the calibration was made for another rubric", async () => {
    const [r] = await run({ type: "judge", rubric: "a different rubric", calibration: "good" }, { ask: askReply('{"pass": true}') });
    expect(r).toMatchObject({ pass: false, ungraded: true, why: "judge uncalibrated (good: calibrated on another rubric)" });
  });

  it("counts a calibrated judge's verdict", async () => {
    const [r] = await run(judge("good"), { ask: askReply('{"pass": true, "why": "looks right"}') });
    expect(r).toMatchObject({ type: "judge", pass: true, why: "looks right" });
    expect(r!.ungraded).toBeUndefined();
  });

  it("leaves existing grader results without an ungraded key", async () => {
    const [r] = await grade({ task: task([{ type: "budget" }]), events: [], dir, fixtureDir: dir, overBudget: false, runCommand });
    expect(Object.keys(r!)).not.toContain("ungraded");
  });
});

describe("trialStatus", () => {
  it("treats an ungraded trial as ungraded, but a harness error wins", () => {
    expect(trialStatus({ harnessError: null, graders: 2, pass: false, overBudget: false, ungraded: true })).toBe("ungraded");
    expect(trialStatus({ harnessError: "boom", graders: 2, pass: true, overBudget: false, ungraded: true })).toBe("harness-error");
  });
});
