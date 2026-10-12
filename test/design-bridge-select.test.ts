import { describe, expect, it } from "vitest";
import { selectorFor } from "../src/main/browser/picker";
import { bridgeScript, describeElement, editableText, resolveTarget, snapTarget, type SelectionTarget } from "../src/main/design/bridge";

/** A minimal fake element: only the DOM surface the bridge helpers touch. */
interface Fake {
  tagName: string;
  attrs: Record<string, string>;
  text: string;
  html: string;
  rect: { x: number; y: number; width: number; height: number };
  parent: Fake | null;
  interactive: boolean;
}

/** Build a fake element castable to `Element`. */
function make(init: Partial<Fake> & { tag: string }): Fake {
  const el: Fake = {
    tagName: init.tag.toUpperCase(),
    attrs: init.attrs ?? {},
    text: init.text ?? "",
    html: init.html ?? "",
    rect: init.rect ?? { x: 0, y: 0, width: 0, height: 0 },
    parent: init.parent ?? null,
    interactive: init.interactive ?? false,
  };
  const dom = el as unknown as Record<string, unknown>;
  dom.getAttribute = (name: string): string | null => el.attrs[name] ?? null;
  dom.closest = (): Element | null => {
    let cur: Fake | null = el;
    while (cur) {
      if (cur.interactive) return cur as unknown as Element;
      cur = cur.parent;
    }
    return null;
  };
  dom.getBoundingClientRect = () => ({ left: el.rect.x, top: el.rect.y, width: el.rect.width, height: el.rect.height });
  dom.outerHTML = el.html;
  dom.textContent = el.text;
  dom.parentElement = el.parent as unknown as Element | null;
  return el;
}

const asElement = (f: Fake): Element => f as unknown as Element;

/** A selector for tests: a `data-sel` attribute, else the lowercased tag. */
const sel = (el: Element): string => {
  const fake = el as unknown as Fake;
  return fake.attrs["data-sel"] ?? fake.tagName.toLowerCase();
};

/** A fake Document: querySelectorAll by exact data-agent-id, querySelector by a map. */
function fakeDoc(byId: Fake[], bySelector: Record<string, Fake | null> = {}): Document {
  return {
    querySelectorAll: (selector: string): Fake[] => {
      const m = /^\[data-agent-id="(.+)"\]$/.exec(selector);
      if (!m) return [];
      const id = m[1];
      return byId.filter((el) => el.attrs["data-agent-id"] === id);
    },
    querySelector: (selector: string): Fake | null => {
      if (selector === "::invalid") throw new Error("invalid selector");
      return bySelector[selector] ?? null;
    },
  } as unknown as Document;
}

describe("snapTarget", () => {
  it("returns the closest interactive ancestor, else the element itself", () => {
    const button = make({ tag: "button", interactive: true });
    const span = make({ tag: "span", parent: button });
    const plain = make({ tag: "span" });
    expect(snapTarget(asElement(span))).toBe(asElement(button));
    expect(snapTarget(asElement(plain))).toBe(asElement(plain));
  });
});

describe("describeElement", () => {
  it("keeps a valid data-agent-id and drops an invalid one", () => {
    const good = make({ tag: "div", attrs: { "data-agent-id": "hero_1" } });
    expect(describeElement(asElement(good), sel).id).toBe("hero_1");
    const bad = make({ tag: "div", attrs: { "data-agent-id": "Bad Id!" } });
    expect(describeElement(asElement(bad), sel).id).toBeUndefined();
  });

  it("normalizes whitespace and caps text at 300 characters", () => {
    const el = make({ tag: "p", text: "  a\n\n  b\t c  " });
    expect(describeElement(asElement(el), sel).text).toBe("a b c");
    const long = make({ tag: "p", text: "x".repeat(400) });
    expect(describeElement(asElement(long), sel).text).toHaveLength(300);
  });

  it("caps html at 1200 characters", () => {
    const el = make({ tag: "p", html: `<p>${"y".repeat(1500)}</p>` });
    expect(describeElement(asElement(el), sel).html).toHaveLength(1200);
  });

  it("stops the path before BODY", () => {
    const html = make({ tag: "html" });
    const body = make({ tag: "body", parent: html });
    const div = make({ tag: "div", parent: body });
    const el = make({ tag: "span", parent: div });
    expect(describeElement(asElement(el), sel).path.map((p) => p.label)).toEqual(["div"]);
  });

  it("keeps at most 4 ancestors, outermost first, with ids in labels", () => {
    const html = make({ tag: "html" });
    const body = make({ tag: "body", parent: html });
    const section = make({ tag: "section", parent: body });
    const main = make({ tag: "main", parent: section });
    const article = make({ tag: "article", parent: main, attrs: { "data-agent-id": "alpha" } });
    const list = make({ tag: "ul", parent: article });
    const item = make({ tag: "li", parent: list });
    const el = make({ tag: "span", parent: item });
    const out = describeElement(asElement(el), sel);
    expect(out.path.map((p) => p.label)).toEqual(["main", "article alpha", "ul", "li"]);
    expect(out.path.map((p) => p.selector)).toEqual(["main", "article", "ul", "li"]);
  });
});

