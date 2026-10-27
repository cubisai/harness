import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InspectorPanel } from "../src/renderer/src/design/InspectorPanel";
import { LiveBar, escapeStep, isPickKey, steerMessage, type LiveBarProps } from "../src/renderer/src/design/LiveBar";

const noop = () => {};
const props = (over: Partial<LiveBarProps> = {}): LiveBarProps => ({
  onPage: true,
  pickWhy: null,
  picking: false,
  textEdit: true,
  onPick: noop,
  systemOpen: false,
  onSystem: noop,
  onSteer: async () => true,
  busy: false,
  comparing: null,
  onCompare: noop,
  board: false,
  onPresent: noop,
  ...over,
});
const bar = (over: Partial<LiveBarProps> = {}) => renderToStaticMarkup(<LiveBar {...props(over)} />);
const key = (k: string, over: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; target: unknown }> = {}) => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  target: null as EventTarget | null,
  ...over,
}) as Parameters<typeof isPickKey>[0];

describe("live bar", () => {
  it("is the one tool set: Pick, DESIGN.md, Steer, Present; no Select, Text, Comment or Draw tools", () => {
    const html = bar();
    expect(html.match(/>Pick</g)).toHaveLength(1);
    expect(html).toContain('aria-keyshortcuts="V"');
    expect(html).toContain('aria-label="DESIGN.md"');
    expect(html).toContain(">Steer<");
    expect(html).toContain('aria-label="Present"');
    for (const gone of ['aria-label="Select"', 'aria-label="Edit text"', 'aria-label="Comment"', 'aria-label="Draw on the design"', "Attach"]) expect(html).not.toContain(gone);
  });

  it("shows Compare only when there are options, pressed while comparing", () => {
    expect(bar()).not.toContain("Compare options");
    expect(bar({ comparing: false })).toContain('aria-label="Compare options" aria-pressed="false"');
    expect(bar({ comparing: true })).toContain('aria-label="Compare options" aria-pressed="true"');
  });

  it("turns Pick off away from a live page and says why", () => {
    const html = bar({ onPage: false, pickWhy: "Open a page to pick an element", picking: true });
    expect(html).toMatch(/aria-pressed="false"[^>]*title="Open a page to pick an element" disabled=""/);
  });

  it("marks Pick and DESIGN.md pressed when they're on", () => {
    expect(bar({ picking: true })).toContain('class="design-live-pick active" aria-pressed="true"');
    expect(bar({ systemOpen: true })).toContain('aria-pressed="true" aria-label="DESIGN.md"');
  });

  it("disables Steer when there's nothing to steer, and Present without a page", () => {
    expect(bar({ onSteer: null })).toMatch(/title="Nothing to steer yet" disabled=""/);
    expect(bar({ onPresent: null })).toMatch(/aria-label="Present"[^>]*disabled=""/);
  });
});

describe("escapeStep", () => {
  it("clears the selection first, then stops picking, and does nothing when not picking", () => {
    expect(escapeStep(true, true)).toBe("clear-selection");
    expect(escapeStep(false, true)).toBe("stop-picking");
    expect(escapeStep(true, false)).toBeNull();
  });
});

describe("isPickKey", () => {
  it("takes a bare V and leaves shortcuts and typing alone", () => {
    expect(isPickKey(key("v"))).toBe(true);
    expect(isPickKey(key("V"))).toBe(true);
    expect(isPickKey(key("b"))).toBe(false);
    expect(isPickKey(key("v", { metaKey: true }))).toBe(false);
    expect(isPickKey(key("v", { ctrlKey: true }))).toBe(false);
    expect(isPickKey(key("v", { altKey: true }))).toBe(false);
    expect(isPickKey(key("v", { target: { tagName: "INPUT" } }))).toBe(false);
    expect(isPickKey(key("v", { target: { tagName: "TEXTAREA" } }))).toBe(false);
    expect(isPickKey(key("v", { target: { tagName: "DIV", isContentEditable: true } }))).toBe(false);
    expect(isPickKey(key("v", { target: { tagName: "BUTTON", closest: (s: string) => (s.includes("dialog") ? {} : null) } }))).toBe(false);
    expect(isPickKey(key("v", { target: { tagName: "BUTTON", closest: () => null } }))).toBe(true);
  });
});

describe("steerMessage", () => {
  it("scopes the words to the whole page, or the whole design on the board", () => {
    expect(steerMessage("  warmer palette ", { page: "designs/d1/index.html" })).toBe("warmer palette\n\n(This is about the whole page designs/d1/index.html, not one element.)");
    expect(steerMessage("more contrast", { design: "designs/d1" })).toBe("more contrast\n\n(This is about the whole design in designs/d1.)");
    expect(steerMessage("   ", { page: "x" })).toBe("");
  });
});

describe("inspector tab from the canvas", () => {
  const panel = (tab?: "system" | "properties") =>
    renderToStaticMarkup(
      <InspectorPanel
        threadId="t"
        tab={tab}
        onTab={noop}
        element={null}
        pageRel="index.html"
        designDir="designs/t"
        reloadKey="0"
        onPreview={noop}
        onClearPreview={noop}
        onApply={noop}
        writes={false}
        elements={null}
        tweaks={null}
      />,
    );
  it("opens on the tab the canvas asks for (DESIGN.md = System) and asks to pick when nothing is", () => {
    expect(panel("system")).toContain('aria-selected="true" class="on">System<');
    expect(panel("properties")).toContain("Pick an element on the canvas to inspect it.");
    expect(panel()).toContain('aria-selected="true" class="on">Properties<');
  });
});

// The canvas is too stateful to render here, so its wiring is pinned in the source.
describe("design canvas wiring", () => {
  const src = readFileSync(join(__dirname, "..", "src", "renderer", "src", "design", "DesignCanvas.tsx"), "utf-8");
  it("has one pick path and an Inspector that doesn't turn picking on", () => {
    expect(src).not.toContain("chooseTool");
    expect(src).not.toContain("IconTarget");
    expect(src).not.toContain("DrawOverlay");
    expect(src).toContain("onClick={() => setInspectorOpen(!inspectorOpen)}");
    // Besides togglePick, only a reload (re-arm) and a tier switch (edit on or off) send pick-on to the frame.
    expect(src.match(/type: "pick", on: true/g)).toHaveLength(2);
    expect(src.match(/<LiveBar\b/g)).toHaveLength(1);
  });
});
