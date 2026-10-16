import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InspectorPanel, sizeModeOf } from "../src/renderer/src/design/InspectorPanel";
import type { SelectedElement } from "../src/shared/selection";

const el: SelectedElement = {
  id: "hero",
  selector: "#hero",
  tag: "section",
  text: "Hi",
  html: "<section>Hi</section>",
  rect: { x: 0, y: 0, width: 320, height: 200 },
  path: [],
  style: { width: "320px", height: "200px" },
};

const render = (props: { element?: SelectedElement | null; writes?: boolean; tweaks?: string | null }) =>
  renderToStaticMarkup(
    <InspectorPanel
      threadId="t"
      element={props.element === undefined ? el : props.element}
      pageRel="index.html"
      designDir="designs/x"
      reloadKey="0"
      onPreview={() => {}}
      onClearPreview={() => {}}
      onApply={() => {}}
      writes={props.writes ?? true}
      elements={<p>tree</p>}
      tweaks={props.tweaks === undefined ? null : props.tweaks}
    />,
  );

describe("sizeModeOf", () => {
  it("reads Hug, Fill and Fixed", () => {
    expect(sizeModeOf("fit-content")).toBe("hug");
    expect(sizeModeOf("max-content")).toBe("hug");
    expect(sizeModeOf(" 100% ")).toBe("fill");
    expect(sizeModeOf("320px")).toBe("fixed");
    expect(sizeModeOf("")).toBe("fixed");
  });
});

describe("InspectorPanel", () => {
  it("shows Properties, Elements and Code tabs, and Tweaks only when the page has tweaks", () => {
    const plain = render({});
    expect(plain).toContain(">Properties<");
    expect(plain).toContain(">Elements<");
    expect(plain).toContain(">Code<");
    expect(plain).not.toContain(">Tweaks<");
    expect(render({ tweaks: "x" })).toContain(">Tweaks<");
  });

  it("offers Hug | Fill | Fixed for width and height, with Fixed on for a measured length", () => {
    const html = render({});
    expect(html).toContain('aria-label="Width sizing"');
    expect(html).toContain('aria-label="Height sizing"');
    expect(html).toMatch(/aria-pressed="true" class="on">Fixed</);
  });

  it("says whether Apply writes into the page or drafts a message", () => {
    expect(render({ writes: true })).toContain("Writes into the page");
    expect(render({ writes: false })).toContain("Drafts a message");
    expect(render({ writes: false, element: { ...el, id: undefined } })).toContain("No data-agent-id: drafts a message");
  });
});
