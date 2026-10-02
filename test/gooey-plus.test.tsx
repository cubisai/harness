import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GooeyPlus, gooeyDelays, gooeyOffset } from "../src/renderer/src/components/GooeyPlus";

const items = ["mention", "skill", "command"].map((id) => ({ id, label: `Do ${id}`, icon: <span>{id[0]}</span>, onSelect: () => {} }));

describe("GooeyPlus", () => {
  it("renders a closed + with hidden, unfocusable items and a goo filter", () => {
    const html = renderToStaticMarkup(<GooeyPlus items={items} />);
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('role="menu"');
    expect(html).toContain('aria-hidden="true"');
    expect(html.match(/role="menuitem"/g)).toHaveLength(3);
    expect(html.match(/tabindex="-1"/g)).toHaveLength(3);
    expect(html).toContain("feGaussianBlur");
    expect(html).toContain('aria-label="Do skill"');
  });

  it("lays the items out in a row to the right of the +", () => {
    expect([0, 1, 2].map(gooeyOffset)).toEqual([
      { x: 34, y: 0 },
      { x: 68, y: 0 },
      { x: 102, y: 0 },
    ]);
  });

  it("staggers outward on open with icons after their blob, inward on close", () => {
    expect(gooeyDelays(0, 3, true)).toEqual({ blob: "0ms, 0ms", item: "0ms, 220ms" });
    expect(gooeyDelays(2, 3, true)).toEqual({ blob: "80ms, 0ms", item: "80ms, 300ms" });
    expect(gooeyDelays(2, 3, false)).toEqual({ blob: "0ms, 200ms", item: "0ms, 0ms" });
    expect(gooeyDelays(0, 3, false)).toEqual({ blob: "80ms, 280ms", item: "80ms, 0ms" });
  });
});
