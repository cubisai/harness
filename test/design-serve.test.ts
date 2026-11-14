import { textHash } from "../src/shared/text-hash";
import { mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  contentTypeOf,
  designCsp,
  designDirName,
  designUrl,
  entryFile,
  injectBridge,
  parseDesignUrl,
  serveDesign,
  type DesignDeps,
} from "../src/main/design/serve";
import { tempDir } from "./helpers";

/** A temp design folder for thread `t`, with the request handlers wired to it. */
function setup(): { base: string; root: string; deps: (overrides?: Partial<DesignDeps>) => DesignDeps } {
  const base = tempDir();
  const root = join(base, "designs", "abcd1234");
  mkdirSync(join(root, "sub"), { recursive: true });
  writeFileSync(join(root, "index.html"), "<html><head><title>x</title></head><body>hi</body></html>");
  writeFileSync(join(root, "style.css"), "body{color:red}");
  writeFileSync(join(root, "bare.html"), "<p>bare</p>");
  const deps = (overrides: Partial<DesignDeps> = {}): DesignDeps => ({
    designRoot: (id) => (id === "t" ? root : null),
    readVersion: () => null,
    bridge: "window.__b=1;",
    ...overrides,
  });
  return { base, root, deps };
}

describe("design URLs", () => {
  it("round-trips a thread and a nested path with spaces and unicode", () => {
    const url = designUrl("thread-1", "pages/hello world 日本語.html");
    expect(url).toBe("cubiq-design://d/thread-1/pages/hello%20world%20%E6%97%A5%E6%9C%AC%E8%AA%9E.html");
    expect(parseDesignUrl(url)).toEqual({ threadId: "thread-1", rel: "pages/hello world 日本語.html", version: null });
  });

  it("carries a version only when it is a positive integer", () => {
    expect(designUrl("t", "a.html", 2)).toBe("cubiq-design://d/t/a.html?v=2");
    expect(designUrl("t", "a.html", 0)).toBe("cubiq-design://d/t/a.html");
    expect(designUrl("t", "a.html", null)).toBe("cubiq-design://d/t/a.html");
    expect(parseDesignUrl(designUrl("t", "a.html", 2))).toEqual({ threadId: "t", rel: "a.html", version: 2 });
  });

  it("names a thread's design folder", () => {
    expect(designDirName("abcdef0123456789")).toBe("designs/abcdef01");
  });

  it("rejects traversal, encoded separators, bad hosts, and bad versions", () => {
    expect(parseDesignUrl("cubiq-design://d/t/../x")).toBeNull();
    expect(parseDesignUrl("cubiq-design://d/../x")).toBeNull();
    expect(parseDesignUrl("cubiq-design://d/t/sub/../x")).toBeNull();
    expect(parseDesignUrl("cubiq-design://d/t/%2e%2e/x")).toBeNull();
    expect(parseDesignUrl("cubiq-design://d/t/a%2Fb")).toBeNull();
    expect(parseDesignUrl("cubiq-design://d/t/a%5Cb")).toBeNull();
    expect(parseDesignUrl("cubiq-design://d/t/a%00b")).toBeNull();
    expect(parseDesignUrl("cubiq-design://d/t/.")).toBeNull();
    expect(parseDesignUrl("cubiq-design://d/t/")).toBeNull();
    expect(parseDesignUrl("cubiq-design://d/")).toBeNull();
    expect(parseDesignUrl("cubiq-design://f/t/a")).toBeNull();
    expect(parseDesignUrl("https://d/t/a")).toBeNull();
    expect(parseDesignUrl("cubiq-design://d/t/a.html?v=0")).toBeNull();
    expect(parseDesignUrl("cubiq-design://d/t/a.html?v=abc")).toBeNull();
    expect(parseDesignUrl("cubiq-design://d/t/a.html?v=-1")).toBeNull();
    expect(parseDesignUrl("cubiq-design://d/t/a.html?v=")).toBeNull();
  });
});

describe("content types", () => {
  it("maps extensions, case-insensitively, with a binary default", () => {
    expect(contentTypeOf("a.HTML")).toBe("text/html; charset=utf-8");
    expect(contentTypeOf("a.css")).toBe("text/css; charset=utf-8");
    expect(contentTypeOf("a.mjs")).toBe("text/javascript; charset=utf-8");
    expect(contentTypeOf("a.svg")).toBe("image/svg+xml");
    expect(contentTypeOf("a.woff2")).toBe("font/woff2");
    expect(contentTypeOf("a.bin")).toBe("application/octet-stream");
    expect(contentTypeOf("LICENSE")).toBe("application/octet-stream");
  });
});

describe("injectBridge", () => {
  it("inserts after <head>, then <html>, then at the very start", () => {
    expect(injectBridge("<html><head></head><body>x</body></html>", "A")).toBe("<html><head><script>A</script></head><body>x</body></html>");
    expect(injectBridge("<html><body>x</body></html>", "A")).toBe("<html><script>A</script><body>x</body></html>");
    expect(injectBridge("<p>x</p>", "A")).toBe("<script>A</script><p>x</p>");
  });

  it("escapes a closing script tag inside the script, case-insensitively", () => {
    const out = injectBridge("<head></head>", 'const s = "a</script>b</SCRIPT>c";');
    expect(out).toContain('<script>const s = "a<\\/script>b<\\/script>c";</script>');
    expect(out).not.toContain("</SCRIPT>");
  });
});

