import { describe, expect, it } from "vitest";
import type { DesignChange } from "../src/shared/design-mutation";
import {
  applyChange,
  applyPatch,
  diffPatch,
  invertPatch,
  resolveTarget,
  SourceEditError,
} from "../src/main/design/source-edit";

// A page that exercises the hard cases: a doctype, a comment, mixed quotes, CRLF on some lines, an
// uppercase attribute, an unclosed <p>, a void <img>, entities in text, nested sections and two
// elements that share an id.
const PAGE = [
  '<!DOCTYPE html>\r\n<html lang="en">\r\n<head>\r\n  <meta charset="utf-8">\r\n  <title>Studio</title>\r\n</head>',
  "<body>",
  "  <!-- the hero -->\r\n  <header class='site' data-agent-id=\"hero\">",
  "    <h1>Hello &amp; welcome</h1>",
  "  </header>",
  '  <main data-agent-id="main">',
  '    <section id="a" data-agent-id="sa">',
  '      <p data-agent-id="p1">Fish &amp; chips',
  '      <img src="/x.png" alt="A photo" data-agent-id="pic">',
  "    </section>",
  '    <section data-agent-id="sb">',
  '      <p data-agent-id="p1">Duplicate</p>',
  '      <div data-agent-id="box"><span>inner</span></div>',
  "    </section>",
  '    <footer data-agent-id="foot">',
  '      <a href="/home" DATA-ROLE="link" data-agent-id="link">Home</a>',
  "    </footer>",
  "  </main>",
  "</body>",
  "</html>",
].join("\n");

const HERO = { id: "hero" };
const SA = { id: "sa" };
const PIC = { id: "pic" };
const BODY = { locator: { tag: "body", path: [1] } };

/** A deterministic id source. */
function counter(start = 0): () => string {
  let n = start;
  return () => `gen${++n}`;
}

/** The reason a refusal carries, or `null` when the call succeeded. */
function reasonOf(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof SourceEditError ? error.reason : `other: ${String(error)}`;
  }
}

/** Every change kind, resolved against the page. */
const CASES: { name: string; target: { id: string }; change: DesignChange }[] = [
  { name: "setProp add", target: HERO, change: { kind: "setProp", name: "title", value: "Hero" } },
  { name: "setProp remove", target: HERO, change: { kind: "setProp", name: "class", value: null } },
  { name: "setStyle", target: HERO, change: { kind: "setStyle", changes: [{ prop: "color", value: "red" }] } },
  { name: "setText", target: { id: "link" }, change: { kind: "setText", before: "Home", after: "fine" } },
  { name: "insert before", target: HERO, change: { kind: "insert", html: "<hr>", position: "before" } },
  { name: "insert inside", target: SA, change: { kind: "insert", html: "<b>x</b>", position: "inside-end" } },
  { name: "remove", target: PIC, change: { kind: "remove" } },
  { name: "move", target: HERO, change: { kind: "move", refId: "box", position: "after" } },
  { name: "wrap", target: HERO, change: { kind: "wrap", extraIds: [], tag: "div", attrs: { class: "top" } } },
  { name: "unwrap", target: HERO, change: { kind: "unwrap" } },
];

describe("byte preservation", () => {
  for (const { name, target, change } of CASES) {
    it(`touches only the edited bytes: ${name}`, () => {
      const outcome = applyChange(PAGE, target, change, counter());
      expect(outcome.html).not.toBe(PAGE);

      const patch = diffPatch(PAGE, outcome.html);
      const prefix = PAGE.slice(0, patch.start);
      const suffix = PAGE.slice(patch.start + patch.removed.length);
      expect(outcome.html.startsWith(prefix)).toBe(true);
      expect(outcome.html.endsWith(suffix)).toBe(true);

      expect(applyPatch(PAGE, patch)).toBe(outcome.html);
      expect(applyPatch(outcome.html, invertPatch(patch))).toBe(PAGE);
    });
  }

  it("keeps the doctype, comment and CRLF bytes around an edit in the middle", () => {
    const { html } = applyChange(PAGE, PIC, { kind: "setProp", name: "alt", value: "New" }, counter());
    expect(html.startsWith("<!DOCTYPE html>\r\n<html lang=\"en\">")).toBe(true);
    expect(html).toContain("<!-- the hero -->\r\n");
    expect(html).toContain('class=\'site\''); // mixed quotes untouched
  });
});

