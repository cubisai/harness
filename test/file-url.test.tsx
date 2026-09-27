import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { fileUrlRef } from "../src/renderer/src/fileref";
import { Markdown } from "../src/renderer/src/markdown";

describe("fileUrlRef", () => {
  it("reads Windows and POSIX file URLs, with an optional line anchor", () => {
    expect(fileUrlRef("file:///D:/Cubebis%20Work/ai-agent/harness/package.json#L2")).toEqual({ path: "D:/Cubebis Work/ai-agent/harness/package.json", line: 2 });
    expect(fileUrlRef("file:///home/me/app/src/a.ts")).toEqual({ path: "/home/me/app/src/a.ts" });
    expect(fileUrlRef("file:///home/me/a.ts#L7C3")).toEqual({ path: "/home/me/a.ts", line: 7, column: 3 });
  });

  it("rejects anything else", () => {
    expect(fileUrlRef("https://example.com/a.ts")).toBeNull();
    expect(fileUrlRef("file:///")).toBeNull();
    expect(fileUrlRef("file:///bad%zz")).toBeNull();
  });
});

describe("file links in replies", () => {
  it("become open-in-editor buttons, never file:// anchors", () => {
    const html = renderToStaticMarkup(<Markdown text="See [package.json](file:///D:/x/package.json#L2) and [site](https://x.dev)." onFile={() => {}} />);
    expect(html).toContain('class="file-link"');
    expect(html).toContain("<code>package.json</code>");
    expect(html).not.toContain('href="file:');
    expect(html).toContain('href="https://x.dev"');
  });

  it("show just the label without a file handler", () => {
    const html = renderToStaticMarkup(<Markdown text="[package.json](file:///D:/x/package.json)" />);
    expect(html).toContain("<code>package.json</code>");
    expect(html).not.toContain("file:///");
  });
});
