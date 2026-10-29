import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CollapsedHeaderControls, PaneRail, SidebarToggle } from "../src/renderer/src/components/PaneRail";

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
  it("is the sidebar", () => {
    const html = renderToStaticMarkup(<PaneRail />);
    expect(html).toContain('id="sidebar"');
  });

  it("keeps every sidebar-footer control, each a titled button", () => {
    const html = renderToStaticMarkup(<PaneRail />);
    const buttons = html.match(/<button[^>]*>/g) ?? [];
    expect(buttons.length).toBe(5);
    for (const b of buttons) expect(b).toMatch(/title="[^"]+"/);
    for (const title of ["switch to Design", "Add Project", "Message Center", "Library", "Settings"]) expect(html).toContain(title);
  });
});

describe("CollapsedHeaderControls", () => {
  it("puts the sidebar toggle and New thread in the title bar, the toggle pointing at the rail", () => {
    const html = renderToStaticMarkup(<CollapsedHeaderControls />);
    expect(html).toContain('aria-controls="sidebar"');
    expect(html).toContain("Show sidebar");
    expect(html).toContain("New thread");
  });
});
