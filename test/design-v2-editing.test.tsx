import { patchDocument } from "../src/main/design/patch";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { selectorFor } from "../src/main/browser/picker";
import { bridgeScript, clickTarget, componentOf, drillTarget, isSelectableElement, parentComponent, textHolder } from "../src/main/design/bridge";
import { DesignDocuments } from "../src/main/design/documents";
import { documentIdOf } from "../src/main/design/mutation";
import { applyChange } from "../src/main/design/source-edit";
import { CustomizePanel, attrOf } from "../src/renderer/src/design/CustomizePanel";
import { DesignDocumentClient, type DocumentApi } from "../src/renderer/src/design/document-client";
import { BRIDGE_LIMITS, createBridgeGate, frameLayout, readBridgeMessage, viewportForDevice } from "../src/renderer/src/design/frame";
import { conflictsText } from "../src/renderer/src/design/useDesignEditing";
import type { DesignMutation, DocumentStatus } from "../src/shared/design-mutation";
import type { SelectedElement } from "../src/shared/selection";
import { tempDir } from "./helpers";

/** A small DOM, just what the selection rules read. */
interface Node {
  tagName: string;
  attrs: Record<string, string>;
  cls: string[];
  text: string;
  kids: Node[];
  parentElement: Node | null;
  rect: { width: number; height: number; bottom: number; right: number };
  css: Partial<CSSStyleDeclaration>;
  childNodes: { nodeType: number; nodeValue: string | null }[];
}
const COMPONENTS = ["header", "footer", "nav", "main", "section", "aside", "article", "a", "button", "input", "select", "textarea", "label", "summary", "img", "svg"];
function node(tag: string, init: Partial<Pick<Node, "attrs" | "cls" | "text" | "css">> & { rect?: Partial<Node["rect"]> } = {}, kids: Node[] = []): Node {
  const n: Node = {
    tagName: tag.toUpperCase(),
    attrs: init.attrs ?? {},
    cls: init.cls ?? [],
    text: init.text ?? "",
    kids,
    parentElement: null,
    rect: { width: 100, height: 40, bottom: 40, right: 100, ...init.rect },
    css: init.css ?? {},
    childNodes: [],
  };
  n.childNodes = [...(n.text ? [{ nodeType: 3, nodeValue: n.text }] : []), ...kids.map(() => ({ nodeType: 1, nodeValue: null }))];
  for (const kid of kids) kid.parentElement = n;
  const dom = n as unknown as Record<string, unknown>;
  dom.getBoundingClientRect = () => n.rect;
  dom.contains = (other: Node) => {
    for (let cur: Node | null = other; cur; cur = cur.parentElement) if (cur === n) return true;
    return false;
  };
  dom.matches = (sel: string) => n.cls.some((c) => sel.includes(`.${c}`));
  dom.closest = (sel: string) => {
    for (let cur: Node | null = n; cur; cur = cur.parentElement) {
      if (sel === "svg") {
        if (cur.tagName === "SVG") return cur;
        continue;
      }
      if (cur.attrs["data-ui"] || cur.attrs["data-agent-id"] || COMPONENTS.includes(cur.tagName.toLowerCase())) return cur;
    }
    return null;
  };
  dom.querySelectorAll = () => {
    const all: Node[] = [];
    const walk = (p: Node) => p.kids.forEach((k) => (all.push(k), walk(k)));
    walk(n);
    return all;
  };
  return n;
}
const el = (n: Node) => n as unknown as Element;
const style = (n: Element) => (n as unknown as Node).css as CSSStyleDeclaration;

