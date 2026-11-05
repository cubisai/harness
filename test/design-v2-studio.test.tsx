import { describe, expect, it } from "vitest";
import { codeFileOrder } from "../src/renderer/src/design/CodeView";
import { drawMessage, strokeBounds, toolForKey } from "../src/renderer/src/design/CanvasTools";
import { flowChanges, flowOf, gapSteps, groupParts, instanceOf, jsxOf, lineOf, parseKitParts, startAttrs, swapNotice, swapPlan, wrapAttrs, wrapShapes, type KitPart } from "../src/renderer/src/design/kit-parts";
import { placeBadge } from "../src/renderer/src/design/SelectionChrome";
import { layerName } from "../src/renderer/src/design/layers";
import { elementLabel } from "../src/shared/selection";
import { STUDIO_VIEWS, menuStep, viewportMenu } from "../src/renderer/src/design/StudioBar";
import { lastTurnError, replyCount, statusText } from "../src/renderer/src/components/StudioComposer";
import { selectionPlaceholder } from "../src/renderer/src/components/Composer";

const part = (over: Partial<KitPart> & { ui: string }): KitPart => ({ name: over.ui, category: "Inputs", kind: "component", props: [], snippet: `<div data-ui="${over.ui}"></div>`, importName: null, ...over });
const button = part({ ui: "button", name: "Button", props: [{ name: "variant", type: "choice", options: ["text", "outlined"] }, { name: "size", type: "choice", options: ["sm", "md"] }], snippet: `<div data-ui="stack"><button data-ui="button">One</button><button data-ui="button" data-variant="outlined">Two</button></div>`, importName: "Button" });
const chip = part({ ui: "chip", name: "Chip", props: [{ name: "size", type: "choice", options: ["sm"] }], snippet: `<button data-ui="chip" data-size="sm">Tag</button>` });
const select = part({ ui: "select", name: "Dropdown", props: [{ name: "size", type: "choice", options: ["sm"] }], snippet: `<label data-ui="select"><span data-part="label">Pick</span><select><option>A</option></select></label>` });
const card = part({ ui: "card", name: "Card", category: "Surfaces", props: [{ name: "elevation", type: "choice", options: ["1"] }] });
const box = part({ ui: "box", name: "Box", category: "Layout" });
const stack = part({ ui: "stack", name: "Stack", category: "Layout", props: [{ name: "gap", type: "choice", options: ["md", "none", "xl", "xs"] }] });
const grid = part({ ui: "grid", name: "Grid", category: "Layout", props: [{ name: "columns", type: "choice", options: ["1", "2", "3", "4", "6", "auto"] }] });

describe("the kit's parts", () => {
  it("reads a manifest, and treats anything else as a flat style with no parts", () => {
    const parts = parseKitParts(JSON.stringify({ components: [{ ui: "button", name: "Button", snippet: "<button data-ui=button></button>", category: "Inputs", import: { package: "x", name: "Btn" } }, { name: "no ui" }] }));
    expect(parts.map((p) => [p.ui, p.importName])).toEqual([["button", "Btn"]]);
    expect(parseKitParts("not json")).toEqual([]);
    expect(parseKitParts(null)).toEqual([]);
  });
  it("takes one instance out of a demo snippet, not the whole demo", () => {
    expect(instanceOf(button)).toBe(`<button data-ui="button">One</button>`);
  });
  it("groups by category, filters by search, and hides whole-page blocks until searched for", () => {
    const block = part({ ui: "pricing", name: "Pricing", category: "Blocks", kind: "composition" });
    expect(groupParts([button, card, block], "").map((g) => g.category)).toEqual(["Inputs", "Surfaces"]);
    expect(groupParts([button, card, block], "pric")[0]?.parts[0]?.ui).toBe("pricing");
    expect(groupParts([button, chip], "", "button")[0]?.parts.map((p) => p.ui)).toEqual(["chip"]);
  });
});

