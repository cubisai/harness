import { describe, expect, it } from "vitest";
import {
  MAX_TWEAKS,
  TWEAKS_ID,
  TWEAK_UNITS,
  changedTweaks,
  currentTweakValues,
  defaultValue,
  parseTweaks,
  tweakTarget,
  tweakValue,
  type Tweak,
} from "../src/shared/tweaks";
import { findManifest, keepTweaks, readTweaks } from "../src/main/design/tweaks";

const choice = (): Extract<Tweak, { type: "choice" }> => ({ id: "theme", label: "Theme", type: "choice", options: ["light", "dusk"], default: "light" });
const toggle = (): Extract<Tweak, { type: "toggle" }> => ({ id: "badges", label: "Badges", type: "toggle", default: true });
const color = (): Extract<Tweak, { type: "color" }> => ({ id: "accent", label: "Accent", type: "color", var: "--color-accent", default: "#3b5bdb" });
const range = (): Extract<Tweak, { type: "range" }> => ({ id: "radius", label: "Radius", type: "range", var: "--radius-md", min: 0, max: 24, step: 4, unit: "px", default: 8 });

describe("parseTweaks", () => {
  it("keeps a valid tweak of every type", () => {
    const json = JSON.stringify({
      tweaks: [
        { id: "theme", label: "Theme", type: "choice", options: ["light", "dusk"], default: "dusk" },
        { id: "badges", label: "Badges", type: "toggle", default: true },
        { id: "accent", label: "Accent", type: "color", var: "--color-accent", default: "#3B5BDB" },
        { id: "radius", label: "Radius", type: "range", var: "--radius-md", min: 0, max: 24, step: 4, unit: "px", default: 8 },
      ],
    });
    expect(parseTweaks(json)).toEqual([
      { id: "theme", label: "Theme", type: "choice", options: ["light", "dusk"], default: "dusk" },
      { id: "badges", label: "Badges", type: "toggle", default: true },
      { id: "accent", label: "Accent", type: "color", var: "--color-accent", default: "#3b5bdb" },
      { id: "radius", label: "Radius", type: "range", var: "--radius-md", min: 0, max: 24, step: 4, unit: "px", default: 8 },
    ]);
  });

  it("accepts a bare array and ignores bad JSON or non-lists", () => {
    expect(parseTweaks('[{"id":"theme","type":"toggle"}]')).toEqual([{ id: "theme", label: "theme", type: "toggle", default: false }]);
    expect(parseTweaks("{ not json")).toEqual([]);
    expect(parseTweaks("42")).toEqual([]);
    expect(parseTweaks('{"tweaks":"nope"}')).toEqual([]);
  });

  it("skips invalid ids, duplicates, options, vars and ranges", () => {
    const json = JSON.stringify([
      { id: "Bad", type: "toggle" },
      { id: "1abc", type: "toggle" },
      { id: "ok", type: "toggle" },
      { id: "ok", type: "toggle", default: true },
      { id: "one", type: "choice", options: ["only"] },
      { id: "badvar", type: "color", var: "color" },
      { id: "badrange", type: "range", var: "--x", min: 5, max: 5 },
      { id: "backwards", type: "range", var: "--x", min: 10, max: 0 },
      { id: "other", type: "slider" },
    ]);
    expect(parseTweaks(json)).toEqual([{ id: "ok", label: "ok", type: "toggle", default: false }]);
  });

  it("falls back to the id for a missing, empty or over-long label", () => {
    const json = JSON.stringify([
      { id: "a", type: "toggle" },
      { id: "b", label: "   ", type: "toggle" },
      { id: "c", label: 12, type: "toggle" },
      { id: "d", label: "x".repeat(41), type: "toggle" },
      { id: "e", label: "  Kept  ", type: "toggle" },
    ]);
    expect(parseTweaks(json).map((t) => t.label)).toEqual(["a", "b", "c", "d", "Kept"]);
  });

  it("falls back to sensible defaults", () => {
    expect(parseTweaks('[{"id":"c","type":"choice","options":["a","b"],"default":"z"}]')[0]).toMatchObject({ default: "a" });
    expect(parseTweaks('[{"id":"t","type":"toggle","default":"yes"}]')[0]).toMatchObject({ default: false });
    expect(parseTweaks('[{"id":"k","type":"color","var":"--x","default":"red"}]')[0]).toMatchObject({ default: "#000000" });
    expect(parseTweaks('[{"id":"r","type":"range","var":"--x","min":2,"max":10,"default":99}]')[0]).toMatchObject({ step: 1, unit: "", default: 10 });
    expect(parseTweaks('[{"id":"r","type":"range","var":"--x","min":2,"max":10,"default":-5,"unit":"xx"}]')[0]).toMatchObject({ default: 2, unit: "" });
  });

  it("caps the list at MAX_TWEAKS and the options at 8", () => {
    const many = Array.from({ length: 13 }, (_, i) => ({ id: `t${i}`, type: "choice", options: ["a", "b"] }));
    expect(parseTweaks(JSON.stringify(many))).toHaveLength(MAX_TWEAKS);
    expect(parseTweaks(JSON.stringify(many))).toHaveLength(12);
    const opts = Array.from({ length: 10 }, (_, i) => `o${i}`);
    const kept = parseTweaks(JSON.stringify([{ id: "c", type: "choice", options: opts }]))[0] as Extract<Tweak, { type: "choice" }>;
    expect(kept.options).toEqual(opts.slice(0, 8));
  });

  it("uses the documented constants", () => {
    expect(TWEAKS_ID).toBe("cubiq-tweaks");
    expect(TWEAK_UNITS).toContain("px");
  });
});