describe("what a click can land on", () => {
  it("skips screen-reader text, skip links and anything too small or off the page", () => {
    expect(isSelectableElement(el(node("a", { cls: ["skip-link"] })), style)).toBe(false);
    expect(isSelectableElement(el(node("span", { cls: ["sr-only"] })), style)).toBe(false);
    expect(isSelectableElement(el(node("div", { rect: { width: 1, height: 1 } })), style)).toBe(false);
    expect(isSelectableElement(el(node("div", { rect: { bottom: 0 } })), style)).toBe(false);
    expect(isSelectableElement(el(node("div")), style)).toBe(true);
  });

  it("skips hidden, transparent and clipped elements, including under a transparent parent", () => {
    expect(isSelectableElement(el(node("div", { css: { visibility: "hidden" } })), style)).toBe(false);
    expect(isSelectableElement(el(node("div", { css: { pointerEvents: "none" } })), style)).toBe(false);
    expect(isSelectableElement(el(node("div", { css: { clipPath: "inset(50%)" } })), style)).toBe(false);
    const child = node("span");
    node("div", { css: { opacity: "0" } }, [child]);
    expect(isSelectableElement(el(child), style)).toBe(false);
  });

  it("takes the component first, not the text inside it", () => {
    const label = node("span", { text: "Save" });
    const button = node("div", { attrs: { "data-ui": "button" } }, [label]);
    node("section", {}, [button]);
    expect(componentOf(el(label))).toBe(button);
    expect(componentOf(el(button))).toBe(button);
  });

  it("falls back to the element on a page with no components", () => {
    const span = node("span");
    node("body", {}, [node("div", {}, [span])]);
    expect(componentOf(el(span))).toBe(span);
  });

  it("drills one level towards the pointer, and not at all from the element itself", () => {
    const leaf = node("p", { text: "x" });
    const inner = node("div", {}, [leaf]);
    const card = node("div", { attrs: { "data-ui": "card" } }, [inner]);
    expect(drillTarget(el(card), el(leaf), () => true)).toBe(inner);
    expect(drillTarget(el(card), el(card), () => true)).toBeNull();
  });

  it("drills past a level that can't be selected", () => {
    const leaf = node("p", { text: "x" });
    const hidden = node("div", {}, [leaf]);
    const card = node("div", {}, [hidden]);
    expect(drillTarget(el(card), el(leaf), (n) => n !== el(hidden))).toBe(leaf);
  });

  it("steps up to the holding component and stops at the page", () => {
    const button = node("button");
    const section = node("section", {}, [button]);
    const body = node("body", {}, [section]);
    node("html", {}, [body]);
    expect(parentComponent(el(button), componentOf)).toBe(section);
    expect(parentComponent(el(section), componentOf)).toBeNull();
  });

  it("finds the text a double-click edits: its own, the only one inside, or none", () => {
    const heading = node("h1", { text: "Hello" });
    expect(textHolder(el(heading))).toBe(heading);
    const label = node("span", { text: "Save" });
    expect(textHolder(el(node("button", {}, [node("i"), label])))).toBe(label);
    expect(textHolder(el(node("div", {}, [node("p", { text: "a" }), node("p", { text: "b" })])))).toBeNull();
    expect(textHolder(el(node("input", { text: "x" })))).toBeNull();
  });

  describe("a click once something is selected", () => {
    const none = () => false;
    const pick = (selected: unknown, hit: unknown, paints: (el: Element) => boolean = none) => clickTarget(selected === null ? null : el(selected as never), el(hit as never), componentOf, paints);
    const tree = () => {
      const accent = node("span", { text: "one screen" });
      const title = node("h1", { text: "Run it from" }, [accent]);
      const save = node("button", { text: "Save", attrs: { "data-ui": "button" } });
      const cancel = node("button", { text: "Cancel", attrs: { "data-ui": "button" } });
      const actions = node("div", {}, [save, cancel]);
      const cellA = node("td", { text: "Van 12" });
      const cellB = node("td", { text: "Van 18" });
      const table = node("table", { attrs: { "data-ui": "table" } }, [cellA, cellB]);
      const paper = node("div", { attrs: { "data-ui": "paper" } }, [table]);
      const hero = node("section", { attrs: { "data-ui": "hero" } }, [title, actions, paper]);
      const other = node("section", { attrs: { "data-ui": "pricing" } }, [node("p", { text: "Plans" })]);
      node("html", {}, [node("body", {}, [hero, other])]);
      return { accent, title, save, cancel, actions, cellA, cellB, table, paper, hero, other };
    };
    it("with nothing selected takes the component", () => {
      const t = tree();
      expect(pick(null, t.title)).toBe(t.hero);
      expect(pick(null, t.save)).toBe(t.save);
    });
    it("goes from parent to child to sub-child", () => {
      const t = tree();
      expect(pick(t.hero, t.save)).toBe(t.save);
      expect(pick(t.hero, t.title)).toBe(t.title);
      expect(pick(t.title, t.accent)).toBe(t.accent);
      expect(pick(t.hero, t.cellA)).toBe(t.table);
      expect(pick(t.table, t.cellA)).toBe(t.cellA);
    });
    it("holds its depth across siblings", () => {
      const t = tree();
      expect(pick(t.save, t.cancel)).toBe(t.cancel);
      expect(pick(t.save, t.title)).toBe(t.title);
      expect(pick(t.cellA, t.cellB)).toBe(t.cellB);
      expect(pick(t.accent, t.title)).toBe(t.title);
    });
    it("keeps the selection on itself and on a bare gap inside it", () => {
      const t = tree();
      expect(pick(t.save, t.save)).toBe(t.save);
      expect(pick(t.title, t.title)).toBe(t.title);
      expect(pick(t.hero, t.actions)).toBe(t.hero);
    });
    it("steps up on the parent's background, and on a gap beside the selection", () => {
      const t = tree();
      expect(pick(t.save, t.hero)).toBe(t.hero);
      expect(pick(t.save, t.actions)).toBe(t.hero);
    });
    it("takes a wrapper you can see", () => {
      const t = tree();
      expect(pick(t.hero, t.actions, (n) => n === el(t.actions))).toBe(t.actions);
    });
    it("leaves for another part of the page", () => {
      const t = tree();
      expect(pick(t.cellA, t.other)).toBe(t.other);
      expect(pick(t.save, t.other)).toBe(t.other);
    });
    it("works on its own, serialized into the page", () => {
      const t = tree();
      const alone = new Function(`return (${String(clickTarget)});`)() as typeof clickTarget;
      expect(alone(el(t.hero), el(t.save), componentOf, none)).toBe(t.save);
    });
  });

  it("has helpers that work on their own, since each is serialized into the page apart from this module", () => {
    const alone = <T,>(fn: T): T => new Function(`return (${String(fn)});`)() as T;
    const button = node("button");
    const section = node("section", {}, [button]);
    node("html", {}, [node("body", {}, [section])]);
    expect(alone(parentComponent)(el(button), alone(componentOf))).toBe(section);
    expect(alone(textHolder)(el(node("h1", { text: "Hi" })))).not.toBeNull();
    expect(alone(isSelectableElement)(el(node("div")), style)).toBe(true);
    expect(alone(drillTarget)(el(section), el(button), () => true)).toBe(button);
  });

  it("still serializes into a script that parses", () => {
    expect(() => new Function(bridgeScript(selectorFor))).not.toThrow();
    expect(bridgeScript(selectorFor)).toContain("isSelectableElement");
  });

  it("serializes the in-place patch on its own, with nothing from outside it", () => {
    const alone = new Function(`return (${String(patchDocument)});`)() as typeof patchDocument;
    expect(typeof alone).toBe("function");
    expect(bridgeScript(selectorFor)).toContain("patchDocument");
    // A file missing its parts gives up, so the canvas reloads.
    const empty = { documentElement: null, head: null, body: null } as unknown as Document;
    expect(alone(empty, empty, empty, () => false)).toEqual({ ok: false, reason: "parse" });
  });
});

