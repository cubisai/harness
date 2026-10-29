import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import { docxToHtml, previewKind, pptxSlides, sanitizeHtml, sheetsFrom } from "../src/main/preview/office";
import { PreviewHost, type WorkerLike } from "../src/main/preview/host";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

async function docxBuffer(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>Hello docx</w:t></w:r></w:p></w:body>
</w:document>`,
  );
  return await zip.generateAsync({ type: "nodebuffer" });
}

function xlsxBuffer(): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[1], [2], [3], [4], [5], [6]]), "Six");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["a", "b"]]), "Small");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

const SLIDE_WRAP = (body: string): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>${body}</p:spTree></p:cSld>
</p:sld>`;

async function pptxBuffer(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "ppt/slides/slide1.xml",
    SLIDE_WRAP(`<p:sp>
      <p:nvSpPr><p:cNvPr id="2" name="Body"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
      <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>First</a:t></a:r></a:p></p:txBody>
    </p:sp>`),
  );
  zip.file(
    "ppt/slides/slide2.xml",
    SLIDE_WRAP(`<p:sp>
      <p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
      <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Second</a:t></a:r></a:p></p:txBody>
    </p:sp>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
      <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>a &amp; b</a:t></a:r></a:p></p:txBody>
    </p:sp>`),
  );
  zip.file(
    "ppt/slides/_rels/slide1.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>
</Relationships>`,
  );
  zip.file("ppt/media/image1.png", Buffer.from(PNG_BASE64, "base64"));
  return await zip.generateAsync({ type: "nodebuffer" });
}

type Posted = { id: number; path: string; maxBytes: number };

/** A WorkerLike the test drives: it records posts and can answer, exit, or stay silent. */
class FakeWorker implements WorkerLike {
  readonly posted: Posted[] = [];
  killed = false;
  private messageHandler?: (v: unknown) => void;
  private exitHandler?: (code: number) => void;

  constructor(private readonly reply: (message: Posted) => unknown | undefined) {}

  postMessage(v: unknown): void {
    const message = v as Posted;
    this.posted.push(message);
    const answer = this.reply(message);
    if (answer !== undefined) this.messageHandler?.(answer);
  }

  on(e: "message", f: (v: unknown) => void): void;
  on(e: "exit", f: (code: number) => void): void;
  on(e: "message" | "exit", f: ((v: unknown) => void) | ((code: number) => void)): void {
    if (e === "message") this.messageHandler = f as (v: unknown) => void;
    else this.exitHandler = f as (code: number) => void;
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }

  exit(): void {
    this.exitHandler?.(0);
  }
}

describe("previewKind", () => {
  it("maps office extensions by kind, null otherwise", () => {
    expect(previewKind("a.DOCX")).toBe("docx");
    expect(previewKind("a.PPTX")).toBe("pptx");
    for (const ext of ["xlsx", "xls", "xlsm", "ods", "csv", "tsv"]) expect(previewKind(`a.${ext}`)).toBe("sheet");
    expect(previewKind("a.pdf")).toBeNull();
    expect(previewKind("noextension")).toBeNull();
  });
});

describe("sanitizeHtml", () => {
  it("strips active content but keeps allowlisted image data URIs", () => {
    const clean = sanitizeHtml(
      `<p onclick="evil()">Hi</p><style>p{}</style><script>alert(1)</script>` +
        `<a href="javascript:alert(1)">x</a><img src="data:image/png;base64,AAAA"><img src="data:text/html;base64,BBBB">`,
    );
    expect(clean).not.toContain("<script");
    expect(clean).not.toContain("<style");
    expect(clean).not.toContain("evil(");
    expect(clean).not.toContain("javascript:");
    expect(clean).toContain('<img src="data:image/png;base64,AAAA">');
    expect(clean).not.toContain("data:text/html");
  });
});

describe("docxToHtml", () => {
  it("renders paragraphs to HTML", async () => {
    const preview = await docxToHtml(await docxBuffer());
    expect(preview.kind).toBe("docx");
    if (preview.kind !== "docx") return;
    expect(preview.html).toContain("Hello docx");
  });
});

describe("sheetsFrom", () => {
  it("caps rows per sheet and reports the untruncated total", () => {
    const preview = sheetsFrom(xlsxBuffer(), "book.xlsx", 5);
    expect(preview.kind).toBe("sheet");
    if (preview.kind !== "sheet") return;
    expect(preview.sheets.map((s) => s.name)).toEqual(["Six", "Small"]);
    expect(preview.sheets[0]).toMatchObject({ totalRows: 6, truncated: true });
    expect(preview.sheets[0]!.rows).toHaveLength(5);
    expect(preview.sheets[1]).toMatchObject({ totalRows: 1, truncated: false });
  });

  it("reads CSV text as one sheet", () => {
    const preview = sheetsFrom(Buffer.from("a,b\nc,d\n", "utf8"), "data.csv");
    expect(preview.kind).toBe("sheet");
    if (preview.kind !== "sheet") return;
    expect(preview.sheets[0]!.rows).toEqual([["a", "b"], ["c", "d"]]);
  });
});

describe("pptxSlides", () => {
  it("keeps slide order, title, text, and the slide's image", async () => {
    const preview = await pptxSlides(await pptxBuffer());
    expect(preview.kind).toBe("pptx");
    if (preview.kind !== "pptx") return;
    expect(preview.slides.map((s) => s.index)).toEqual([1, 2]);
    expect(preview.slides[1]!.title).toBe("Second");
    expect(preview.slides[1]!.texts).toContain("a & b");
    expect(preview.slides[0]!.images).toHaveLength(1);
    expect(preview.slides[0]!.images[0]).toMatch(/^data:image\/png;base64,/);
  });
});

describe("PreviewHost", () => {
  const success = (message: Posted): unknown => ({ id: message.id, ok: true, result: { kind: "docx", html: "<p>x</p>", warnings: [] } });

  it("caches by path and mtime, so a second call does not post", async () => {
    const workers: FakeWorker[] = [];
    const host = new PreviewHost(
      () => {
        const worker = new FakeWorker(success);
        workers.push(worker);
        return worker;
      },
      { stat: async () => ({ mtimeMs: 1, size: 10 }) },
    );
    const first = await host.preview("/tmp/a.docx");
    const second = await host.preview("/tmp/a.docx");
    expect(second).toEqual(first);
    expect(workers).toHaveLength(1);
    expect(workers[0]!.posted).toHaveLength(1);
    host.dispose();
  });

  it("forks a fresh worker after the current one exits", async () => {
    const workers: FakeWorker[] = [];
    const host = new PreviewHost(
      () => {
        const worker = new FakeWorker(success);
        workers.push(worker);
        return worker;
      },
      { stat: async () => ({ mtimeMs: 1, size: 10 }) },
    );
    expect(await host.preview("/tmp/a.docx")).toMatchObject({ ok: true });
    workers[0]!.exit();
    expect(await host.preview("/tmp/b.docx")).toMatchObject({ ok: true });
    expect(workers).toHaveLength(2);
    host.dispose();
  });

  it("times out and kills the worker", async () => {
    const workers: FakeWorker[] = [];
    const host = new PreviewHost(
      () => {
        const worker = new FakeWorker(() => undefined);
        workers.push(worker);
        return worker;
      },
      { timeoutMs: 50, stat: async () => ({ mtimeMs: 1, size: 10 }) },
    );
    expect(await host.preview("/tmp/a.docx")).toEqual({ ok: false, error: "Preview timed out" });
    expect(workers[0]!.killed).toBe(true);
    host.dispose();
  });

  it("rejects oversized files without forking", async () => {
    let forks = 0;
    const host = new PreviewHost(
      () => {
        forks += 1;
        return new FakeWorker(() => undefined);
      },
      { stat: async () => ({ mtimeMs: 1, size: 26 * 1024 * 1024 }) },
    );
    expect(await host.preview("/tmp/a.docx")).toEqual({ ok: false, error: "File is larger than 25 MB" });
    expect(forks).toBe(0);
    host.dispose();
  });
});
