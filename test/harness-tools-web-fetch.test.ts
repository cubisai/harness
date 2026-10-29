import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BUILT_IN_GUARD } from "../src/main/guard";
import { nativeTools } from "../src/main/harness/tools";
import { htmlToText, webFetchTool } from "../src/main/harness/tools/web-fetch";
import type { ToolContext } from "../src/main/harness/tools/types";

let server: Server;
let base: string;
let dir: string;

const PAGE = `<!doctype html><html><head><title>Docs &amp; Notes</title><style>.x{color:red}</style><script>alert(1)</script></head>
<body><nav><a href="/home">Home</a></nav><h1>Release 4.2</h1><p>Install with <code>npm i kestrel@4.2.0</code>.</p>
<ul><li>Faster&nbsp;builds</li><li>New <a href="https://example.com/api">API docs</a></li></ul><!-- hidden --></body></html>`;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "harness-fetch-"));
  server = createServer((req, res) => {
    if (req.url === "/page") return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
    if (req.url === "/json") return res.writeHead(200, { "content-type": "application/json" }).end('{"version":"4.2.0"}');
    if (req.url === "/moved") return res.writeHead(302, { location: "/json" }).end();
    if (req.url === "/png") return res.writeHead(200, { "content-type": "image/png" }).end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    if (req.url === "/big") return res.writeHead(200, { "content-type": "text/plain" }).end(Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join("\n"));
    if (req.url === "/slow") return; // never answers
    res.writeHead(404, { "content-type": "text/plain" }).end("no such page");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

const context = (signal = new AbortController().signal): ToolContext => ({ cwd: dir, signal, outputDir: join(dir, ".out"), callId: "f1", reads: new Map(), guardScript: BUILT_IN_GUARD });

describe("htmlToText", () => {
  it("keeps the readable text and absolute links, drops scripts, styles and comments", () => {
    const { title, text } = htmlToText(PAGE, "https://docs.test/x");
    expect(title).toBe("Docs & Notes");
    expect(text).toContain("Release 4.2");
    expect(text).toContain("Install with npm i kestrel@4.2.0.");
    expect(text).toContain("- Faster builds");
    expect(text).toContain("API docs (https://example.com/api)");
    expect(text).toContain("Home (https://docs.test/home)");
    expect(text).not.toMatch(/alert|color:red|hidden|<\w/);
  });
});

describe("web_fetch", () => {
  it("is offered to every model family as a web call", () => {
    for (const model of ["claude-sonnet-5-5", "gpt-5.5", "deepseek-v4.1-flash"]) expect(nativeTools(model).map((t) => t.name)).toContain("web_fetch");
    expect(webFetchTool.access).toBe("web");
  });

  it("returns a page as text with its URL, status and title", async () => {
    const r = await webFetchTool.run({ url: `${base}/page` }, context());
    expect(r.isError).toBeUndefined();
    expect(r.text).toMatch(/^URL: http:\/\/127\.0\.0\.1:\d+\/page\nStatus: 200 OK\nTitle: Docs & Notes\n\n/);
    expect(r.text).toContain("npm i kestrel@4.2.0");
    expect(r.display?.summary).toMatch(/\/page · 200 · 1 KB$/);
  });

  it("follows redirects and returns JSON as is", async () => {
    const r = await webFetchTool.run({ url: `${base}/moved` }, context());
    expect(r.text).toContain(`URL: ${base}/json`);
    expect(r.text).toContain('{"version":"4.2.0"}');
  });

  it("marks an error status and still shows the body", async () => {
    const r = await webFetchTool.run({ url: `${base}/missing` }, context());
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Status: 404");
    expect(r.text).toContain("no such page");
  });

  it("refuses binary content, bad URLs and other schemes", async () => {
    await expect(webFetchTool.run({ url: `${base}/png` }, context())).rejects.toThrow("is image/png, not text");
    await expect(webFetchTool.run({ url: "not a url" }, context())).rejects.toThrow("Not a valid URL");
    await expect(webFetchTool.run({ url: "file:///etc/passwd" }, context())).rejects.toThrow("Only http and https");
  });

  it("bounds a long page and saves the whole of it", async () => {
    const r = await webFetchTool.run({ url: `${base}/big` }, context());
    expect(r.text).toContain("line 1\n");
    expect(r.text).not.toContain("line 5000");
    const saved = /the full output is in (.+?) \(Read it/.exec(r.text)?.[1];
    expect(saved && existsSync(saved)).toBe(true);
    expect(readFileSync(saved!, "utf8")).toContain("line 5000");
  });

  it("stops when the turn is stopped", async () => {
    const stop = new AbortController();
    const pending = webFetchTool.run({ url: `${base}/slow` }, context(stop.signal));
    setTimeout(() => stop.abort(), 50);
    await expect(pending).rejects.toThrow("Couldn't fetch");
  });
});