describe("1440 stage", () => {
  it("scales the true desktop width to the spec's example and never reflows", () => {
    const at960 = frameLayout("desktop", "fit", { width: 960, height: 700 }, false, true);
    expect(at960.width).toBe(1440);
    expect(at960.scale).toBeCloseTo((960 - 48) / 1440, 5);
    expect(frameLayout("desktop", "fit", { width: 600, height: 700 }, false, true).width).toBe(1440);
  });

  it("fills the stage's height at that scale, but never scales above 100%", () => {
    const tall = frameLayout("desktop", "fit", { width: 960, height: 1000 }, false, true);
    expect(tall.height * tall.scale).toBeCloseTo(1000 - 48, 0);
    expect(frameLayout("desktop", "fit", { width: 3000, height: 1000 }, false, true).scale).toBe(1);
  });

  it("opens an undeclared page on desktop, and keeps a declared device", () => {
    expect(viewportForDevice(undefined)).toBe("desktop");
    expect(viewportForDevice("mobile")).toBe("mobile");
  });

  it("leaves the old layout alone without the switch", () => {
    expect(frameLayout("desktop", "fit", { width: 960, height: 1000 }).height).toBe(900);
  });
});

describe("the bridge gate", () => {
  const session = (now: () => number = () => 0) => {
    let n = 0;
    return createBridgeGate(() => `nonce-${++n}`, now);
  };

  it("drops a message over the size limit", () => {
    const gate = session();
    expect(gate.admit({ type: "scroll", x: 0, y: 0 })).toBe(true);
    expect(gate.admit({ type: "outline", nodes: "x".repeat(BRIDGE_LIMITS.bytes) })).toBe(false);
  });

  it("drops a flood, then lets messages through again next second", () => {
    let t = 1000;
    const gate = session(() => t);
    let passed = 0;
    for (let i = 0; i < BRIDGE_LIMITS.perSecond + 50; i++) if (gate.admit({ type: "scroll" })) passed++;
    expect(passed).toBe(BRIDGE_LIMITS.perSecond);
    t += 1000;
    expect(gate.admit({ type: "scroll" })).toBe(true);
  });

  it("wants this load's token on anything that changes the file, and an old load's token is refused", () => {
    const gate = session();
    const nonce = gate.renew();
    expect(gate.admit({ type: "history-key", action: "undo" })).toBe(false);
    expect(gate.admit({ type: "text-commit", nonce: "wrong" })).toBe(false);
    expect(gate.admit({ type: "text-commit", nonce })).toBe(true);
    gate.renew();
    expect(gate.admit({ type: "history-key", nonce })).toBe(false);
    expect(gate.admit({ type: "scroll" })).toBe(true);
  });

  it("wants the token on a ⌥-drag copy, which writes the file", () => {
    const gate = session();
    const nonce = gate.renew();
    expect(gate.admit({ type: "clone-drop" })).toBe(false);
    expect(gate.admit({ type: "clone-drop", nonce })).toBe(true);
  });

  it("refuses non-objects and anything it can't measure", () => {
    const gate = session();
    expect(gate.admit(null)).toBe(false);
    expect(gate.admit("text")).toBe(false);
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(gate.admit(loop)).toBe(false);
  });
});

