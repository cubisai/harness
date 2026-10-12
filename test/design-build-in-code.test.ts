import { describe, expect, it } from "vitest";
import { buildInCodePrompt, handoffPath } from "../src/shared/design";

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
