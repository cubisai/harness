import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "../src/renderer/src/markdown";
import { validateUi, validateUiDetailed } from "../src/shared/genui/validate";
import * as rendererValidate from "../src/renderer/src/genui/validate";
import { UI_ACTION_MAX, UI_TEXT_MAX } from "../src/shared/genui/types";

const render = (text: string): string => renderToStaticMarkup(<Markdown text={text} />).replace(/<!-- -->/g, "").replace(/&#x27;/g, "'").replace(/&quot;/g, '"');
const fence = (name: string, body: unknown): string => `\`\`\`ui:${name}\n${typeof body === "string" ? body : JSON.stringify(body)}\n\`\`\``;
const reason = (name: string, body: unknown): string => {
  const v = validateUiDetailed(name, typeof body === "string" ? body : JSON.stringify(body));
  if (v.spec) throw new Error("expected a refusal");
  return v.reason;
};
const notes = (name: string, body: unknown): string[] => {
  const v = validateUiDetailed(name, typeof body === "string" ? body : JSON.stringify(body));
  if (!v.spec) throw new Error(`expected a block, got: ${v.reason}`);
  return v.notes;
};

describe("GU1: shared GenUI schema", () => {
  it("the renderer path re-exports the shared validator", () => {
    expect(rendererValidate.validateUi).toBe(validateUi);
  });

  it("names why a block is refused", () => {
    expect(reason("gauge", "{}")).toBe("there's no ui:gauge block");
    expect(reason("form", "{ not json")).toBe("the JSON doesn't parse");
    expect(reason("form", { fields: [{ id: "a" }, { id: "a" }] })).toBe('field id "a" is used twice');
    expect(reason("form", { fields: [{ label: "x" }, { label: "y" }, { id: "3x" }] })).toBe("field 1 has no usable id");
    expect(reason("choices", { options: ["a", "b", "c", "d", "e", "f", "g"] })).toBe("7 options, max 6");
    expect(reason("choices", { options: ["a", "x".repeat(UI_ACTION_MAX + 1)] })).toBe(`option 2 is ${UI_ACTION_MAX + 1} characters, max ${UI_ACTION_MAX}`);
    expect(reason("chart", { kind: "pie", series: [{ label: "a", value: 1 }] })).toBe('kind "pie" isn\'t supported (only "bars")');
    expect(reason("stat", { stats: [] })).toBe("stats is empty");
    expect(reason("checklist", "# Only a title")).toBe("it has no rows");
    expect(reason("form", { fields: [{ id: "c", type: "select", options: ["x", "x"] }] })).toBe('select "c" needs 2 different options');
  });

  it("lists the repairs made to a block it draws, and none for a clean one", () => {
    expect(notes("checklist", { items: [{ text: "ok" }] })).toEqual([]);
    expect(notes("checklist", { items: [{ text: "x".repeat(UI_TEXT_MAX + 5) }, { text: "y".repeat(UI_TEXT_MAX + 1) }] })).toEqual([`2 texts clipped to ${UI_TEXT_MAX} characters`]);
    expect(notes("compare", { headers: ["A", "B"], rows: [["1"], ["2", "3", "4", "5"]], best: [[9, 1]] })).toEqual(["1 short row padded", "2 extra cells dropped", "1 invalid hint ignored"]);
    expect(notes("choices", { options: ["Yes", "No", "Yes"] })).toEqual(["1 repeated option merged"]);
  });

  it("validates exactly as before: the verdict's spec is validateUi's", () => {
    const body = JSON.stringify({ headers: ["A", "B"], rows: [["1"], ["2", "3", "4"]], highlight: 7 });
    expect(validateUiDetailed("compare", body).spec).toEqual(validateUi("compare", body));
    expect(validateUi("compare", body)).toEqual({ name: "compare", headers: ["A", "B"], rows: [["1", ""], ["2", "3"]] });
  });

  it("a nested run doesn't leak its reason into the outer one", () => {
    // Two runs back to back keep their own verdicts.
    expect(reason("form", { fields: [] })).toBe("fields is empty");
    expect(reason("stat", { stats: [{ label: "a" }] })).toBe("stat 1 has no value");
  });

  it("shows why a fence fell back to code, above the code", () => {
    const html = render(fence("choices", { options: ["a", "b", "c", "d", "e", "f", "g"] }));
    expect(html).toContain('<div class="ui-fallback-note">Couldn\'t draw ui:choices: 7 options, max 6</div>');
    expect(html.indexOf("ui-fallback-note")).toBeLessThan(html.indexOf("<pre"));
    expect(html).not.toContain('class="ui-block"');
  });

  it("keeps repair notes off screen on a drawn block", () => {
    const html = render(fence("choices", "Yes\nNo\nYes"));
    expect(html).toContain('data-ui-notes="1 repeated option merged"');
    expect(html).not.toContain("ui-fallback-note");
    expect(render(fence("choices", "Yes\nNo"))).not.toContain("data-ui-notes");
  });
});
