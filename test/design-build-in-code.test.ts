import { describe, expect, it } from "vitest";
import { buildInCodePrompt, buildThreadPatch, handoffPath } from "../src/shared/design";

describe("Build in code", () => {
  it("points at the handoff beside the design's pages", () => {
    expect(handoffPath("designs/ab12cd34")).toBe("designs/ab12cd34/handoff.md");
  });

  it("asks for the codebase's real components and checks, not a copy of the prototype", () => {
    const prompt = buildInCodePrompt("designs/ab12cd34");
    expect(prompt.startsWith("Build the design in `designs/ab12cd34/` into this codebase.")).toBe(true);
    expect(prompt).toContain("`designs/ab12cd34/handoff.md`");
    expect(prompt).toContain("`designs/ab12cd34/index.html`");
    expect(prompt).toContain("real components, styles and tokens");
    expect(prompt).toContain("Don't copy the prototype's HTML or CSS wholesale");
    expect(prompt).toContain("Run the project's checks");
  });
});

describe("buildThreadPatch", () => {
  const fresh = { model: "default", effort: null, contextWindow: null };
  it("gives the build thread the design's model, effort and context window", () => {
    expect(buildThreadPatch({ model: "opencode/big-pickle", effort: "high", contextWindow: 200_000 }, fresh)).toEqual({
      model: "opencode/big-pickle",
      effort: "high",
      contextWindow: 200_000,
    });
  });

  it("changes nothing when they already match (a design on the agent's default)", () => {
    expect(buildThreadPatch(fresh, fresh)).toEqual({});
    expect(buildThreadPatch({ model: "default", effort: null }, fresh)).toEqual({});
  });
});
