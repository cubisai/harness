import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CaseFile } from "../src/main/learn/cases";
import { caseTask, materializeCase, replayKey, verifyLesson, type ReplayDeps } from "../src/main/learn/replay";
import { execCommandSync } from "../src/main/winspawn";
import type { Lesson } from "../src/shared/learn";
import { tempDir } from "./helpers";

// Directory/id names must be 16 hex chars: readCase only accepts those.
const hexId = (n: number): string => n.toString(16).padStart(16, "0");

function caseFile(over: Partial<CaseFile> = {}): CaseFile {
  return {
    id: "aaaaaaaaaaaaaaaa",
    projectId: "p",
    threadId: "t",
    userSeq: 1,
    createdAt: 1,
    headSha: "1234567890abcdef1234567890abcdef12345678",
    prompt: "fix the bug",
    mode: "auto-edit",
    agent: "fake",
    model: "fake-1",
    graders: [{ type: "file", path: "src/a.ts", contains: "ok" }],
    graderText: "src/a.ts unchanged",
    heldOut: false,
    deleted: [],
    ...over,
  };
}

function lesson(over: Partial<Lesson> = {}): Lesson {
  return {
    id: "L1",
    projectId: "p",
    rule: "Run the unit tests before claiming a fix",
    why: "the project check failed",
    scope: { paths: [], keywords: [] },
    status: "candidate",
    helpful: 0,
    harmful: 0,
    relevant: 0,
    tries: 0,
    pinned: false,
    caseId: hexId(1),
    provenance: { threadId: "t", userSeq: 1, signals: [], agent: "fake", model: "fake-1" },
    verified: null,
    note: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

function writeCase(root: string, c: CaseFile): void {
  mkdirSync(join(root, c.id), { recursive: true });
  writeFileSync(join(root, c.id, "case.json"), JSON.stringify(c));
}

function fakeDb() {
  const cache = new Map<string, { pass: boolean; tokens: number }>();
  const saved: { key: string; caseId: string; lessonId: string | null; pass: boolean; tokens: number }[] = [];
  const db: ReplayDeps["db"] = {
    cachedReplay: (key) => cache.get(key) ?? null,
    saveReplay: (key, caseId, lessonId, pass, tokens) => {
      cache.set(key, { pass, tokens });
      saved.push({ key, caseId, lessonId, pass, tokens });
    },
  };
  return { db, cache, saved };
}

const RT = { model: "m", agent: "a", appVersion: "1.0.0" };

/** A source case and two others on disk, with a cache-wired db. */
function scene() {
  const root = tempDir();
  const src = caseFile({ id: hexId(1) });
  const o1 = caseFile({ id: hexId(2) });
  const o2 = caseFile({ id: hexId(3) });
  for (const c of [src, o1, o2]) writeCase(root, c);
  return { root, src, o1, o2, ...fakeDb() };
}

describe("verifyLesson", () => {
  it("returns a null verification when there is no captured case", async () => {
    const { db } = fakeDb();
    const deps: ReplayDeps = { casesRoot: tempDir(), runCase: async () => ({ pass: true, tokens: 9 }), db, runtime: RT, now: () => 1 };
    const none = { verification: null, promote: false, why: "no captured case to replay", tokens: 0 };
    expect(await verifyLesson(lesson({ caseId: null }), deps)).toEqual(none);
    expect(await verifyLesson(lesson({ caseId: "ffffffffffffffff" }), deps)).toEqual(none);
  });

  it("promotes a lesson that fixes its case and holds on other cases", async () => {
    const { root, src, o1, o2, db, saved } = scene();
    const calls: boolean[] = [];
    const runCase = async (c: CaseFile, lessons: string | null) => {
      calls.push(lessons !== null);
      return { pass: c.id === src.id ? lessons !== null : true, tokens: 7 };
    };
    const r = await verifyLesson(lesson({ caseId: src.id }), {
      casesRoot: root,
      otherCases: (excludeId, max) => [o1, o2].filter((c) => c.id !== excludeId).slice(0, max),
      runCase,
      db,
      runtime: RT,
      now: () => 42,
    });
    expect(r.verification).toEqual({ model: "m", agent: "a", appVersion: "1.0.0", at: 42, before: { passed: 0, of: 1 }, after: { passed: 1, of: 1 }, transfer: { held: 2, of: 2 } });
    expect(r.promote).toBe(true);
    expect(r.why).toContain("fixed its case");
    expect(r.tokens).toBe(7 * 6);
    expect(calls).toEqual([false, true, false, true, false, true]);
    expect(saved).toHaveLength(6);
    expect(saved.map((s) => s.lessonId)).toEqual([null, "L1", null, "L1", null, "L1"]);
  });

  it("does not promote or run transfer when its case already passes without it", async () => {
    const { root, src, o1, o2, db } = scene();
    const calls: string[] = [];
    const runCase = async (c: CaseFile) => {
      calls.push(c.id);
      return { pass: true, tokens: 5 };
    };
    const r = await verifyLesson(lesson({ caseId: src.id }), {
      casesRoot: root,
      otherCases: () => [o1, o2],
      runCase,
      db,
      runtime: RT,
      now: () => 1,
    });
    expect(r.promote).toBe(false);
    expect(r.why).toBe("its case already passes without it");
    expect(r.verification).toMatchObject({ before: { passed: 1, of: 1 }, transfer: { held: 0, of: 0 } });
    expect(calls).toEqual([src.id, src.id]); // before + after only, no transfer
  });

  it("does not promote when its case still fails with the lesson", async () => {
    const { root, src, o1, db } = scene();
    const calls: string[] = [];
    const runCase = async (c: CaseFile) => {
      calls.push(c.id);
      return { pass: false, tokens: 5 };
    };
    const r = await verifyLesson(lesson({ caseId: src.id }), {
      casesRoot: root,
      otherCases: () => [o1],
      runCase,
      db,
      runtime: RT,
      now: () => 1,
    });
    expect(r.promote).toBe(false);
    expect(r.why).toBe("its case still fails with it");
    expect(r.verification).toMatchObject({ before: { passed: 0, of: 1 }, after: { passed: 0, of: 1 }, transfer: { held: 0, of: 0 } });
    expect(calls).toEqual([src.id, src.id]);
  });

  it("does not promote when a transfer case starts failing with it", async () => {
    const { root, src, o1, o2, db } = scene();
    const runCase = async (c: CaseFile, lessons: string | null) => {
      if (c.id === src.id) return { pass: lessons !== null, tokens: 1 };
      if (c.id === o2.id) return { pass: lessons === null, tokens: 1 }; // flips with the lesson
      return { pass: true, tokens: 1 };
    };
    const r = await verifyLesson(lesson({ caseId: src.id }), {
      casesRoot: root,
      otherCases: () => [o1, o2],
      runCase,
      db,
      runtime: RT,
      now: () => 1,
    });
    expect(r.promote).toBe(false);
    expect(r.why).toContain("made 1 of 2 other cases fail");
    expect(r.verification).toMatchObject({ before: { passed: 0, of: 1 }, after: { passed: 1, of: 1 }, transfer: { held: 1, of: 2 } });
  });

  it("promotes when it also fixes another failing case", async () => {
    const { root, src, o1, o2, db } = scene();
    const runCase = async (c: CaseFile, lessons: string | null) => {
      if (c.id === src.id || c.id === o2.id) return { pass: lessons !== null, tokens: 1 }; // the same mistake, fixed by it
      return { pass: true, tokens: 1 };
    };
    const r = await verifyLesson(lesson({ caseId: src.id }), {
      casesRoot: root,
      otherCases: () => [o1, o2],
      runCase,
      db,
      runtime: RT,
      now: () => 1,
    });
    expect(r.promote).toBe(true);
    expect(r.verification).toMatchObject({ transfer: { held: 2, of: 2 } });
  });

  it("reuses cached runs and adds no tokens for them", async () => {
    const { root, src, o1, o2, db, saved } = scene();
    let calls = 0;
    const runCase = async (c: CaseFile, lessons: string | null) => {
      calls++;
      return { pass: c.id === src.id ? lessons !== null : true, tokens: 7 };
    };
    const deps: ReplayDeps = {
      casesRoot: root,
      otherCases: () => [o1, o2],
      runCase,
      db,
      runtime: RT,
      now: () => 1,
    };
    const first = await verifyLesson(lesson({ caseId: src.id }), deps);
    expect(first.tokens).toBe(7 * 6);
    expect(calls).toBe(6);
    const again = await verifyLesson(lesson({ caseId: src.id }), deps);
    expect(calls).toBe(6); // every run came from the cache
    expect(again.tokens).toBe(0);
    expect(again.verification).toEqual(first.verification);
    expect(saved).toHaveLength(6);
  });

  it("decides nothing when a run throws, and never caches it", async () => {
    const { root, src, db, saved } = scene();
    let calls = 0;
    const runCase = async () => {
      calls++;
      throw new Error("replay exploded");
    };
    const deps: ReplayDeps = { casesRoot: root, runCase, db, runtime: RT, now: () => 1 };
    const r = await verifyLesson(lesson({ caseId: src.id }), deps);
    expect(r).toMatchObject({ verification: null, promote: false, tokens: 0 });
    expect(r.why).toContain("replay exploded");
    expect(saved).toEqual([]);
    await verifyLesson(lesson({ caseId: src.id }), deps);
    expect(calls).toBe(2); // it stopped at the first run, and nothing was cached, so it ran again
  });

  it("never promotes on a 'without' run that didn't finish (a hung provider isn't a failure)", async () => {
    const { root, src, o1, o2, db } = scene();
    const runCase = async (c: CaseFile, lessons: string | null) => {
      if (c.id === src.id && lessons === null) throw new Error("budget-stop");
      return { pass: true, tokens: 1 };
    };
    const r = await verifyLesson(lesson({ caseId: src.id }), { casesRoot: root, otherCases: () => [o1, o2], runCase, db, runtime: RT, now: () => 1 });
    expect(r.promote).toBe(false);
    expect(r.verification).toBeNull();
  });

  it("picks other cases held-out first by default", async () => {
    const root = tempDir();
    const src = caseFile({ id: hexId(1), createdAt: 5 });
    const recent = caseFile({ id: hexId(2), createdAt: 9 });
    const heldNew = caseFile({ id: hexId(4), heldOut: true, createdAt: 2 });
    const heldOld = caseFile({ id: hexId(3), heldOut: true, createdAt: 1 });
    for (const c of [src, recent, heldNew, heldOld]) writeCase(root, c);
    const { db } = fakeDb();
    const others: string[] = [];
    const runCase = async (c: CaseFile, lessons: string | null) => {
      if (c.id !== src.id) others.push(c.id);
      return { pass: c.id === src.id ? lessons !== null : true, tokens: 0 };
    };
    await verifyLesson(lesson({ caseId: src.id }), { casesRoot: root, runCase, db, runtime: RT, now: () => 1 });
    // held-out first (newest of them first), then the non-held-out newest.
    expect(others).toEqual([heldNew.id, heldNew.id, heldOld.id, heldOld.id, recent.id, recent.id]);
  });
});

describe("replayKey", () => {
  it("is a 32-char hex digest that differs by case, lesson, runtime and rollout", () => {
    const key = replayKey("case1", "L1", RT, 0);
    expect(key).toMatch(/^[a-f0-9]{32}$/);
    expect(replayKey("case1", "L1", RT, 0)).toBe(key);
    expect(replayKey("case2", "L1", RT, 0)).not.toBe(key);
    expect(replayKey("case1", null, RT, 0)).not.toBe(key);
    expect(replayKey("case1", "L2", RT, 0)).not.toBe(key);
    expect(replayKey("case1", "L1", { ...RT, model: "other" }, 0)).not.toBe(key);
    expect(replayKey("case1", "L1", { ...RT, appVersion: "2.0.0" }, 0)).not.toBe(key);
    expect(replayKey("case1", "L1", RT, 1)).not.toBe(key);
  });
});

describe("materializeCase", () => {
  it("archives the headSha, overlays base/ and removes deleted paths", () => {
    const casesRoot = tempDir();
    const projectPath = tempDir();
    const c = caseFile({ id: hexId(9), headSha: "abcdef1234567890abcdef1234567890abcdef12", deleted: ["gone.txt", "src/old.ts"] });
    mkdirSync(join(casesRoot, c.id, "base", "src"), { recursive: true });
    writeFileSync(join(casesRoot, c.id, "base", "src", "a.ts"), "overlay");
    mkdirSync(join(casesRoot, c.id, "base", "nested"), { recursive: true });
    writeFileSync(join(casesRoot, c.id, "base", "nested", "new.txt"), "base-new");

    const into = join(tempDir(), "work");
    const calls: { cmd: string; args: string[] }[] = [];
    const exec: typeof execCommandSync = (cmd, args) => {
      calls.push({ cmd, args: [...args] });
      if (cmd === "tar") {
        const dest = args[args.indexOf("-C") + 1]!;
        mkdirSync(join(dest, "src"), { recursive: true });
        writeFileSync(join(dest, "src", "fromGit.ts"), "git");
        writeFileSync(join(dest, "gone.txt"), "removed by deleted");
        writeFileSync(join(dest, "src", "old.ts"), "removed by deleted");
      }
      return "";
    };

    materializeCase(c, { casesRoot, projectPath, into, exec });

    const archive = calls.find((x) => x.cmd === "git")!;
    expect(archive.args).toEqual(["archive", "--format=tar", "-o", expect.stringContaining(`${c.id}.tar`), c.headSha]);
    expect(readFileSync(join(into, "src", "a.ts"), "utf8")).toBe("overlay"); // base/ wins over the archive
    expect(readFileSync(join(into, "src", "fromGit.ts"), "utf8")).toBe("git");
    expect(readFileSync(join(into, "nested", "new.txt"), "utf8")).toBe("base-new");
    expect(existsSync(join(into, "gone.txt"))).toBe(false);
    expect(existsSync(join(into, "src", "old.ts"))).toBe(false);
    expect(existsSync(join(into, "..", `${c.id}.tar`))).toBe(false); // the tar is cleaned up
  });

  it("reports a case commit that is no longer in the repository", () => {
    const c = caseFile({ id: hexId(8), headSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" });
    const exec: typeof execCommandSync = () => {
      throw new Error("fatal: not a valid object name");
    };
    expect(() => materializeCase(c, { casesRoot: tempDir(), projectPath: tempDir(), into: join(tempDir(), "w"), exec })).toThrow("the case's commit deadbee is no longer in the repository");
  });
});

describe("caseTask", () => {
  it("prepends the lessons to the case prompt and carries its graders and mode", () => {
    const c = caseFile({ id: hexId(4) });
    const block = "<harness-lessons>\n- Run the tests (the check failed)\n</harness-lessons>";
    const t = caseTask(c, "fx", block);
    expect(t.id).toBe(`case-${c.id}`);
    expect(t.fixture).toBe("fx");
    expect(t.mode).toBe(c.mode);
    expect(t.graders).toBe(c.graders);
    expect(t.budget).toEqual({ maxSteps: 40, maxInputTokens: 400_000, timeoutMs: 600_000 });
    expect(t.prompt).toBe(`${block}\n\n${c.prompt}`);
    expect(caseTask(c, "fx", null).prompt).toBe(c.prompt);
  });
});