describe("resolveTarget", () => {
  it("finds an existing unique id", () => {
    expect(resolveTarget(PAGE, { id: "box" }, counter())).toEqual({ html: PAGE, id: "box" });
  });

  it("is stale when nothing matches the id", () => {
    expect(reasonOf(() => resolveTarget(PAGE, { id: "nope" }, counter()))).toBe("stale");
  });

  it("is ambiguous when two elements match the id", () => {
    expect(reasonOf(() => resolveTarget(PAGE, { id: "p1" }, counter()))).toBe("ambiguous");
  });

  it("is invalid for a malformed id", () => {
    expect(reasonOf(() => resolveTarget(PAGE, { id: "bad id!" }, counter()))).toBe("invalid");
  });

  it("stamps a locator target after its tag name", () => {
    const result = resolveTarget(PAGE, { locator: { tag: "h1", path: [1, 0, 0] } }, counter());
    expect(result.id).toBe("gen1");
    expect(result.stampedId).toBe("gen1");
    expect(result.html).toContain('<h1 data-agent-id="gen1">Hello &amp; welcome</h1>');
  });

  it("is stale on a wrong tag or wrong text", () => {
    expect(reasonOf(() => resolveTarget(PAGE, { locator: { tag: "div", path: [1, 0, 0] } }, counter()))).toBe("stale");
    expect(reasonOf(() => resolveTarget(PAGE, { locator: { tag: "h1", path: [1, 0, 0], text: "Different" } }, counter()))).toBe(
      "stale",
    );
  });

  it("matches a locator by trimmed text prefix", () => {
    const result = resolveTarget(PAGE, { locator: { tag: "h1", path: [1, 0, 0], text: "Hello" } }, counter());
    expect(result.id).toBe("gen1");
  });

  it("reuses an existing unique id instead of stamping", () => {
    const result = resolveTarget(PAGE, { locator: { tag: "div", path: [1, 1, 1, 1] } }, counter());
    expect(result.id).toBe("box");
    expect(result.stampedId).toBeUndefined();
    expect(result.html).toBe(PAGE);
  });

  it("refuses an element the parser implied", () => {
    const slim = "<!DOCTYPE html><title>t</title><p>Hi";
    expect(reasonOf(() => resolveTarget(slim, { locator: { tag: "html", path: [] } }, counter()))).toBe("stale");
  });

  it("never reuses an id already in the page", () => {
    let n = 0;
    const pick = (): string => {
      n++;
      return n === 1 ? "hero" : "gen2";
    };
    const result = resolveTarget(PAGE, { locator: { tag: "h1", path: [1, 0, 0] } }, pick);
    expect(result.id).toBe("gen2");
  });
});