describe("Swap", () => {
  it("keeps the element's own source when the shape allows, and warns about what's dropped", () => {
    const plan = swapPlan(`<button data-ui="button" data-variant="outlined" data-size="sm" data-agent-id="a1">Go</button>`, "Go", button, chip);
    expect(plan.kind).toBe("attrs");
    expect(plan.dropped).toEqual(["variant"]);
    if (plan.kind !== "attrs") return;
    expect(plan.changes).toContainEqual({ name: "data-ui", value: "chip" });
    expect(plan.changes).toContainEqual({ name: "data-variant", value: null });
    expect(plan.changes.find((c) => c.name === "data-size")).toBeUndefined();
    expect(plan.changes.find((c) => c.name === "data-agent-id")).toBeUndefined();
  });
  it("a container keeps its children", () => {
    const plan = swapPlan(`<div data-ui="card" data-elevation="1"><p>Kept</p></div>`, "Kept", card, box);
    expect(plan.kind).toBe("attrs");
    expect(plan.dropped).toEqual(["elevation"]);
  });
  it("a different shape is replaced, carrying the text and the props both take", () => {
    const plan = swapPlan(`<button data-ui="button" data-size="sm">Choose plan</button>`, "Choose plan", button, select);
    expect(plan.kind).toBe("replace");
    if (plan.kind !== "replace") return;
    const made = startAttrs(plan.html);
    expect(made["data-ui"]).toBe("select");
    expect(made["data-size"]).toBe("sm");
    expect(plan.html).toContain("Choose plan");
  });
  it("says what happened", () => {
    expect(swapNotice("Button", select, [])).toBe("Swapped Button for Dropdown. Undo with ⌘Z.");
    expect(swapNotice("Button", select, ["variant"])).toContain("Dropped variant, which Dropdown doesn't take");
  });
});

describe("Wrap", () => {
  it("offers Stack and Grid always, and the others only when the kit has them", () => {
    expect(wrapShapes([])).toEqual(["stack", "grid"]);
    expect(wrapShapes([box, stack, grid])).toEqual(["stack", "grid", "box"]);
  });
  it("uses the kit's parts, matching the count to the kit's columns", () => {
    expect(wrapAttrs("stack", 2, [stack])["data-ui"]).toBe("stack");
    expect(wrapAttrs("grid", 4, [grid])).toMatchObject({ "data-ui": "grid", "data-columns": "4" });
    expect(wrapAttrs("grid", 5, [grid])["data-columns"]).toBe("6");
    expect(wrapAttrs("grid", 9, [grid])["data-columns"]).toBe("auto");
  });
  it("on a flat style writes plain layout, with no kit attribute", () => {
    expect(wrapAttrs("grid", 3, []).style).toContain("repeat(3,");
    expect(wrapAttrs("stack", 3, []).style).toContain("display:flex");
    expect(wrapAttrs("stack", 3, [])["data-ui"]).toBeUndefined();
  });
});

describe("the Layout card", () => {
  it("names the flow from the component", () => {
    expect(flowOf({ "data-ui": "stack" })).toBe("column");
    expect(flowOf({ "data-ui": "stack", "data-direction": "row" })).toBe("row");
    expect(flowOf({ "data-ui": "grid" })).toBe("grid");
    expect(flowOf({ "data-ui": "button" })).toBeNull();
    expect(flowOf({})).toBeNull();
  });
  it("sorts the kit's gap names from small to large", () => {
    expect(gapSteps(stack)).toEqual(["none", "xs", "md", "xl"]);
    expect(gapSteps(null)).toEqual([]);
  });
  it("changes the component, leaves the gap alone, and restores what a flow last had", () => {
    const attrs = { "data-ui": "stack", "data-direction": "row", "data-gap": "md", "data-align": "center" };
    const toGrid = flowChanges(attrs, "grid");
    expect(toGrid).toContainEqual({ name: "data-ui", value: "grid" });
    expect(toGrid).toContainEqual({ name: "data-direction", value: null });
    expect(toGrid).toContainEqual({ name: "data-align", value: null });
    expect(toGrid).toContainEqual({ name: "data-columns", value: "2" });
    expect(toGrid.find((c) => c.name === "data-gap")).toBeUndefined();
    const back = flowChanges({ "data-ui": "grid", "data-columns": "3", "data-gap": "md" }, "row", { "data-align": "center" });
    expect(back).toContainEqual({ name: "data-align", value: "center" });
    expect(back).toContainEqual({ name: "data-columns", value: null });
    expect(flowChanges({ "data-ui": "grid", "data-columns": "2" }, "grid")).toEqual([]);
  });
  it("finds the element's line by id or start tag", () => {
    const source = `<html>\n<body>\n<div data-agent-id="x" data-ui="grid">\n<p>A</p></div>`;
    expect(lineOf(source, "x", "")).toBe(3);
    expect(lineOf(source, undefined, "<p>A</p>")).toBe(4);
    expect(lineOf(source, "nope", "")).toBeNull();
  });
});