describe("entryFile", () => {
  it("prefers index.html", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "index.html"), "a");
    writeFileSync(join(dir, "newer.html"), "b");
    expect(entryFile(dir)).toBe("index.html");
  });

  it("falls back to the newest html or htm file", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "old.html"), "a");
    writeFileSync(join(dir, "new.htm"), "b");
    utimesSync(join(dir, "old.html"), new Date(1000), new Date(1000));
    utimesSync(join(dir, "new.htm"), new Date(2000), new Date(2000));
    expect(entryFile(dir)).toBe("new.htm");
  });

  it("never opens the app's own dot files (a kit preview), which the page list and design:history don't know", () => {
    const dir = tempDir();
    writeFileSync(join(dir, ".preview-part.html"), "preview");
    expect(entryFile(dir)).toBeNull();
    writeFileSync(join(dir, "login.html"), "page");
    utimesSync(join(dir, "login.html"), new Date(1000), new Date(1000));
    expect(entryFile(dir)).toBe("login.html");
  });

  it("is null for an empty or missing folder", () => {
    expect(entryFile(tempDir())).toBeNull();
    expect(entryFile(join(tempDir(), "missing"))).toBeNull();
  });
});

describe("serveDesign", () => {
  it("404s a thread that is not a design", () => {
    const { deps } = setup();
    expect(serveDesign(designUrl("other", "index.html"), deps()).status).toBe(404);
  });

  it("serves an asset with the design headers", async () => {
    const { deps } = setup();
    const res = serveDesign(designUrl("t", "style.css"), deps());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/css; charset=utf-8");
    expect(res.headers.get("Content-Security-Policy")).toBe(designCsp());
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await res.text()).toBe("body{color:red}");
  });

  it("injects the bridge into html right after <head>", async () => {
    const { deps } = setup();
    const res = serveDesign(designUrl("t", "index.html"), deps({ bridge: "window.__b=1;" }));
    const text = await res.text();
    // Tagged with the page text's fingerprint, so the canvas can patch it in place later.
    expect(text).toMatch(/^<html><head><script data-source="[a-z0-9]+-[a-z0-9]+">window\.__b=1;<\/script><title>x<\/title>/);
  });

  it("injects the bridge at the very start when there is no head or html", async () => {
    const { deps } = setup();
    const res = serveDesign(designUrl("t", "bare.html"), deps({ bridge: "X" }));
    expect(await res.text()).toBe(`<script data-source="${textHash("<p>bare</p>")}">X</script><p>bare</p>`);
  });

  it("404s a file that does not exist", () => {
    const { deps } = setup();
    expect(serveDesign(designUrl("t", "nope.css"), deps()).status).toBe(404);
  });

  it.skipIf(process.platform === "win32")("404s a symlink inside the design folder that points outside", () => {
    const { base, root, deps } = setup();
    const outside = join(base, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
    expect(serveDesign(designUrl("t", "link.txt"), deps()).status).toBe(404);
  });

  it("404s a crafted URL into a sibling folder", () => {
    const { base, deps } = setup();
    writeFileSync(join(base, "designs", "secret.txt"), "secret");
    const url = "cubiq-design://d/t/../secret.txt";
    expect(parseDesignUrl(url)).toBeNull();
    expect(serveDesign(url, deps()).status).toBe(404);
    expect(serveDesign("cubiq-design://d/t/%2Fetc%2Fpasswd", deps()).status).toBe(404);
  });

  it("serves a saved version with the bridge injected", async () => {
    const { deps } = setup();
    const readVersion = vi.fn((id: string, rel: string, version: number) =>
      id === "t" && rel === "index.html" && version === 2 ? Buffer.from("<html><head></head><body>v2</body></html>") : null,
    );
    const res = serveDesign(designUrl("t", "index.html", 2), deps({ readVersion }));
    expect(res.status).toBe(200);
    expect(readVersion).toHaveBeenCalledWith("t", "index.html", 2);
    const text = await res.text();
    expect(text.startsWith("<html><head><script data-source=")).toBe(true);
    expect(text).toContain("v2");
  });

  it("serves a version of a file whose folder is gone when the path is safe", async () => {
    const { deps } = setup();
    const readVersion = vi.fn(() => Buffer.from("<html><head></head><body>old</body></html>"));
    const res = serveDesign(designUrl("t", "missing/gone.html", 3), deps({ readVersion }));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("old");
  });

  it("404s a version the store does not have", () => {
    const { deps } = setup();
    expect(serveDesign(designUrl("t", "index.html", 9), deps()).status).toBe(404);
  });

  it("404s a git-style version path that escapes", () => {
    const { deps } = setup();
    // Built by hand: designUrl never emits `..`, and parse rejects it.
    expect(serveDesign("cubiq-design://d/t/missing/../../../secret.html?v=1", deps()).status).toBe(404);
  });
});
