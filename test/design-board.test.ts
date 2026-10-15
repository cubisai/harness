import { describe, expect, it } from "vitest";
import { BOARD_HEADER, BOARD_LABEL_ROOM, BOARD_SIZES, BOARD_TITLE_BAND, boardLayout, boardSections, clampZoom, fitBoard, fitView, parsePage, zoomAt } from "../src/renderer/src/design/board-layout";

const pair = (rel: string) => ({ rel, url: `cubiq-design://d/t1/${rel}` });

describe("design board parsing", () => {
  it("treats a plain file as a page with no section prefix", () => {
    expect(parsePage("index.html", "cubiq-design://d/t1/index.html")).toEqual({
      rel: "index.html",
      url: "cubiq-design://d/t1/index.html",
      section: "Pages",
      label: "Index",
      step: null,
      kind: "desktop",
      variant: false,
    });
  });

  it("reads a section prefix, a numbered step and the kind from the name", () => {
    expect(parsePage("mobile-flow--01-create.html", "u")).toEqual({
      rel: "mobile-flow--01-create.html",
      url: "u",
      section: "Mobile flow",
      label: "1 Create",
      step: 1,
      kind: "mobile",
      variant: false,
    });
  });

  it("keeps a non-numbered section page's label in title case", () => {
    expect(parsePage("desktop--studio.html", "u")).toMatchObject({ section: "Desktop", label: "Studio", step: null, kind: "desktop" });
  });

  it("turns a variant into an option, always in the Options section", () => {
    expect(parsePage("variant-dense-hero.html", "u")).toMatchObject({ section: "Options", label: "Option Dense hero", variant: true, step: null });
  });

  it("names the artboard kind from slide/tablet words too", () => {
    expect(parsePage("deck--title.html", "u").kind).toBe("slide");
    expect(parsePage("ipad-home.html", "u").kind).toBe("tablet");
  });
});

describe("design board sections", () => {
  it("keeps first-seen order, sorts steps first and puts Options last", () => {
    const sections = boardSections([
      pair("index.html"),
      pair("mobile-flow--02-confirm.html"),
      pair("variant-a.html"),
      pair("mobile-flow--01-create.html"),
      pair("pricing.html"),
    ]);
    expect(sections.map((s) => s.title)).toEqual(["Pages", "Mobile flow", "Options"]);
    expect(sections[0]!.pages.map((p) => p.label)).toEqual(["Index", "Pricing"]);
    expect(sections[1]!.pages.map((p) => p.label)).toEqual(["1 Create", "2 Confirm"]);
    expect(sections[2]!.pages.map((p) => p.label)).toEqual(["Option A"]);
  });
});

describe("design board layout", () => {
  it("lays two sections left to right with the section gap between them", () => {
    const sections = boardSections([pair("mobile-flow--01-create.html"), pair("desktop--studio.html")]);
    const layout = boardLayout(sections, 48, 120);
    const [first, second] = layout.sections;
    expect(first!.y).toBe(0);
    // Sections stack: the second starts one section gap below the first one's tallest frame.
    expect(second!.x).toBe(0);
    expect(second!.y).toBe(56 + BOARD_HEADER + BOARD_SIZES.mobile.height + 120);
    expect(layout.width).toBe(BOARD_SIZES.desktop.width);
    expect(second!.frames[0]!.width).toBe(BOARD_SIZES.desktop.width);
    expect(second!.frames[0]!.height).toBe(BOARD_SIZES.desktop.height);
  });

  it("leaves a title band and a 28px header above each frame", () => {
    const layout = boardLayout(boardSections([pair("index.html")]));
    expect(layout.sections[0]!.frames[0]!.y).toBe(56 + BOARD_HEADER);
    expect(layout.width).toBe(BOARD_SIZES.desktop.width);
    expect(layout.height).toBe(56 + BOARD_HEADER + BOARD_SIZES.desktop.height);
  });

  it("spaces frames inside a section by the gap", () => {
    const layout = boardLayout(boardSections([pair("mobile--a.html"), pair("mobile--b.html")]), 48, 120);
    const frames = layout.sections[0]!.frames;
    expect(frames[1]!.x).toBe(frames[0]!.x + BOARD_SIZES.mobile.width + 48);
  });
});

describe("design board view maths", () => {
  it("keeps zoom within 5% and 200%", () => {
    expect(clampZoom(0)).toBe(0.05);
    expect(clampZoom(5)).toBe(2);
    expect(clampZoom(1)).toBe(1);
  });

  it("keeps the cursor point fixed while zooming", () => {
    const view = { x: 10, y: 20, zoom: 1 };
    const zoomed = zoomAt(view, 2, 100, 200);
    // The board point under the cursor before (px - x)/zoom must sit under it after.
    expect((100 - view.x) / view.zoom).toBeCloseTo((100 - zoomed.x) / zoomed.zoom);
    expect((200 - view.y) / view.zoom).toBeCloseTo((200 - zoomed.y) / zoomed.zoom);
  });

  it("fits the board centred and never above 100%", () => {
    const layout = { width: 1000, height: 500 };
    const view = fitView(layout, { width: 400, height: 300 }, 48);
    expect(view.zoom).toBeLessThanOrEqual(1);
    expect(view.zoom).toBeCloseTo(Math.min((400 - 96) / 1000, (300 - 96) / 500));
    // Centred: equal margins on each side.
    expect(view.x).toBeCloseTo((400 - layout.width * view.zoom) / 2);
    expect(view.y).toBeCloseTo((300 - layout.height * view.zoom) / 2);
    // A board smaller than the stage is shown at 100%, still centred.
    expect(fitView({ width: 100, height: 100 }, { width: 800, height: 600 }).zoom).toBe(1);
  });

  it("widens the section gap so labels keep their on-screen room at the fitted zoom", () => {
    const sections = boardSections(["index.html", "desktop--studio.html", "mobile-flow--01-a.html", "mobile-flow--02-b.html", "variant-a.html"].map(pair));
    const { sectionGap, view } = fitBoard(sections, { width: 520, height: 800 });
    expect(sectionGap).toBeGreaterThanOrEqual(120);
    expect((sectionGap + BOARD_TITLE_BAND + BOARD_HEADER) * view.zoom).toBeGreaterThanOrEqual(BOARD_LABEL_ROOM * 0.95);
    // A roomy stage keeps the default gap.
    expect(fitBoard(boardSections([pair("index.html")]), { width: 4000, height: 3000 }).sectionGap).toBe(120);
  });
});
