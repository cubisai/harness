// Tests for resources/skills/docx/scripts/docx.mjs — the Markdown -> .docx skill
// script. Each case runs the real CLI in a temp dir; the repo's devDependencies
// supply docx and mammoth, so nothing is installed.
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";

const script = join(process.cwd(), "resources/skills/docx/scripts/docx.mjs");
const req = createRequire(join(process.cwd(), "noop.js"));
const mammoth = req("mammoth") as {
  extractRawText(input: { path: string }): Promise<{ value: string }>;
};

// 2x1 PNG. The script only reads the IHDR width/height, so the pixel data is irrelevant.
const PNG_2X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function run(...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, CUBIQ_DOC_TOOLS: process.cwd() },
  });
}

describe("docx skill script", () => {
  it("init, build and check a sample report", async () => {
    const dir = tempDir();
    const draft = join(dir, "draft.md");
    const output = join(dir, "report.docx");

    const init = run("init", draft);
    expect(init.status).toBe(0);
    expect(existsSync(draft)).toBe(true);

    const build = run("build", draft, output);
    expect(build.status).toBe(0);
    expect(build.stdout).toMatch(/^OK:/m);
    expect(existsSync(output)).toBe(true);

    const text = (await mammoth.extractRawText({ path: output })).value;
    expect(text).toContain("Q3 Reliability Review");
    expect(text).toContain("What changed");
    expect(text).toContain("Checkout");
    expect(text).toContain("Payments");
    expect(text).toContain("On track");
  });

  it("fails the build on a TODO placeholder", () => {
    const dir = tempDir();
    const draft = join(dir, "draft.md");
    const output = join(dir, "out.docx");
    writeFileSync(draft, "# Report\n\nTODO: fill in the numbers.\n");

    const result = run("build", draft, output);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("TODO");
    expect(existsSync(output)).toBe(false);
  });

  it("names the line of a table row with the wrong cell count", () => {
    const dir = tempDir();
    const draft = join(dir, "draft.md");
    const output = join(dir, "out.docx");
    writeFileSync(draft, "# Report\n\n| A | B |\n| --- | --- |\n| 1 | 2 | 3 |\n");

    const result = run("build", draft, output);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("line 5");
    expect(result.stderr).toContain("3 cells");
  });

  it("embeds a PNG image", () => {
    const dir = tempDir();
    const draft = join(dir, "draft.md");
    const output = join(dir, "out.docx");
    writeFileSync(join(dir, "pixel.png"), Buffer.from(PNG_2X1, "base64"));
    writeFileSync(draft, "# Report\n\n![pixel](pixel.png)\n");

    const result = run("build", draft, output);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^OK:/m);
    expect(existsSync(output)).toBe(true);
  });

  it("refuses an output path equal to the input", () => {
    const dir = tempDir();
    const draft = join(dir, "draft.md");
    writeFileSync(draft, "# Report\n\nSome text.\n");

    const result = run("build", draft, draft);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("different from the input");
  });

  it("rejects a file that is not a valid .docx", () => {
    const dir = tempDir();
    const notes = join(dir, "notes.txt");
    writeFileSync(notes, "just text");

    const result = run("check", notes);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not a valid .docx");
  });
});
