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

  it("keeps every sidebar-footer control, each a titled button", () => {
    const html = renderToStaticMarkup(<PaneRail />);
    const buttons = html.match(/<button[^>]*>/g) ?? [];
    expect(buttons.length).toBe(5);
    for (const b of buttons) expect(b).toMatch(/title="[^"]+"/);
    for (const title of ["Show sidebar", "New thread", "Add Project", "Library", "Settings"]) expect(html).toContain(title);
  });
});