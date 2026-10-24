import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { documentCsp, documentUrl, pdfPageCount, serveDocument } from "../src/main/documents/serve";
import { documentTools, type DocumentToolDeps } from "../src/main/documents/tools";
import type { ScriptResult } from "../src/main/documents/run";
import type { HarnessTool } from "../src/main/agents/types";
import { tempDir } from "./helpers";

type Call = { script: string; args: string[]; cwd: string };

function setup(result: Partial<ScriptResult> = {}, printed = { pages: 2, text: "Hello report", png: Buffer.from("png") }) {
  const folder = tempDir();
  const calls: Call[] = [];
  const template = join(tempDir(), "report.html");
  writeFileSync(template, "<!doctype html><p>Template</p>");
  const deps: DocumentToolDeps = {
    folder: () => folder,
    scriptsDir: "/skills",
    packagesRoot: "/app",
    pdfTemplate: template,
    run: async (script, args, cwd) => {
      calls.push({ script, args, cwd });
      return { code: 0, stdout: "OK: built", stderr: "", timedOut: false, ...result };
    },
    printPdf: async () => printed,
  };
  const tools = Object.fromEntries(documentTools(deps, "t1").map((t) => [t.name, t])) as Record<string, HarnessTool>;
  return { folder, calls, tools, template };
}

describe("document tools", () => {
  it("builds Markdown into a .docx with the docx script, in the thread's folder", async () => {
    const { folder, calls, tools } = setup();
    writeFileSync(join(folder, "a.md"), "# Hi");
    const out = await tools.document_build!.run({ input: "a.md" });
    expect(out).toEqual({ text: "OK: built" });
    expect(calls).toEqual([{ script: join("/skills", "docx/scripts/docx.mjs"), args: ["build", "a.md", "a.docx"], cwd: folder }]);
  });

  it("tells a deck from a workbook by its JSON, and refuses other JSON", async () => {
    const { folder, calls, tools } = setup();
    writeFileSync(join(folder, "deck.json"), JSON.stringify({ slides: [] }));
    writeFileSync(join(folder, "book.json"), JSON.stringify({ sheets: [] }));
    writeFileSync(join(folder, "other.json"), JSON.stringify({ rows: [] }));
    await tools.document_build!.run({ input: "deck.json" });
    await tools.document_build!.run({ input: "book.json" });
    expect(calls.map((c) => [c.script, c.args[2]])).toEqual([
      [join("/skills", "pptx/scripts/deck.mjs"), "deck.pptx"],
      [join("/skills", "xlsx/scripts/sheet.mjs"), "book.xlsx"],
    ]);
    const other = await tools.document_build!.run({ input: "other.json" });
    expect(other.isError).toBe(true);
    expect(other.text).toMatch(/"slides" array .* "sheets" array/);
  });

  it("passes the script's ERROR lines back with what to do next", async () => {
    const { folder, tools } = setup({ code: 1, stdout: "", stderr: "ERROR: slide 2: 7 bullets" });
    writeFileSync(join(folder, "deck.json"), JSON.stringify({ slides: [] }));
    const out = await tools.document_build!.run({ input: "deck.json" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("ERROR: slide 2: 7 bullets");
    expect(out.text).toContain("call document_build again");
  });

  it("refuses paths outside the thread's folder and a wrong output extension", async () => {
    const { folder, tools } = setup();
    writeFileSync(join(folder, "a.md"), "# Hi");
    expect((await tools.document_build!.run({ input: "../a.md" })).text).toMatch(/outside this thread's folder/);
    expect((await tools.document_build!.run({ input: "a.md", output: "a.pdf" })).text).toMatch(/builds a \.docx/);
    expect((await tools.document_build!.run({ input: "missing.md" })).text).toMatch(/doesn't exist yet/);
  });

  it("prints HTML to PDF and attaches page 1, but refuses placeholder text", async () => {
    const ok = setup();
    writeFileSync(join(ok.folder, "letter.html"), "<p>x</p>");
    const printed = await ok.tools.document_build!.run({ input: "letter.html" });
    expect(printed.text).toBe("OK: letter.pdf — 2 pages. Page 1 is attached: check nothing overlaps or is cut off.");
    expect(printed.imagePng).toBe(Buffer.from("png").toString("base64"));
    const bad = setup({}, { pages: 1, text: "Summary: TODO", png: Buffer.from("") });
    writeFileSync(join(bad.folder, "letter.html"), "<p>x</p>");
    const refused = await bad.tools.document_build!.run({ input: "letter.html" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/placeholder text: "Summary: TODO"/);
  });

  it("starts a PDF from the template without overwriting, and other formats with the script's init", async () => {
    const { folder, calls, tools } = setup();
    expect((await tools.document_template!.run({ format: "pdf", path: "letter.html" })).text).toMatch(/^Wrote letter\.html/);
    expect(readFileSync(join(folder, "letter.html"), "utf8")).toContain("Template");
    expect((await tools.document_template!.run({ format: "pdf", path: "letter.html" })).text).toMatch(/already exists/);
    expect((await tools.document_template!.run({ format: "docx", path: "report.html" })).text).toMatch(/starts from a \.md file/);
    await tools.document_template!.run({ format: "xlsx", path: "budget.json" });
    expect(calls.at(-1)?.args).toEqual(["init", "budget.json"]);
  });
});

describe("cubiq-doc:// serving", () => {
  it("serves only the thread's folder, with a no-script, no-network CSP", async () => {
    const root = tempDir();
    mkdirSync(join(root, "img"));
    writeFileSync(join(root, "letter.html"), "<p>hi</p>");
    writeFileSync(join(root, "img", "a b.png"), "png");
    const ok = serveDocument(documentUrl("t1", "letter.html"), () => root);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-security-policy")).toBe(documentCsp());
    expect(documentCsp()).toContain("script-src 'none'");
    expect(documentCsp()).toContain("connect-src 'none'");
    expect(await ok.text()).toBe("<p>hi</p>");
    expect(serveDocument(documentUrl("t1", "img/a b.png"), () => root).status).toBe(200);
    expect(serveDocument("cubiq-doc://t1/..%2F..%2Fetc%2Fpasswd", () => root).status).toBe(404);
    expect(serveDocument(documentUrl("t2", "letter.html"), () => null).status).toBe(404);
  });

  it("counts a PDF's pages from its page objects, not its page tree", () => {
    expect(pdfPageCount(Buffer.from("<< /Type /Pages /Count 2 >> << /Type /Page >> << /Type/Page /Parent 1 0 R >>", "latin1"))).toBe(2);
  });
});