describe("resolveTarget", () => {
  it("returns the single element matching a valid id", () => {
    const el = make({ tag: "div", attrs: { "data-agent-id": "hero" } });
    const doc = fakeDoc([el]);
    const target: SelectionTarget = { id: "hero", selector: "#nope", tag: "div", text: "" };
    expect(resolveTarget(doc, target)).toBe(asElement(el));
  });

  it("falls back to the selector when the id is duplicated", () => {
    const first = make({ tag: "div", attrs: { "data-agent-id": "dup" } });
    const second = make({ tag: "span", attrs: { "data-agent-id": "dup" } });
    const doc = fakeDoc([first, second], { ".pick": second });
    const target: SelectionTarget = { id: "dup", selector: ".pick", tag: "span", text: "" };
    expect(resolveTarget(doc, target)).toBe(asElement(second));
  });

  it("returns a selector hit whose tag and text prefix match", () => {
    const el = make({ tag: "div", text: "hello world" });
    const doc = fakeDoc([], { ".pick": el });
    expect(resolveTarget(doc, { selector: ".pick", tag: "div", text: "hello" })).toBe(asElement(el));
  });

  it("rejects a tag mismatch and a text mismatch", () => {
    const el = make({ tag: "button", text: "hello world" });
    const doc = fakeDoc([], { ".pick": el });
    expect(resolveTarget(doc, { selector: ".pick", tag: "div", text: "hello" })).toBeNull();
    expect(resolveTarget(doc, { selector: ".pick", tag: "button", text: "bye" })).toBeNull();
  });

  it("returns null when the selector throws and when nothing matches", () => {
    const doc = fakeDoc([], {});
    expect(resolveTarget(doc, { selector: "::invalid", tag: "div", text: "" })).toBeNull();
    expect(resolveTarget(doc, { selector: ".none", tag: "div", text: "" })).toBeNull();
  });
});

describe("editableText", () => {
  const node = (init: Partial<Fake> & { tag: string }, children: unknown[] = []): Element => {
    const el = make(init);
    (el as unknown as { children: unknown[] }).children = children;
    return asElement(el);
  };

  it("returns the id and text of a leaf element", () => {
    expect(editableText(node({ tag: "p", attrs: { "data-agent-id": "hero" }, text: "Hello" }))).toEqual({ ok: true, id: "hero", text: "Hello" });
  });

  it("refuses a missing id, an invalid id, and an element with children", () => {
    expect(editableText(node({ tag: "p", text: "Hello" }))).toEqual({ ok: false, reason: "That text has no stable id; ask the agent to change it." });
    expect(editableText(node({ tag: "p", attrs: { "data-agent-id": "Bad Id!" }, text: "Hello" }))).toEqual({ ok: false, reason: "That text has no stable id; ask the agent to change it." });
    expect(editableText(node({ tag: "p", attrs: { "data-agent-id": "hero" }, text: "Hello" }, [{}]))).toEqual({ ok: false, reason: "That element holds more than text; ask the agent to change it." });
  });
});

describe("bridgeScript", () => {
  it("serializes with the page-side helpers to a parseable script body", () => {
    expect(() => new Function(bridgeScript(selectorFor))).not.toThrow();
  });
});