describe("tweakValue", () => {
  it("accepts only known choice options", () => {
    expect(tweakValue(choice(), "dusk")).toBe("dusk");
    expect(tweakValue(choice(), "nope")).toBeNull();
    expect(tweakValue(choice(), 5)).toBeNull();
  });

  it("normalizes toggles from booleans and on/off strings", () => {
    expect(tweakValue(toggle(), true)).toBe("on");
    expect(tweakValue(toggle(), "off")).toBe("off");
    expect(tweakValue(toggle(), "x")).toBeNull();
  });

  it("normalizes colours to lowercase hex", () => {
    expect(tweakValue(color(), "#3B5BDB")).toBe("#3b5bdb");
    expect(tweakValue(color(), "rgb(59, 91, 219)")).toBe("#3b5bdb");
    expect(tweakValue(color(), "rgb(59 91 219)")).toBe("#3b5bdb");
    expect(tweakValue(color(), "red")).toBeNull();
  });

  it("clamps and snaps ranges", () => {
    expect(tweakValue(range(), "13px")).toBe("12");
    expect(tweakValue(range(), 30)).toBe("24");
    expect(tweakValue(range(), 5)).toBe("4");
    expect(tweakValue(range(), -3)).toBe("0");
    expect(tweakValue(range(), "nope")).toBeNull();
  });
});

describe("defaultValue and tweakTarget", () => {
  it("renders each type's default as its carried string", () => {
    expect(defaultValue(choice())).toBe("light");
    expect(defaultValue(toggle())).toBe("on");
    expect(defaultValue(color())).toBe("#3b5bdb");
    expect(defaultValue(range())).toBe("8");
  });

  it("points choice/toggle at data- attrs and color/range at CSS variables", () => {
    expect(tweakTarget(choice(), "dusk")).toEqual({ attr: "data-theme", value: "dusk" });
    expect(tweakTarget(toggle(), "off")).toEqual({ attr: "data-badges", value: "off" });
    expect(tweakTarget(color(), "#112233")).toEqual({ var: "--color-accent", value: "#112233" });
    expect(tweakTarget(range(), "12")).toEqual({ var: "--radius-md", value: "12px" });
  });
});

describe("currentTweakValues", () => {
  it("reads the page's attributes and variables, falling back to defaults", () => {
    const tweaks = [choice(), toggle(), color(), range()];
    expect(currentTweakValues(tweaks, { "data-theme": "dusk", "data-badges": "off" }, { "--color-accent": "#FFFFFF", "--radius-md": "16px" })).toEqual({
      theme: "dusk",
      badges: "off",
      accent: "#ffffff",
      radius: "16",
    });
    expect(currentTweakValues(tweaks, {}, {})).toEqual({ theme: "light", badges: "on", accent: "#3b5bdb", radius: "8" });
  });
});

const PAGE = [
  "<!doctype html>",
  '<html lang="en" data-theme="light">',
  "<head>",
  '<meta charset="utf-8">',
  '<script type="application/json" id="cubiq-tweaks">{"tweaks":[',
  '  {"id":"theme","label":"Theme","type":"choice","options":["light","dusk"],"default":"light"},',
  '  {"id":"badges","label":"Badges","type":"toggle","default":true},',
  '  {"id":"accent","label":"Accent","type":"color","var":"--color-accent","default":"#3b5bdb"}',
  "]}</script>",
  "</head>",
  "<body>",
  '<p id="keep-me">x</p>',
  "</body>",
  "</html>",
  "",
].join("\n");