describe("reading the new bridge messages", () => {
  const base = { source: "cubiq-design" };
  it("reads a text commit by id and by place", () => {
    expect(readBridgeMessage({ ...base, type: "text-commit", target: { id: "a1" }, before: "a", after: "b", live: true })).toMatchObject({ target: { id: "a1" }, live: true });
    expect(readBridgeMessage({ ...base, type: "text-commit", target: { locator: { tag: "h1", path: [1, 0], text: "a" } }, before: "a", after: "b" })).toMatchObject({ target: { locator: { path: [1, 0] } }, live: false });
  });

  it("refuses a bad target, and extra keys never travel on", () => {
    for (const target of [{ id: "../x" }, { locator: { tag: "", path: [], text: "" } }, { locator: { tag: "h1", path: [-1], text: "" } }, null]) {
      expect(readBridgeMessage({ ...base, type: "text-commit", target, before: "a", after: "b" })).toBeNull();
    }
    expect(readBridgeMessage({ ...base, type: "history-key", action: "undo", extra: 1 })).toEqual({ type: "history-key", action: "undo" });
    expect(readBridgeMessage({ ...base, type: "history-key", action: "delete" })).toBeNull();
  });

  it("reads a ⌥-drag copy: two elements and before or after", () => {
    const el = (selector: string) => ({ selector, tag: "div", text: "", html: "", rect: { x: 0, y: 0, width: 10, height: 10 }, path: [] });
    expect(readBridgeMessage({ ...base, type: "clone-drop", from: el("#a"), ref: el("#b"), position: "after" })).toMatchObject({ type: "clone-drop", from: { selector: "#a" }, ref: { selector: "#b" }, position: "after" });
    expect(readBridgeMessage({ ...base, type: "clone-drop", from: el("#a"), ref: el("#b"), position: "inside" })).toBeNull();
    expect(readBridgeMessage({ ...base, type: "clone-drop", from: el("#a"), ref: null, position: "before" })).toBeNull();
  });

  it("reads a press on the page", () => {
    expect(readBridgeMessage({ ...base, type: "pointer", extra: 1 })).toEqual({ type: "pointer" });
  });

  it("reads only token-shaped theme values", () => {
    expect(readBridgeMessage({ ...base, type: "theme", tokens: { "--color-bg": "#fff" } })).toEqual({ type: "theme", tokens: { "--color-bg": "#fff" } });
    expect(readBridgeMessage({ ...base, type: "theme", tokens: { color: "#fff" } })).toBeNull();
    expect(readBridgeMessage({ ...base, type: "theme", tokens: {}, scheme: "dark" })).toEqual({ type: "theme", tokens: {}, scheme: "dark" });
    expect(readBridgeMessage({ ...base, type: "theme", tokens: {}, scheme: "light dark" })).toEqual({ type: "theme", tokens: {} });
  });
});