describe("JSX", () => {
  it("is only offered when the kit links the part to a real import", () => {
    expect(jsxOf(button, { "data-variant": "outlined" }, "Go")).toBe(`<Button variant="outlined">Go</Button>`);
    expect(jsxOf(chip, {}, "Tag")).toBeNull();
    expect(jsxOf(null, {}, "")).toBeNull();
  });
});

describe("the top bar and its menus", () => {
  it("has the four views in order", () => {
    expect(STUDIO_VIEWS.map((v) => v.label)).toEqual(["Design", "Preview", "Code", "System"]);
  });
  it("arrow keys wrap around a menu", () => {
    expect(menuStep(0, 3, "ArrowUp")).toBe(2);
    expect(menuStep(2, 3, "ArrowDown")).toBe(0);
    expect(menuStep(1, 3, "End")).toBe(2);
    expect(menuStep(1, 3, "a")).toBeNull();
    expect(menuStep(0, 0, "ArrowDown")).toBeNull();
  });
  it("the viewport menu offers board and zoom only when they apply", () => {
    const base = { viewport: "desktop" as const, zoom: "fit" as const, device: false, deviceOk: true, board: { can: false, on: false, onToggle: () => {} }, flow: null, onViewport: () => {}, onZoom: () => {}, onDevice: () => {} };
    const ids = (o: Parameters<typeof viewportMenu>[0]) => viewportMenu(o).map((i) => i.id);
    expect(ids(base)).toContain("tablet");
    expect(ids(base)).not.toContain("board");
    expect(ids(base)).toContain("z-fit");
    expect(ids({ ...base, viewport: "fit" })).not.toContain("z-fit");
    expect(ids({ ...base, board: { ...base.board, can: true } })).toContain("board");
  });
  it("the code picker lists the page, tokens and components first, and only ones that exist", () => {
    expect(codeFileOrder(["about.html", "index.html", "system/ui.css", "system/tokens.css"], "index.html")).toEqual(["index.html", "system/tokens.css", "system/ui.css", "about.html"]);
    expect(codeFileOrder(["index.html"], "index.html")).toEqual(["index.html"]);
  });
});

describe("the Composer in the studio", () => {
  it("one running line, with whichever parts are known", () => {
    expect(statusText("Designing hero", "", { done: 2, total: 3 })).toBe("Designing hero · 2/3 · Esc to stop");
    expect(statusText(null, "Reading the brief", null)).toBe("Reading the brief · Esc to stop");
    expect(statusText(null, "", null)).toBe("Working… · Esc to stop");
  });
  it("counts the agent's own replies, not a subagent's", () => {
    expect(replyCount([{ event: { kind: "assistant-text" } }, { event: { kind: "assistant-text", parentId: "p" } }, { event: { kind: "tool" } }])).toBe(1);
    expect(replyCount(undefined)).toBe(0);
  });
  it("says what's selected in the prompt", () => {
    const el = { tag: "button", selector: "button", text: "Start", html: "", rect: { x: 0, y: 0, width: 1, height: 1 }, path: [] };
    expect(selectionPlaceholder([el])).toContain("Ask AI to refine");
    expect(selectionPlaceholder([el, el])).toBe("Ask AI about these 2 elements…");
  });
});