describe("setProp", () => {
  it("adds an attribute to an element that has some", () => {
    const { html } = applyChange(PAGE, HERO, { kind: "setProp", name: "title", value: "Hero" }, counter());
    expect(html).toContain('<header class=\'site\' data-agent-id="hero" title="Hero">');
  });

  it("adds an attribute to an element with none", () => {
    const { html } = applyChange(PAGE, { id: "box" }, { kind: "setProp", name: "title", value: "B" }, counter());
    expect(html).toContain('<div data-agent-id="box" title="B"><span>');
  });

  it("replaces a single-quoted value, leaving the rest of the page alone", () => {
    const { html } = applyChange(PAGE, HERO, { kind: "setProp", name: "class", value: "top" }, counter());
    expect(html).toContain('<header class="top" data-agent-id="hero">');
    expect(html).toContain("<section id=\"a\""); // nothing else moved
  });

  it("removes an attribute with its leading whitespace", () => {
    const { html } = applyChange(PAGE, HERO, { kind: "setProp", name: "class", value: null }, counter());
    expect(html).toContain('<header data-agent-id="hero">');
  });

  it("leaves the page alone when removing a missing attribute", () => {
    const { html } = applyChange(PAGE, HERO, { kind: "setProp", name: "title", value: null }, counter());
    expect(html).toBe(PAGE);
  });

  it("keeps the original case of an existing attribute name", () => {
    const { html } = applyChange(PAGE, { id: "link" }, { kind: "setProp", name: "data-role", value: "nav" }, counter());
    expect(html).toContain('<a href="/home" DATA-ROLE="nav" data-agent-id="link">Home</a>');
  });

  it("escapes ampersands and quotes in the value", () => {
    const { html } = applyChange(PAGE, HERO, { kind: "setProp", name: "title", value: 'A & "B"' }, counter());
    expect(html).toContain('title="A &amp; &quot;B&quot;"');
  });

  it("refuses banned names", () => {
    const banned: DesignChange[] = [
      { kind: "setProp", name: "onclick", value: "x" },
      { kind: "setProp", name: "style", value: "color:red" },
      { kind: "setProp", name: "data-agent-id", value: "x" },
      { kind: "setProp", name: "9lives", value: "x" },
    ];
    for (const change of banned) {
      expect(reasonOf(() => applyChange(PAGE, { id: "link" }, change, counter()))).toBe("invalid");
    }
  });

  it("refuses banned schemes", () => {
    const banned: DesignChange[] = [
      { kind: "setProp", name: "href", value: " JavaScript:alert(1)" },
      { kind: "setProp", name: "src", value: "data:text/html,x" },
      { kind: "setProp", name: "formaction", value: "vbscript:x" },
    ];
    for (const change of banned) {
      expect(reasonOf(() => applyChange(PAGE, { id: "link" }, change, counter()))).toBe("invalid");
    }
  });
});

describe("setStyle", () => {
  it("adds a style attribute when there is none", () => {
    const { html } = applyChange(PAGE, HERO, { kind: "setStyle", changes: [{ prop: "color", value: "red" }] }, counter());
    expect(html).toContain('<header class=\'site\' data-agent-id="hero" style="color: red">');
  });

  it("updates a declaration in place and appends new ones", () => {
    const base = PAGE.replace('data-agent-id="hero">', 'data-agent-id="hero" style="padding: 4px; color: blue">');
    const { html } = applyChange(
      base,
      HERO,
      { kind: "setStyle", changes: [{ prop: "color", value: "red" }, { prop: "margin", value: "0" }] },
      counter(),
    );
    expect(html).toContain('style="padding: 4px; color: red; margin: 0"');
  });

  it("removes the attribute when the last declaration goes", () => {
    const base = PAGE.replace('data-agent-id="hero">', 'data-agent-id="hero" style="color: blue">');
    const { html } = applyChange(base, HERO, { kind: "setStyle", changes: [{ prop: "color", value: "" }] }, counter());
    expect(html).toContain('<header class=\'site\' data-agent-id="hero">');
  });

  it("rejects url() and semicolons", () => {
    expect(
      reasonOf(() =>
        applyChange(PAGE, HERO, { kind: "setStyle", changes: [{ prop: "background", value: "url(x.png)" }] }, counter()),
      ),
    ).toBe("invalid");
    expect(
      reasonOf(() =>
        applyChange(PAGE, HERO, { kind: "setStyle", changes: [{ prop: "color", value: "red; background: blue" }] }, counter()),
      ),
    ).toBe("invalid");
  });
});

