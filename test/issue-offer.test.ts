import { describe, expect, it } from "vitest";
import { filedThisTurn, mightReportProblem, offerPrompt, parseOffer } from "../src/main/issue-offer";

describe("issue offer helpers", () => {
  it("passes replies that name a problem, and skips plain ones", () => {
    expect(mightReportProblem("node test.js still fails because of a pre-existing bug in util.js")).toBe(true);
    expect(mightReportProblem("I left util.js untouched since it's out of scope.")).toBe(true);
    expect(mightReportProblem("Added sum to math.js; all tests pass.")).toBe(false);
  });

  it("sees a filing under any tool prefix", () => {
    expect(filedThisTurn(["Read", "mcp__cubiq__issue_create"])).toBe(true);
    expect(filedThisTurn(["cubiq_issue_create"])).toBe(true);
    expect(filedThisTurn(["issue_create"])).toBe(true);
    expect(filedThisTurn(["Read", "Edit"])).toBe(false);
  });

  it("asks for one line of JSON about the request and the reply, clipped", () => {
    const prompt = offerPrompt("Add sum", `It fails.${"x".repeat(5000)}`);
    expect(prompt).toContain('{"file":false}');
    expect(prompt).toContain("<request>\nAdd sum\n</request>");
    expect(prompt.length).toBeLessThan(6000);
  });

  it("reads an offer, and nothing else, from the model's answer", () => {
    expect(parseOffer('Sure: {"file":true,"type":"bug","title":"isEven returns false for even numbers.","summary":"util.js:2 checks n % 2 === 1."}')).toEqual({
      type: "bug",
      title: "isEven returns false for even numbers",
      summary: "util.js:2 checks n % 2 === 1.",
    });
    expect(parseOffer('{"file":false}')).toBeNull();
    expect(parseOffer('{"file":true,"type":"chore","title":"Tidy"}')).toBeNull();
    expect(parseOffer('{"file":true,"type":"bug","title":"x"}')).toBeNull();
    expect(parseOffer("no json here")).toBeNull();
  });
});
