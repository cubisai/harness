import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { selectorFor } from "../src/main/browser/picker";
import { bridgeScript } from "../src/main/design/bridge";
import { collectSlop } from "../src/main/design/lint";
import { ACTIONS, VariantCycler, cycleStep } from "../src/renderer/src/design/ElementBar";
import { readBridgeMessage } from "../src/renderer/src/design/frame";

const noop = () => {};
const RESOURCES = join(__dirname, "..", "resources");

describe("cycleStep", () => {
  it("wraps through 1…count with ← and →, and ignores other keys", () => {
    expect(cycleStep(1, 3, "ArrowRight")).toBe(2);
    expect(cycleStep(3, 3, "ArrowRight")).toBe(1);
    expect(cycleStep(1, 3, "ArrowLeft")).toBe(3);
    // The original (0) showing counts as variant 1 for stepping.
    expect(cycleStep(0, 3, "ArrowRight")).toBe(2);
    expect(cycleStep(2, 3, "Enter")).toBeNull();
    expect(cycleStep(1, 0, "ArrowRight")).toBeNull();
  });
});

describe("VariantCycler", () => {
  const render = (over: Partial<Parameters<typeof VariantCycler>[0]> = {}) =>
    renderToStaticMarkup(
      <VariantCycler shown={2} count={3} malformed={null} place={{ left: 0, top: 0 }} onSize={noop} onShow={noop} onAccept={noop} onDiscard={noop} busy={false} {...over} />,
    );
  it("shows ‹ n / count ›, × and Accept", () => {
    const html = render();
    expect(html).toContain('aria-label="Previous variant"');
    expect(html).toContain(">2 / 3<");
    expect(html).toContain('aria-label="Next variant"');
    expect(html).toContain('aria-label="Discard the variants"');
    expect(html).toContain("Accept");
  });
  it("offers only the way back for a malformed set, and turns off while a choice is on its way", () => {
    const bad = render({ malformed: "variant 2 must hold exactly one element" });
    expect(bad).toContain("Variants came back malformed: variant 2 must hold exactly one element.");
    expect(bad).toContain('aria-label="Discard the variants"');
    expect(bad).not.toContain("Accept");
    expect(bad).not.toContain("Next variant");
    expect(render({ busy: true }).match(/disabled=""/g)?.length).toBe(4);
  });
});

describe("variant bridge messages", () => {
  it("accepts a sets report and a box, and rejects bad names and counts", () => {
    const sets = { source: "cubiq-design", type: "variants", sets: [{ set: "hero", count: 3, shown: 1, malformed: null }] };
    expect(readBridgeMessage(sets)).toEqual({ type: "variants", sets: sets.sets });
    expect(readBridgeMessage({ ...sets, sets: [{ set: "Hero", count: 3, shown: 1, malformed: null }] })).toBeNull();
    expect(readBridgeMessage({ ...sets, sets: [{ set: "hero", count: 3.5, shown: 1, malformed: null }] })).toBeNull();
    expect(readBridgeMessage({ ...sets, sets: [{ set: "hero", count: 3, shown: 1, malformed: "" }] })).toBeNull();
    expect(readBridgeMessage({ source: "cubiq-design", type: "variant-rect", set: "hero", rect: { x: 1, y: 2, width: 3, height: 4 } })).toEqual({
      type: "variant-rect",
      set: "hero",
      rect: { x: 1, y: 2, width: 3, height: 4 },
    });
    expect(readBridgeMessage({ source: "cubiq-design", type: "variant-rect", set: "hero", rect: null })).toEqual({ type: "variant-rect", set: "hero", rect: null });
  });

  it("ships the variant handling in the page script, and the lint skips hidden variants", () => {
    const script = bridgeScript(selectorFor);
    expect(script).toContain("cubiq-variant-style");
    expect(script).toContain("show-variant");
    expect(collectSlop.toString()).toContain("[data-cubiq-variant][hidden]");
  });
});

describe("variant skill and action notes", () => {
  it("ship a design-mode skill with the wrapper contract", () => {
    const skill = readFileSync(join(RESOURCES, "skills", "design-variants", "SKILL.md"), "utf8");
    expect(skill).toMatch(/^---\nname: design-variants\n/);
    expect(skill).toContain("mode: design");
    for (const marker of ['data-cubiq-variants="SET"', 'data-cubiq-variant="SET-0" hidden', '@scope ([data-cubiq-variant="SET-1"])']) expect(skill).toContain(marker);
  });

  it("have one short note per action except Freeform", () => {
    for (const a of ACTIONS) {
      const file = join(RESOURCES, "design-actions", `${a.id}.md`);
      if (a.id === "freeform") {
        expect(existsSync(file)).toBe(false);
        continue;
      }
      const text = readFileSync(file, "utf8").trim();
      expect(text.startsWith(`Action: ${a.label}.`)).toBe(true);
      // Token-sized: well under 200 tokens each.
      expect(text.split(/\s+/).length).toBeLessThanOrEqual(110);
    }
  });

  it("are packaged with the app", () => {
    expect(readFileSync(join(__dirname, "..", "electron-builder.yml"), "utf8")).toContain("from: resources/design-actions");
  });
});