describe("setText", () => {
  it("reads the current text with entities decoded", () => {
    const { html } = applyChange(PAGE, { id: "link" }, { kind: "setText", before: "Home", after: "Start" }, counter());
    expect(html).toContain('data-agent-id="link">Start</a>');
  });

  it("decodes entities in the before text of a nested text node", () => {
    const page = PAGE.replace('<p data-agent-id="p1">Duplicate</p>', '<p data-agent-id="p2">Dup &amp; more</p>');
    const { html } = applyChange(page, { id: "p2" }, { kind: "setText", before: "Dup & more", after: "Copy" }, counter());
    expect(html).toContain('<p data-agent-id="p2">Copy</p>');
  });

  it("writes the new text escaped", () => {
    const { html } = applyChange(PAGE, { id: "link" }, { kind: "setText", before: "Home", after: "A & B" }, counter());
    expect(html).toContain(">A &amp; B</a>");
  });

  it("is stale when the before text differs", () => {
    expect(reasonOf(() => applyChange(PAGE, { id: "link" }, { kind: "setText", before: "Away", after: "Start" }, counter()))).toBe(
      "stale",
    );
  });

  it("refuses an element with children", () => {
    expect(reasonOf(() => applyChange(PAGE, { id: "foot" }, { kind: "setText", before: "", after: "x" }, counter()))).toBe(
      "invalid",
    );
  });

  it("refuses an element without an end tag", () => {
    const page = '<html><body><p data-agent-id="q">a</body></html>';
    expect(reasonOf(() => applyChange(page, { id: "q" }, { kind: "setText", before: "a", after: "b" }, counter()))).toBe(
      "invalid",
    );
  });

  it("refuses script", () => {
    const page = '<html><body><script data-agent-id="s">var a=1</script></body></html>';
    expect(reasonOf(() => applyChange(page, { id: "s" }, { kind: "setText", before: "var a=1", after: "var b=2" }, counter()))).toBe(
      "invalid",
    );
  });
});

describe("insert", () => {
  it("inserts before at the element's start", () => {
    const { html } = applyChange(PAGE, HERO, { kind: "insert", html: "<hr>", position: "before" }, counter());
    expect(html).toContain('<!-- the hero -->\r\n  <hr data-agent-id="gen1"><header');
  });

  it("inserts after at the element's end", () => {
    const { html } = applyChange(PAGE, HERO, { kind: "insert", html: "<hr>", position: "after" }, counter());
    expect(html).toContain('</header><hr data-agent-id="gen1">\n  <main');
  });

  it("inserts inside-start right after the start tag", () => {
    const { html } = applyChange(PAGE, SA, { kind: "insert", html: "<b>x</b>", position: "inside-start" }, counter());
    expect(html).toContain('<section id="a" data-agent-id="sa"><b data-agent-id="gen1">x</b>');
  });

  it("inserts inside-end right before the end tag", () => {
    const { html } = applyChange(PAGE, SA, { kind: "insert", html: "<b>x</b>", position: "inside-end" }, counter());
    expect(html).toContain('data-agent-id="pic">\n    <b data-agent-id="gen1">x</b></section>');
  });

  it("stamps roots and reports createdIds", () => {
    const outcome = applyChange(PAGE, HERO, { kind: "insert", html: "<b>one</b><i>two</i>", position: "before" }, counter());
    expect(outcome.createdIds).toEqual(["gen1", "gen2"]);
    expect(outcome.html).toContain('<b data-agent-id="gen1">one</b><i data-agent-id="gen2">two</i>');
  });

  it("keeps an id the fragment already carries", () => {
    const outcome = applyChange(PAGE, HERO, { kind: "insert", html: '<b data-agent-id="fresh">x</b>', position: "before" }, counter());
    expect(outcome.createdIds).toEqual([]);
    expect(outcome.html).toContain('<b data-agent-id="fresh">x</b>');
  });

  it("refuses banned content", () => {
    const banned = [
      "<script>x</script>",
      '<a href="javascript:x">x</a>',
      '<div onclick="x"></div>',
      "<iframe></iframe>",
      "<div></div><object></object>",
      '<div><img src="data:image/png;base64,AA"></div>',
      '<div><span srcdoc="x"></span></div>',
      "just text",
    ];
    for (const html of banned) {
      expect(reasonOf(() => applyChange(PAGE, HERO, { kind: "insert", html, position: "before" }, counter()))).toBe("invalid");
    }
  });

  it("refuses a duplicate id", () => {
    expect(
      reasonOf(() =>
        applyChange(PAGE, HERO, { kind: "insert", html: '<b data-agent-id="box">x</b>', position: "before" }, counter()),
      ),
    ).toBe("invalid");
  });

  it("refuses to insert next to body", () => {
    expect(reasonOf(() => applyChange(PAGE, BODY, { kind: "insert", html: "<b>x</b>", position: "before" }, counter()))).toBe(
      "invalid",
    );
  });
});

