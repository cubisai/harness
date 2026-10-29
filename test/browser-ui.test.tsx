import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BrowserLogEntry, ScreenshotInfo } from "../src/shared/types";
import { ConsoleList } from "../src/renderer/src/components/BrowserPanel";
import { ScreenshotStrip } from "../src/renderer/src/components/ScreenshotStrip";

const shot: ScreenshotInfo = { path: "/x/browser-1.png", url: "unskilled-shot://browser-1.png" };

describe("ScreenshotStrip", () => {
  it("renders one lazily-loaded img per shot, from its unskilled-shot url", () => {
    const html = renderToStaticMarkup(<ScreenshotStrip shots={[shot]} onOpen={() => {}} />);
    expect(html.match(/<img/g)).toHaveLength(1);
    expect(html).toContain('src="unskilled-shot://browser-1.png"');
  });

  it("renders nothing when there are no shots", () => {
    expect(renderToStaticMarkup(<ScreenshotStrip shots={[]} onOpen={() => {}} />)).toBe("");
  });
});

describe("ConsoleList", () => {
  it("shows the console line's text", () => {
    const logs: BrowserLogEntry[] = [{ level: "error", text: "console.error: smoke-console-check" }];
    expect(renderToStaticMarkup(<ConsoleList logs={logs} />)).toContain("smoke-console-check");
  });
});
