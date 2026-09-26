import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PaneRail, SidebarToggle } from "../src/renderer/src/components/PaneRail";

describe("SidebarToggle", () => {
  it("reports a collapsed sidebar as not expanded", () => {
    const html = renderToStaticMarkup(<SidebarToggle collapsed />);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="sidebar"');
  });

  it("reports an open sidebar as expanded", () => {
    const html = renderToStaticMarkup(<SidebarToggle collapsed={false} />);
    expect(html).toContain('aria-expanded="true"');
  });
});

describe("PaneRail", () => {
  it("is the sidebar, with a toggle that points at it", () => {
    const html = renderToStaticMarkup(<PaneRail />);
    expect(html).toContain('id="sidebar"');
    expect(html).toContain('aria-controls="sidebar"');
  });
});