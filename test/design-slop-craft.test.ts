import { describe, expect, it } from "vitest";
import { collectCraftSlop, craftSlopFindings, type CraftControl, type CraftSnapshot } from "../src/main/design/slop-craft";

const control = (over: Partial<CraftControl>): CraftControl => ({ selector: ".b", label: "Save changes", group: "form", strong: false, iconOnly: false, named: false, ...over });
const snap = (over: Partial<CraftSnapshot>): CraftSnapshot => ({ controls: [], texts: [], dialogs: [], digits: [], black: { selector: "", count: 0 }, upward: [], layoutMotion: [], slow: [], deltas: [], ...over });
const ids = (s: CraftSnapshot): string[] => craftSlopFindings(s).map((f) => f.id!);

describe("craftSlopFindings", () => {
  it("is quiet on a page that follows the rules", () => {
    const s = snap({
      controls: [control({ label: "Create account", strong: true }), control({ label: "Cancel" }), control({ label: "", iconOnly: true, named: true })],
      texts: [{ selector: "h1", kind: "heading", text: "October 2026", level: 1 }, { selector: "button", kind: "button", text: "Create account", level: 0 }],
      dialogs: [{ selector: "dialog", text: "Delete 'Q4 report'? This can't be undone. Delete file Cancel", actions: ["Delete file", "Cancel"] }],
      deltas: [{ selector: ".d", text: "+12% vs last month" }],
      black: { selector: "p", count: 2 },
    });
    expect(craftSlopFindings(s)).toEqual([]);
  });

  it("asks for a verb and an object instead of Submit, OK or Click here", () => {
    const f = craftSlopFindings(snap({ controls: [control({ label: "Submit" }), control({ label: "OK" }), control({ label: "Send invite" })] }));
    expect(f.map((x) => x.id)).toEqual(["vague-action"]);
    expect(f[0]!.detail).toContain('2 buttons labelled "Submit", "OK"');
  });

  it("flags two strong fills in one group, not one per group", () => {
    expect(ids(snap({ controls: [control({ strong: true, group: "a" }), control({ strong: true, group: "b" })] }))).toEqual([]);
    expect(ids(snap({ controls: [control({ strong: true, label: "Save" }), control({ strong: true, label: "Cancel" })] }))).toEqual(["primary-crowd"]);
  });

  it("flags an 'Are you sure?' confirm and a destructive OK, not a named one", () => {
    expect(ids(snap({ dialogs: [{ selector: "d", text: "Are you sure? OK Cancel", actions: ["OK", "Cancel"] }] }))).toEqual(["vague-confirm"]);
    expect(ids(snap({ dialogs: [{ selector: "d", text: "This will delete the file. Yes No", actions: ["Yes", "No"] }] }))).toEqual(["vague-confirm"]);
    expect(ids(snap({ dialogs: [{ selector: "d", text: "Rename the board", actions: ["Rename", "Cancel"] }] }))).toEqual([]);
  });

  it("wants a name on icon-only buttons", () => {
    expect(ids(snap({ controls: [control({ label: "", iconOnly: true })] }))).toEqual(["unlabelled-icon-button"]);
  });

  it("flags shouting, greeting headlines and periods on short labels", () => {
    const s = snap({
      texts: [
        { selector: "h1", kind: "heading", text: "Welcome back, Sam!", level: 1 },
        { selector: "b", kind: "button", text: "Add money!!", level: 0 },
        { selector: "h2", kind: "heading", text: "Your week.", level: 2 },
        { selector: "l", kind: "label", text: "Acme Inc.", level: 0 },
      ],
    });
    expect(ids(s).sort()).toEqual(["greeting-headline", "label-period", "shout-copy"]);
  });

  it("flags long digit runs, pure black text, upward shadows, layout motion, slow feedback and bare deltas", () => {
    const s = snap({
      digits: [{ selector: "p", text: "4829175036182947" }],
      black: { selector: "p", count: 5 },
      upward: [{ selector: ".card", value: "rgba(0, 0, 0, 0.2) 0px -4px 12px 0px" }],
      layoutMotion: [{ selector: ".panel", what: "transition width" }],
      slow: [{ selector: "button", ms: 800 }],
      deltas: [{ selector: ".d", text: "+12%" }],
    });
    expect(ids(s)).toEqual(["long-digits", "pure-black-text", "upward-shadow", "layout-animation", "slow-feedback", "delta-no-baseline"]);
  });

  it("findings function is self-contained", () => {
    const copy = new Function(`return (${craftSlopFindings.toString()})`)() as typeof craftSlopFindings;
    const s = snap({ controls: [control({ label: "Submit" })], black: { selector: "p", count: 4 } });
    expect(copy(s)).toEqual(craftSlopFindings(s));
  });

  it("collector is a serializable page function", () => {
    expect(() => new Function(`return (${collectCraftSlop.toString()})`)()).not.toThrow();
    expect(collectCraftSlop.toString()).toContain("getComputedStyle");
  });
});
