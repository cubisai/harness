import { describe, expect, it } from "vitest";
import { addedLines, claimsPass, evidenceFlags, isTestPath, markerCounts, newMarkers, ranChecks, type EvidenceInput } from "../src/main/evidence";

describe("isTestPath", () => {
  it("knows test files across languages", () => {
    for (const p of ["src/a.test.ts", "a.spec.jsx", "test/x.ts", "pkg/__tests__/y.js", "tests/test_calc.py", "calc_test.go", "src/FooTest.java", "spec/a_spec.rb", "src\\b.test.ts"]) {
      expect(isTestPath(p), p).toBe(true);
    }
  });

  it("leaves source files alone", () => {
    for (const p of ["src/a.ts", "src/testing-utils-free.ts", "contest.ts", "README.md", "latest/x.ts"]) {
      expect(isTestPath(p), p).toBe(false);
    }
  });
});

describe("markers", () => {
  it("counts skips, onlys and trivial asserts in added lines", () => {
    const counts = markerCounts(["  it.skip('x', () => {", "describe.only('y')", "xit('z')", "@pytest.mark.skip", "expect(true).toBe(true);", "assert True", "expect(add(1, 2)).toBe(3);"]);
    expect(Object.fromEntries(counts)).toEqual({ ".skip/.only": 3, skip: 1, "trivial assert": 2 });
  });

  it("reads only a diff's added lines", () => {
    expect(addedLines("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-it.skip('a')\n+it('a')\n context")).toEqual(["it('a')"]);
  });

  it("reports only labels whose count grew", () => {
    expect(newMarkers(new Map([[".skip/.only", 1]]), new Map([[".skip/.only", 1]]))).toEqual([]);
    expect(newMarkers(new Map([[".skip/.only", 1]]), new Map([[".skip/.only", 2], ["skip", 1]]))).toEqual([".skip/.only", "skip"]);
  });
});

describe("claimsPass", () => {
  it("catches a plain success claim", () => {
    for (const a of ["Done. All tests pass.", "The tests now pass and typecheck is clean.", "Build succeeded.", "All 12 tests pass", "Fixed it — tests are passing."]) {
      expect(claimsPass(a), a).toBe(true);
    }
  });

  it("ignores hedged, negated or conditional mentions", () => {
    for (const a of ["I didn't run the tests.", "Tests should pass once you install deps.", "Run npm test to check the tests pass.", "The tests don't pass yet.", "No tests pass right now.", "Added the function."]) {
      expect(claimsPass(a), a).toBe(false);
    }
  });
});

describe("ranChecks", () => {
  it("recognises test, typecheck, lint and build commands", () => {
    for (const c of ["npm test", "bun run typecheck", "pytest -q", "go test ./...", "cargo clippy", "npx tsc --noEmit", "make check"]) expect(ranChecks([c]), c).toBe(true);
    expect(ranChecks(["ls -la", "cat src/a.ts", "git status"])).toBe(false);
  });
});

describe("evidenceFlags", () => {
  const base: EvidenceInput = { editedTests: [], deletedTests: [], weakened: [], request: "fix add()", answer: "Fixed add().", commands: [], checkPassed: false };

  it("stays silent on a clean turn", () => {
    expect(evidenceFlags(base)).toEqual([]);
  });

  it("flags deletions, weakened tests and edits to existing tests", () => {
    const flags = evidenceFlags({ ...base, deletedTests: ["a.test.ts"], weakened: [{ path: "b.test.ts", labels: [".skip/.only"] }], editedTests: ["b.test.ts", "c.test.ts"] });
    expect(flags).toEqual(["Deleted test files: a.test.ts.", "Added .skip/.only in b.test.ts.", "Changed existing tests: c.test.ts. Check they weren't loosened to pass."]);
  });

  it("expects test edits when the request is about tests", () => {
    expect(evidenceFlags({ ...base, request: "update the tests for add", editedTests: ["a.test.ts"] })).toEqual([]);
    // Weakening still shows.
    expect(evidenceFlags({ ...base, request: "update the tests", weakened: [{ path: "a.test.ts", labels: ["skip"] }] })).toHaveLength(1);
  });

  it("flags a pass claim only when nothing checked it", () => {
    const claim = { ...base, answer: "Done. All tests pass." };
    expect(evidenceFlags(claim)).toEqual(["Says tests or checks pass, but none ran this turn."]);
    expect(evidenceFlags({ ...claim, commands: ["npm test"] })).toEqual([]);
    expect(evidenceFlags({ ...claim, checkPassed: true })).toEqual([]);
  });

  it("shortens long file lists", () => {
    const [flag] = evidenceFlags({ ...base, deletedTests: ["a.test.ts", "b.test.ts", "c.test.ts", "d.test.ts", "e.test.ts"] });
    expect(flag).toBe("Deleted test files: a.test.ts, b.test.ts, c.test.ts and 2 more.");
  });
});