function fakeApi() {
  const status = (revision: number): DocumentStatus => ({ documentId: "doc", revision, save: "saved", canUndo: false, canRedo: false, atExternalBoundary: false, readOnly: false });
  const sent: DesignMutation[] = [];
  const gates: (() => void)[] = [];
  const api: DocumentApi = {
    designHistory: vi.fn(async () => ({ status: status(1), html: "", conflicts: [] })),
    designMutate: vi.fn(async (_t, _r, m: DesignMutation) => {
      sent.push(m);
      await new Promise<void>((resolve) => gates.push(resolve));
      return { ok: true as const, operationId: m.operationId, newRevision: m.baseRevision + 1 };
    }),
  };
  return { api, sent, gates };
}

describe("the document client", () => {
  const change = { kind: "setText", before: "a", after: "b" } as const;
  const until = async (test: () => boolean) => vi.waitFor(() => expect(test()).toBe(true));

  it("sends edits one at a time, each based on the revision the last produced", async () => {
    const { api, sent, gates } = fakeApi();
    const client = new DesignDocumentClient(api, "t", "index.html", () => `op-${sent.length}`);
    const first = client.mutate({ id: "a" }, change, "tx");
    const second = client.mutate({ id: "a" }, change, "tx");
    await until(() => sent.length === 1);
    expect(sent[0]).toMatchObject({ documentId: "doc", baseRevision: 1 });
    gates[0]!();
    await first;
    await until(() => sent.length === 2);
    expect(sent[1]?.baseRevision).toBe(2);
    gates[1]!();
    await second;
  });

  it("follows the revision a refusal reports, so the next edit isn't stale too", async () => {
    const api: DocumentApi = {
      designHistory: vi.fn(async () => ({ status: { documentId: "doc", revision: 1, save: "saved" as const, canUndo: false, canRedo: false, atExternalBoundary: false, readOnly: false }, html: "", conflicts: [] })),
      designMutate: vi.fn(async (_t, _r, m: DesignMutation) => ({ ok: false as const, operationId: m.operationId, reason: "stale" as const, currentRevision: 9 })),
    };
    const client = new DesignDocumentClient(api, "t", "index.html", () => "op");
    await client.mutate({ id: "a" }, change, "tx");
    await client.mutate({ id: "a" }, change, "tx");
    expect(vi.mocked(api.designMutate).mock.calls[1]?.[2].baseRevision).toBe(9);
  });

  it("a failed call doesn't jam the ones behind it", async () => {
    const api: DocumentApi = {
      designHistory: vi.fn().mockRejectedValueOnce(new Error("no")).mockResolvedValue({ status: { documentId: "doc", revision: 1 }, html: "", conflicts: [] }),
      designMutate: vi.fn(),
    };
    const client = new DesignDocumentClient(api, "t", "index.html", () => "op");
    await expect(client.status()).rejects.toThrow("no");
    await expect(client.flush()).resolves.toMatchObject({ status: { revision: 1 } });
  });
});

const PAGE = '<!DOCTYPE html><html><head><title>T</title></head><body><h1 data-agent-id="title">Hello</h1><p>Plain</p></body></html>';

