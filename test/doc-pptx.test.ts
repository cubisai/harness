import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";

const SCRIPT = join(process.cwd(), "resources/skills/pptx/scripts/deck.mjs");
const req = createRequire(join(process.cwd(), "noop.js"));
const run = (cwd: string, ...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8", env: { ...process.env, CUBIQ_DOC_TOOLS: process.cwd() } });
const deck = (slides: unknown[]) => JSON.stringify({ title: "T", slides });

describe("pptx deck script", () => {
  it("builds the init sample into a 7-slide deck and checks it", async () => {
    const dir = tempDir();
    expect(run(dir, "init", "deck.json").status).toBe(0);
    const built = run(dir, "build", "deck.json", "deck.pptx");
    expect(built.status, built.stderr).toBe(0);
    expect(built.stdout).toMatch(/^OK: deck\.pptx — 7 slides/);
    const JSZip = req("jszip");
    const zip = await JSZip.loadAsync(readFileSync(join(dir, "deck.pptx")));
    expect(Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))).toHaveLength(7);
    expect(await zip.file("ppt/slides/slide1.xml").async("string")).toContain("Checkout reliability");
  }, 60_000);

  it("refuses more than six bullets, chart length mismatches and too much text, naming the slide", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "a.json"), deck([{ layout: "bullets", title: "A", bullets: ["1", "2", "3", "4", "5", "6", "7"] }]));
    const many = run(dir, "build", "a.json", "a.pptx");
    expect(many.status).toBe(1);
    expect(many.stderr).toMatch(/slide 1: 7 bullets.*split/);
    writeFileSync(join(dir, "b.json"), deck([{ layout: "title", title: "T" }, { layout: "chart", title: "C", chart: { type: "bar", labels: ["a", "b"], series: [{ name: "s", values: [1] }] } }]));
    expect(run(dir, "build", "b.json", "b.pptx").stderr).toMatch(/slide 2: series 1 has 1 values but there are 2 labels/);
    const long6 = Array.from({ length: 6 }, () => "word ".repeat(30).trim());
    writeFileSync(join(dir, "c.json"), deck([{ layout: "two-column", title: "Long", left: long6, right: long6 }]));
    const long = run(dir, "build", "c.json", "c.pptx");
    expect(long.status).toBe(1);
    expect(long.stderr).toMatch(/too much text on slide 1/);
  }, 60_000);

  it("refuses placeholder text and an output that is the input", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "a.json"), deck([{ layout: "bullets", title: "Plan", bullets: ["TODO fill this in"] }]));
    expect(run(dir, "build", "a.json", "a.pptx").stderr).toMatch(/placeholder text/);
    expect(run(dir, "build", "a.json", "a.json").stderr).toMatch(/output path is the input/);
  });

  it("check flags a shape off the slide", async () => {
    const dir = tempDir();
    const JSZip = req("jszip");
    const zip = new JSZip();
    zip.file("ppt/slides/slide1.xml", '<p:sld><a:off x="99999999" y="0"/><a:ext cx="100" cy="100"/><a:t>Hello</a:t></p:sld>');
    writeFileSync(join(dir, "bad.pptx"), await zip.generateAsync({ type: "nodebuffer" }));
    const checked = run(dir, "check", "bad.pptx");
    expect(checked.status).toBe(1);
    expect(checked.stderr).toMatch(/slide 1: a shape is outside the slide/);
  });
});
