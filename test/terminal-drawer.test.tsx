import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TerminalDrawerView } from "../src/renderer/src/components/TerminalDrawer";

const view = (open: boolean, current: string) =>
  renderToStaticMarkup(
    <TerminalDrawerView
      open={open}
      height={240}
      terminals={["p1"]}
      current={current}
      renderPanel={(id) => <span className="stub">{id}</span>}
      onResize={() => {}}
      onClose={() => {}}
    />,
  );

describe("TerminalDrawerView", () => {
  it("keeps the terminal mounted behind the hidden attribute while closed", () => {
    const html = view(false, "p1");
    expect(html).toMatch(/<section[^>]*id="terminal-drawer"[^>]*hidden/);
    expect(html).toMatch(/<div class="terminal-body" hidden=""[^>]*>.*<span class="stub">p1<\/span>/);
  });

  it("shows the current terminal with the drawer's height when open", () => {
    const html = view(true, "p1");
    expect(html).not.toMatch(/<section[^>]*id="terminal-drawer"[^>]*hidden/);
    expect(html).toContain("height:240px");
    expect(html).toMatch(/<div class="terminal-body">.*<span class="stub">p1<\/span>/);
  });

  it("carries a horizontal separator that controls the drawer", () => {
    const html = view(true, "p1");
    expect(html).toContain('role="separator"');
    expect(html).toContain('aria-orientation="horizontal"');
    expect(html).toContain('aria-controls="terminal-drawer"');
  });
});