describe("saves and the watcher", () => {
  const open: DesignDocuments[] = [];
  afterEach(() => {
    open.splice(0).forEach((d) => d.dispose());
  });
  const setup = (extra: Partial<ConstructorParameters<typeof DesignDocuments>[0]> = {}) => {
    const dir = tempDir();
    const file = join(dir, "index.html");
    writeFileSync(file, PAGE);
    const docs = new DesignDocuments({ journalDir: join(dir, "journal"), isBusy: () => false, debounceMs: 5, ...extra });
    open.push(docs);
    return { docs, file };
  };
  const edit = (after: string, revision = 1, before = "Hello"): DesignMutation => ({
    operationId: `op-${after}`,
    documentId: documentIdOf("t", "index.html"),
    baseRevision: revision,
    target: { id: "title" },
    transactionId: `tx-${after}`,
    change: { kind: "setText", before, after },
  });

  it("calls the editor's own save its own, so the frame doesn't reload", () => {
    const { docs, file } = setup();
    expect(docs.mutate("t", "index.html", file, edit("Hi")).ok).toBe(true);
    docs.history("t", "index.html", file, { action: "flush" });
    expect(readFileSync(file, "utf8")).toContain("Hi");
    expect(docs.diskChanged("t", ["index.html"])).toEqual([]);
  });

  it("reports an outside write, and leaves other files in the list", () => {
    const { docs, file } = setup();
    docs.history("t", "index.html", file, { action: "status" });
    writeFileSync(file, PAGE.replace("Hello", "Outside"));
    expect(docs.diskChanged("t", ["index.html", "other.css"])).toEqual(["index.html", "other.css"]);
  });

  it("still reports an outside write that an edit noticed before the watcher did", () => {
    const { docs, file } = setup();
    docs.history("t", "index.html", file, { action: "status" });
    writeFileSync(file, PAGE.replace("Plain", "Outside"));
    docs.mutate("t", "index.html", file, edit("Hi", 2));
    expect(docs.diskChanged("t", ["index.html"])).toEqual(["index.html"]);
    expect(docs.diskChanged("t", ["index.html"])).toEqual([]);
  });

  it("doesn't know about a change it wasn't told the path of", () => {
    const { docs, file } = setup();
    docs.history("t", "index.html", file, { action: "status" });
    expect(docs.diskChanged("t", null)).toBeNull();
  });

  it("has an undo on disk before the frame reloads to read it", () => {
    const { docs, file } = setup();
    docs.mutate("t", "index.html", file, edit("Hi"));
    docs.history("t", "index.html", file, { action: "flush" });
    expect(docs.history("t", "index.html", file, { action: "undo" }).result?.ok).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("Hello");
    const redo = docs.history("t", "index.html", file, { action: "redo" });
    expect(redo.result?.ok).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("Hi");
  });

  it("tells the canvas about status, and that conflicts wait", () => {
    const seen: { save: string; conflicts: boolean }[] = [];
    const { docs, file } = setup({ onStatus: (_t, _r, status, conflicts) => seen.push({ save: status.save, conflicts }) });
    docs.mutate("t", "index.html", file, edit("Hi"));
    expect(seen.at(-1)).toMatchObject({ save: "saving", conflicts: false });
    docs.history("t", "index.html", file, { action: "flush" });
    expect(seen.at(-1)?.save).toBe("saved");
  });

  it("keeps a throwing onStatus from escaping", () => {
    const { docs, file } = setup({ onStatus: () => { throw new Error("boom"); } });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(docs.mutate("t", "index.html", file, edit("Hi")).ok).toBe(true);
    quiet.mockRestore();
  });

  it("says once that a journal was replayed, with the edits already on disk", () => {
    const dir = tempDir();
    const file = join(dir, "index.html");
    writeFileSync(file, PAGE);
    const journalDir = join(dir, "journal");
    const first = new DesignDocuments({ journalDir, isBusy: () => false, debounceMs: 60_000 });
    first.mutate("t", "index.html", file, edit("Kept"));
    expect(readFileSync(file, "utf8")).not.toContain("Kept");
    // A crash: the first service is simply never disposed, so its journal stays.
    const second = new DesignDocuments({ journalDir, isBusy: () => false, debounceMs: 5 });
    open.push(second);
    expect(second.history("t", "index.html", file, { action: "status" }).recovered).toBe(1);
    expect(readFileSync(file, "utf8")).toContain("Kept");
    expect(second.history("t", "index.html", file, { action: "status" }).recovered).toBeUndefined();
  });

  it("stamps an id on an element found only by its place", () => {
    const { docs, file } = setup();
    const res = docs.mutate("t", "index.html", file, { ...edit("Word"), target: { locator: { tag: "p", path: [1, 1], text: "Plain" } }, change: { kind: "setText", before: "Plain", after: "Word" } });
    expect(res).toMatchObject({ ok: true, stampedId: expect.any(String) });
  });
});