describe("keepTweaks", () => {
  it("finds the manifest and reads its tweaks", () => {
    const found = findManifest(PAGE);
    expect(found).not.toBeNull();
    expect(found?.json).toContain('"id":"theme"');
    expect(readTweaks(PAGE)).toHaveLength(3);
    expect(readTweaks("<p>no manifest</p>")).toEqual([]);
  });

  it("writes the chosen values into the manifest defaults", () => {
    const out = keepTweaks(PAGE, { theme: "dusk", badges: "off", accent: "#112233" });
    const [theme, badges, accent] = readTweaks(out);
    expect(theme).toMatchObject({ id: "theme", default: "dusk" });
    expect(badges).toMatchObject({ id: "badges", default: false });
    expect(accent).toMatchObject({ id: "accent", default: "#112233" });
  });

  it("replaces an existing data- attr and inserts a missing one", () => {
    const out = keepTweaks(PAGE, { theme: "dusk", badges: "off", accent: "#112233" });
    expect(out).toContain('<html lang="en" data-theme="dusk" data-badges="off">');
  });

  it("inserts one vars block before </head> and replaces it on the next keep", () => {
    const once = keepTweaks(PAGE, { accent: "#112233" });
    expect(once).toContain('<style id="cubiq-tweak-vars">html:root{--color-accent:#112233}</style>');
    expect(once.indexOf('<style id="cubiq-tweak-vars">')).toBeLessThan(once.indexOf("</head>"));
    const twice = keepTweaks(once, { accent: "#445566" });
    expect(twice).toContain("html:root{--color-accent:#445566}");
    expect(twice).not.toContain("#112233");
    expect(twice.split('id="cubiq-tweak-vars"')).toHaveLength(2);
  });

  it("is idempotent", () => {
    const values = { theme: "dusk", badges: "off", accent: "#112233" };
    const once = keepTweaks(PAGE, values);
    expect(keepTweaks(once, values)).toBe(once);
  });

  it("throws when the page declares no tweaks", () => {
    expect(() => keepTweaks("<p>no manifest</p>", {})).toThrow("This page declares no tweaks.");
  });

  it("still updates the manifest with no <html> tag", () => {
    const bare = '<head><script type="application/json" id="cubiq-tweaks">{"tweaks":[{"id":"theme","type":"choice","options":["light","dusk"],"default":"light"}]}</script></head>';
    const out = keepTweaks(bare, { theme: "dusk" });
    expect(readTweaks(out)[0]).toMatchObject({ id: "theme", default: "dusk" });
  });

  it("changes nothing else in the document", () => {
    const out = keepTweaks(PAGE, { theme: "dusk", badges: "off", accent: "#112233" });
    expect(out).toContain('<p id="keep-me">x</p>');
    const body = (h: string): string => h.slice(h.indexOf("<body>"), h.indexOf("</body>") + 7);
    expect(body(out)).toBe(body(PAGE));
  });

  it("escapes < in the manifest so a label cannot close the script", () => {
    const html = `<!doctype html><html><head><script type="application/json" id="cubiq-tweaks">{"tweaks":[{"id":"theme","label":"\\u003c/script\\u003e","type":"choice","options":["light","dusk"],"default":"light"}]}</script></head><body></body></html>`;
    const out = keepTweaks(html, { theme: "dusk" });
    expect(out).toContain("\\u003c/script>");
    expect(out.split("</script>")).toHaveLength(2);
  });
});

describe("changedTweaks", () => {
  it("keeps only overrides that differ from the page's values", () => {
    expect(changedTweaks({ theme: "light", accent: "#3b5bdb" }, { theme: "light", accent: "#112233", ghost: "x" })).toEqual({ accent: "#112233" });
    expect(changedTweaks({ theme: "light" }, {})).toEqual({});
  });

  it("never pins a value the page set on itself after load (Keep after changing only the accent)", () => {
    // At load the page had flipped itself to dusk for a moment; the panel's base caught that.
    const base = currentTweakValues(readTweaks(PAGE), { "data-theme": "dusk", "data-badges": "on" }, { "--color-accent": "#3b5bdb" });
    const out = keepTweaks(PAGE, changedTweaks(base, { ...base, accent: "#112233" }));
    const [theme, , accent] = readTweaks(out);
    expect(theme).toMatchObject({ id: "theme", default: "light" });
    expect(accent).toMatchObject({ id: "accent", default: "#112233" });
    expect(out).toContain('data-theme="light"');
    expect(out).not.toContain(`data-theme="dusk"`);
  });
});
