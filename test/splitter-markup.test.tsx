import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Splitter } from "../src/renderer/src/components/Splitter";

const base = { orientation: "vertical" as const, controls: "inspector", label: "Resize side panel", value: 460, min: 320, max: 720, defaultValue: 460, onChange: () => {}, onCommit: () => {} };

describe("Splitter markup", () => {
  it("carries the separator role and its ARIA value", () => {
    const html = renderToStaticMarkup(<Splitter {...base} collapsed={false} />);
    expect(html).toContain('role="separator"');
    expect(html).toContain('aria-orientation="vertical"');
    expect(html).toContain('aria-controls="inspector"');
    expect(html).toContain('aria-valuenow="460"');
    expect(html).toContain('aria-valuemin="320"');
    expect(html).toContain('aria-valuemax="720"');
    expect(html).toContain('tabindex="0"');
  });

  it("announces 0 while collapsed", () => {
    const html = renderToStaticMarkup(<Splitter {...base} collapsed={true} />);
    expect(html).toContain('aria-valuenow="0"');
  });
});