describe("remove", () => {
  it("removes the element and its whole line", () => {
    const { html } = applyChange(PAGE, PIC, { kind: "remove" }, counter());
    expect(html).toContain('<p data-agent-id="p1">Fish &amp; chips\n    </section>');
    expect(html).not.toContain("<img");
  });

  it("removes nothing extra when the element shares its line", () => {
    const page = PAGE.replace('      <div data-agent-id="box">', '      text <div data-agent-id="box">');
    const { html } = applyChange(page, { id: "box" }, { kind: "remove" }, counter());
    expect(html).toContain("      text \n    </section>");
  });

  it("refuses body", () => {
    expect(reasonOf(() => applyChange(PAGE, BODY, { kind: "remove" }, counter()))).toBe("invalid");
  });
});

describe("move", () => {
  const MOVED_HERO = { id: "hero" };

  it("moves an element forward", () => {
    // hero moves to just after box, inside sb.
    const { html } = applyChange(PAGE, MOVED_HERO, { kind: "move", refId: "box", position: "after" }, counter());
    expect(html.indexOf('data-agent-id="box"')).toBeLessThan(html.indexOf('data-agent-id="hero"'));
    expect(html.match(/data-agent-id="hero"/g)).toHaveLength(1);
    // box stays where its section is.
    expect(html.indexOf('data-agent-id="sb"')).toBeLessThan(html.indexOf('data-agent-id="box"'));
    expect(html).toContain('<div data-agent-id="box"><span>inner</span></div>');
    // hero is gone from its original spot above main.
    expect(html.indexOf('data-agent-id="hero"')).toBeGreaterThan(html.indexOf('data-agent-id="main"'));
  });

  it("moves an element backward", () => {
    // box moves to just before hero, out of sb.
    const { html } = applyChange(PAGE, { id: "box" }, { kind: "move", refId: "hero", position: "before" }, counter());
    expect(html.indexOf('data-agent-id="box"')).toBeLessThan(html.indexOf('data-agent-id="hero"'));
    expect(html.match(/data-agent-id="box"/g)).toHaveLength(1);
    // The section sb no longer holds box.
    const sb = html.slice(html.indexOf('data-agent-id="sb"'), html.indexOf('data-agent-id="foot"'));
    expect(sb).not.toContain('data-agent-id="box"');
  });

  it("refuses moving an element into itself", () => {
    expect(reasonOf(() => applyChange(PAGE, SA, { kind: "move", refId: "pic", position: "inside-end" }, counter()))).toBe(
      "invalid",
    );
    expect(reasonOf(() => applyChange(PAGE, { id: "main" }, { kind: "move", refId: "main", position: "after" }, counter()))).toBe(
      "invalid",
    );
  });

  it("refuses a missing reference", () => {
    expect(reasonOf(() => applyChange(PAGE, HERO, { kind: "move", refId: "nope", position: "after" }, counter()))).toBe("stale");
  });
});