describe("setText beside icons", () => {
  const change = (before: string, after: string) => ({ kind: "setText" as const, before, after });
  const run = (html: string, before: string, after: string) => applyChange(html, { id: "b" }, change(before, after), () => "n1").html;

  it("edits a button's label and leaves its icon's bytes alone", () => {
    const html = '<html><body><button data-agent-id="b"><i data-ui="icon"></i> Save </button></body></html>';
    expect(run(html, " Save ", "Keep")).toBe('<html><body><button data-agent-id="b"><i data-ui="icon"></i>Keep</button></body></html>');
  });

  it("refuses when elements beside it hold text, or there are two runs", () => {
    expect(() => run('<html><body><p data-agent-id="b">a <b>c</b></p></body></html>', "a ", "x")).toThrow(/more than text/);
    expect(() => run('<html><body><p data-agent-id="b">a <i></i> c</p></body></html>', "a ", "x")).toThrow(/more than text/);
  });

  it("matches a CRLF file against the LF text a browser reports", () => {
    const html = '<html><body><p data-agent-id="b">one\r\ntwo</p></body></html>';
    expect(run(html, "one\ntwo", "three")).toContain(">three</p>");
  });
});

describe("the Customize panel", () => {
  const props = {
    threadId: "t",
    designDir: "designs/a",
    reloadKey: "0",
    readOnly: false,
    styleName: "Glacier",
    appearance: "light" as const,
    onAppearance: () => undefined,
    onClear: () => undefined,
    onViewHtml: () => undefined,
    tweaks: null,
    handlers: { onStyle: () => undefined, onAttr: () => undefined, onText: () => undefined, onAttrs: () => undefined },
  };
  const element = (over: Partial<SelectedElement>): SelectedElement => ({ selector: "button", tag: "button", text: "Get started", html: '<button data-ui="button" disabled>Get started</button>', rect: { x: 0, y: 0, width: 10, height: 10 }, path: [], ...over });

  it("is never empty: nothing selected shows the page's theme", () => {
    const html = renderToStaticMarkup(<CustomizePanel {...props} element={null} theme={{ "--color-accent": "#112233", "--radius-md": "6px" }} />);
    expect(html).toContain("Page Theme");
    expect(html).toContain("Glacier");
    expect(html).toContain("Accent");
    expect(html).toContain("Sharp");
  });

  it("shows no control for a token the page doesn't have", () => {
    const html = renderToStaticMarkup(<CustomizePanel {...props} element={null} theme={{}} />);
    expect(html).not.toContain("Accent");
    expect(html).not.toContain("Sharp");
  });

  it("shows the element by its part name, with no Apply", () => {
    const html = renderToStaticMarkup(<CustomizePanel {...props} element={element({})} theme={{}} />);
    expect(html).toContain("Button &quot;Get started&quot;");
    expect(html).not.toContain("Apply");
    expect(html).toContain("Disabled");
    expect(html).toContain("Reset overrides");
  });

  it("offers Value and Placeholder on a field, and no Disabled on plain text", () => {
    const field = renderToStaticMarkup(<CustomizePanel {...props} element={element({ tag: "input", text: "", html: '<input placeholder="Email">' })} theme={{}} />);
    expect(field).toContain("Placeholder");
    const text = renderToStaticMarkup(<CustomizePanel {...props} element={element({ tag: "p", html: "<p>Hi</p>" })} theme={{}} />);
    expect(text).not.toContain("Disabled");
    expect(text).not.toContain("Placeholder");
  });

  it("locks while a turn writes the page, and says why", () => {
    const html = renderToStaticMarkup(<CustomizePanel {...props} readOnly element={null} theme={{}} />);
    expect(html).toContain("Design in progress");
    expect(html).toMatch(/<fieldset[^>]*disabled/);
  });

  it("reads attributes from the start tag only", () => {
    expect(attrOf('<button data-size="sm" disabled>', "data-size")).toBe("sm");
    expect(attrOf("<button disabled>", "disabled")).toBe("");
    expect(attrOf("<div><button disabled></div>", "disabled")).toBeNull();
    expect(attrOf("<a data-sizes='x'>", "data-size")).toBeNull();
  });

  it("words one conflict and several", () => {
    expect(conflictsText([{ operationId: "a", message: "" }])).toBe("This file changed outside the editor. Your last edit was not applied.");
    expect(conflictsText([{ operationId: "a", message: "" }, { operationId: "b", message: "" }])).toContain("2 of your edits were");
  });
});