describe("the canvas tools", () => {
  it("V, D and C pick a tool only with no modifier", () => {
    expect(toolForKey({ key: "d", metaKey: false, ctrlKey: false, altKey: false })).toBe("draw");
    expect(toolForKey({ key: "C", metaKey: false, ctrlKey: false, altKey: false })).toBe("comment");
    expect(toolForKey({ key: "d", metaKey: true, ctrlKey: false, altKey: false })).toBeNull();
    expect(toolForKey({ key: "x", metaKey: false, ctrlKey: false, altKey: false })).toBeNull();
  });
  it("finds the box around the strokes", () => {
    expect(strokeBounds([])).toBeNull();
    expect(strokeBounds([[{ x: 10, y: 20 }, { x: 30, y: 5 }]], 2)).toEqual({ x: 8, y: 3, width: 24, height: 19 });
  });
  it("says what a drawing is about", () => {
    expect(drawMessage(" too loud ", "Card")).toContain("around Card");
    expect(drawMessage(" too loud ", null)).toContain("too loud");
    expect(drawMessage("", null)).toContain("Work out what the marks");
  });
  it("the badge stays in view when the element reaches the top", () => {
    const view = { x: 0, y: 0, width: 500, height: 400 };
    expect(placeBadge({ x: 10, y: 100, width: 50, height: 20 }, view)).toEqual({ left: 10, top: 80 });
    expect(placeBadge({ x: 10, y: 5, width: 50, height: 20 }, view).top).toBe(5);
    expect(placeBadge({ x: 480, y: 100, width: 50, height: 20 }, view).left).toBe(440);
    // Under the tools it moves beside them; lower down it doesn't.
    const tools = { right: 108, bottom: 46 };
    expect(placeBadge({ x: 10, y: 5, width: 50, height: 20 }, view, 20, tools).left).toBe(112);
    expect(placeBadge({ x: 10, y: 100, width: 50, height: 20 }, view, 20, tools).left).toBe(10);
  });
});

describe("names in the studio", () => {
  const node = { tag: "div", cls: "", selector: "div", label: "", depth: 0 };
  it("a layer reads as its kit part, and never as an id the editor stamped", () => {
    expect(layerName({ ...node, ui: "app-bar", id: "el-eb5e0243" })).toBe("App bar");
    expect(layerName({ ...node, id: "el-eb5e0243" })).toBe("Group");
    expect(layerName({ ...node, id: "hero_1" })).toBe("Hero 1");
    // Its own text still wins: a button reads as what it says.
    expect(layerName({ ...node, ui: "button", label: "Start free trial" })).toBe("Start free trial");
  });
  it("a label prefers the source's text to what CSS shows", () => {
    expect(elementLabel({ tag: "button", text: "START FREE TRIAL", ownText: "Start free trial" })).toBe('button "Start free trial"');
    expect(elementLabel({ tag: "section", text: "Two words" })).toBe('section "Two words"');
  });
});

describe("a failed turn with the chat closed", () => {
  it("says why on the Composer's lip, until a new turn starts", () => {
    const failed = { event: { kind: "error", message: "Free usage limit reached." } };
    expect(lastTurnError([{ event: { kind: "turn-start" } }, failed, { event: { kind: "turn-end" } }])).toBe("Free usage limit reached.");
    expect(lastTurnError([failed, { event: { kind: "turn-start" } }])).toBeNull();
    expect(lastTurnError([{ event: { kind: "turn-start" } }, { event: { kind: "assistant-text" } }, { event: { kind: "turn-end" } }])).toBeNull();
    expect(lastTurnError(undefined)).toBeNull();
  });
});
