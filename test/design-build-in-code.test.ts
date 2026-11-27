import { describe, expect, it } from "vitest";
import { buildInCodePrompt, buildThreadPatch, handoffPath } from "../src/shared/design";
import { captureDesign, creatorFilesFromReview, writeDesignSnapshot } from "../src/main/design/review";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers";

describe("Build in code", () => {
  it("pins the reviewed page, linked CSS, artwork and handoff across later edits", async () => {
    const source = tempDir(), snapshot = tempDir(), project = tempDir();
    for (const dir of [source, project]) {
      writeFileSync(join(dir, "index.html"), '<link rel="stylesheet" href="card.css"><h1>v2</h1>');
      writeFileSync(join(dir, "card.css"), '.card { background:url("card.svg") }');
      writeFileSync(join(dir, "card.svg"), dir === source ? '<svg id="v2"/>' : '<svg id="wrong"/>');
      writeFileSync(join(dir, "handoff.md"), "Approved handoff");
    }
    const capture = await captureDesign(source, "index.html", true);
    await writeDesignSnapshot(snapshot, capture.contents);
    for (const file of capture.files) writeFileSync(join(source, file.path), "v3");
    expect(readFileSync(join(snapshot, "card.svg"), "utf8")).toBe('<svg id="v2"/>');
    expect(readFileSync(join(snapshot, "handoff.md"), "utf8")).toBe("Approved handoff");
    const draft = await creatorFilesFromReview(snapshot, { ...capture, page: "index.html" }, "my-card", { width: 200, height: 120 });
    expect(JSON.parse(draft.find((f) => f.path === "app.json")!.content)).toMatchObject({ grants: [], placement: "floating", size: { width: 200, height: 120 } });
    expect(draft).toContainEqual({ path: "card.svg", content: '<svg id="v2"/>' });
  });
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
    // A live Codex run replaced the site's home page with the pricing design; existing pages stay unless the handoff says otherwise.
    expect(prompt).toContain("Don't remove or rewrite existing pages or content unless the handoff says the design replaces them.");
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