describe("wrap", () => {
  it("wraps a run of siblings", () => {
    const outcome = applyChange(PAGE, SA, { kind: "wrap", extraIds: ["sb"], tag: "div", attrs: { class: "group" } }, counter());
    expect(outcome.html).toContain('<div class="group" data-agent-id="gen1"><section id="a" data-agent-id="sa">');
    expect(outcome.html).toContain('</section></div>');
    expect(outcome.createdIds).toEqual(["gen1"]);
  });

  it("refuses a run with text between the siblings", () => {
    const page = PAGE.replace('</section>\n    <section data-agent-id="sb">', '</section>text\n    <section data-agent-id="sb">');
    expect(reasonOf(() => applyChange(page, SA, { kind: "wrap", extraIds: ["sb"], tag: "div", attrs: {} }, counter()))).toBe(
      "invalid",
    );
  });

  it("refuses non-siblings", () => {
    expect(reasonOf(() => applyChange(PAGE, SA, { kind: "wrap", extraIds: ["box"], tag: "div", attrs: {} }, counter()))).toBe(
      "invalid",
    );
  });

  it("refuses an unlisted wrapper tag", () => {
    expect(reasonOf(() => applyChange(PAGE, HERO, { kind: "wrap", extraIds: [], tag: "table", attrs: {} }, counter()))).toBe(
      "invalid",
    );
  });

  it("allows a style attribute under the setStyle rules", () => {
    const outcome = applyChange(PAGE, HERO, { kind: "wrap", extraIds: [], tag: "section", attrs: { style: "display: flex" } }, counter());
    expect(outcome.html).toContain('<section style="display: flex" data-agent-id="gen1"><header');
    expect(
      reasonOf(() =>
        applyChange(PAGE, HERO, { kind: "wrap", extraIds: [], tag: "section", attrs: { style: "background: url(x)" } }, counter()),
      ),
    ).toBe("invalid");
  });
});

describe("unwrap", () => {
  it("keeps the content bytes", () => {
    const { html } = applyChange(PAGE, HERO, { kind: "unwrap" }, counter());
    expect(html).toContain("<body>\n  <!-- the hero -->\r\n  \n    <h1>Hello &amp; welcome</h1>\n  \n  <main");
    expect(html).not.toContain("<header");
  });

  it("refuses an element without element children", () => {
    expect(reasonOf(() => applyChange(PAGE, { id: "link" }, { kind: "unwrap" }, counter()))).toBe("invalid");
  });
});

describe("diffPatch", () => {
  it("is empty for identical strings", () => {
    expect(diffPatch("same", "same")).toEqual({ start: 0, removed: "", inserted: "" });
  });

  it("finds the smallest splice", () => {
    expect(diffPatch("hello world", "hello there")).toEqual({ start: 6, removed: "world", inserted: "there" });
  });

  it("never splits an emoji surrogate pair", () => {
    const before = "<p>ok</p>";
    const after = "<p>😀</p>";
    const patch = diffPatch(before, after);
    expect(applyPatch(before, patch)).toBe(after);
    // The shared prefix stops before the emoji's low surrogate, so the pair is never split.
    expect(patch).toEqual({ start: 3, removed: "ok", inserted: "😀" });
    const prefixChar = before.charCodeAt(patch.start - 1);
    expect(prefixChar >= 0xd800 && prefixChar <= 0xdbff).toBe(false);
    expect(applyPatch(after, diffPatch(after, before))).toBe(before);
  });

  it("round-trips through the inverse", () => {
    const patch = diffPatch("hello world", "hello there");
    expect(applyPatch("hello world", patch)).toBe("hello there");
    expect(applyPatch("hello there", invertPatch(patch))).toBe("hello world");
  });

  it("is stale when the expected bytes are gone", () => {
    expect(reasonOf(() => applyPatch("changed", { start: 0, removed: "hello", inserted: "hi" }))).toBe("stale");
  });
});
