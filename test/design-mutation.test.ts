import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentMutationService, documentIdOf, type MutationConflict, type MutationServiceOptions } from "../src/main/design/mutation";
import type { DesignChange, DesignMutation, MutationResult } from "../src/shared/design-mutation";
import { closeAfter, tempDir } from "./helpers";

// A page with the three things a person edits: a heading, a button and a card.
const PAGE = [
  "<!DOCTYPE html>",
  '<html lang="en">',
  "<head>",
  '  <meta charset="utf-8">',
  "  <title>Studio</title>",
  "</head>",
  "<body>",
  '  <h1 data-agent-id="title">Hello</h1>',
  '  <button data-agent-id="cta" class="primary">Start</button>',
  '  <div data-agent-id="card"><p data-agent-id="copy">Body copy</p></div>',
  "</body>",
  "</html>",
  "",
].join("\n");

const DOC = "doc-1";
const TITLE = { id: "title" };
const CTA = { id: "cta" };
const CARD = { id: "card" };

interface Harness {
  service: DocumentMutationService;
  file: string;
  wal: () => string;
  saved: string[];
}

let clock = 1_000;
let ids = 0;

/** One service over a fresh page file and journal directory. */
function harness(options: Partial<MutationServiceOptions> = {}): Harness {
  const dir = tempDir();
  const file = join(dir, "index.html");
  writeFileSync(file, PAGE);
  const journalDir = join(dir, "journal");
  const saved: string[] = [];
  const service = new DocumentMutationService({
    journalDir,
    debounceMs: 0,
    now: () => clock,
    newId: () => `gen-${++ids}`,
    onSaved: (id) => saved.push(id),
    ...options,
  });
  closeAfter(() => service.dispose());
  return {
    service,
    file,
    wal: () => join(journalDir, `${DOC}.wal`),
    saved,
  };
}

function opened(h: Harness): string {
  return h.service.open(DOC, h.file).html;
}

function journalPath(dir: string): string {
  return join(dir, `${DOC}.wal`);
}

function mut(
  baseRevision: number,
  target: DesignMutation["target"],
  change: DesignChange,
  extra: Partial<DesignMutation> = {},
): DesignMutation {
  return {
    operationId: `op-${Math.random().toString(16).slice(2)}`,
    documentId: DOC,
    baseRevision,
    target,
    transactionId: "tx",
    change,
    ...extra,
  };
}

function setText(before: string, after: string): DesignChange {
  return { kind: "setText", before, after };
}

function reasonOf(result: MutationResult): string | null {
  return result.ok ? null : result.reason;
}

beforeEach(() => {
  clock = 1_000;
  ids = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("documentIdOf", () => {
  it("hashes the thread and path to 24 hex characters", () => {
    const id = documentIdOf("thread", "pages/index.html");
    expect(id).toMatch(/^[0-9a-f]{24}$/);
    expect(documentIdOf("thread", "pages/index.html")).toBe(id);
    expect(documentIdOf("thread", "pages/other.html")).not.toBe(id);
    expect(documentIdOf("thread2", "pages/index.html")).not.toBe(id);
  });
});

describe("DocumentMutationService", () => {
  it("opens the file at revision 1", () => {
    const h = harness();
    const result = h.service.open(DOC, h.file);
    expect(result.html).toBe(PAGE);
    expect(result.recovered).toBe(0);
    expect(result.conflicts).toEqual([]);
    expect(result.status).toMatchObject({ documentId: DOC, revision: 1, save: "saved", readOnly: false });
    expect(h.service.html(DOC)).toBe(PAGE);
  });

  it("returns revision 2 from a setText, writes the disk only after flush, and leaves no temp file", () => {
    const h = harness({ debounceMs: 10_000 });
    opened(h);
    const result = h.service.mutate(mut(1, TITLE, setText("Hello", "Hi there")));
    expect(result).toEqual({ ok: true, operationId: expect.any(String), newRevision: 2 });
    expect(h.service.html(DOC)).toContain("Hi there");
    expect(readFileSync(h.file, "utf8")).toBe(PAGE);

    expect(h.service.flush(DOC)).toBe(true);
    const disk = readFileSync(h.file, "utf8");
    expect(disk).toContain("Hi there");
    expect(disk.replace("Hi there", "Hello")).toBe(PAGE);
    const leftovers = readdirSync(dirname(h.file)).filter((name) => name.includes(".tmp."));
    expect(leftovers).toEqual([]);
    expect(h.saved).toEqual([DOC]);
    expect(h.service.status(DOC)?.save).toBe("saved");
  });

  it("writes nothing before flush, holds a journal after mutate, and removes it after flush", () => {
    const h = harness({ debounceMs: 10_000 });
    opened(h);
    h.service.mutate(mut(1, CTA, setText("Start", "Go")));
    expect(readFileSync(h.file, "utf8")).toBe(PAGE);
    expect(existsSync(h.wal())).toBe(true);
    expect(h.service.status(DOC)?.save).toBe("saving");

    h.service.flush(DOC);
    expect(existsSync(h.wal())).toBe(false);
    expect(readFileSync(h.file, "utf8")).toContain(">Go<");
  });

  it("saves after the debounce and restarts the timer on a later edit", () => {
    vi.useFakeTimers();
    try {
      const h = harness({ debounceMs: 250 });
      opened(h);
      h.service.mutate(mut(1, TITLE, setText("Hello", "One")));
      vi.advanceTimersByTime(200);
      expect(readFileSync(h.file, "utf8")).toBe(PAGE);
      const base = h.service.status(DOC)?.revision ?? 0;
      h.service.mutate(mut(base, CTA, setText("Start", "Two")));
      vi.advanceTimersByTime(249);
      expect(readFileSync(h.file, "utf8")).toBe(PAGE);
      vi.advanceTimersByTime(1);
      const disk = readFileSync(h.file, "utf8");
      expect(disk).toContain(">One<");
      expect(disk).toContain(">Two<");
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns the same result for a repeated operationId and changes nothing", () => {
    const h = harness({ debounceMs: 10_000 });
    opened(h);
    const mutation = mut(1, TITLE, setText("Hello", "Once"), { operationId: "same" });
    const first = h.service.mutate(mutation);
    const afterFirst = h.service.html(DOC);
    const second = h.service.mutate(mutation);
    expect(second).toEqual(first);
    expect(h.service.html(DOC)).toBe(afterFirst);
    expect(h.service.status(DOC)?.revision).toBe(2);
  });

  it("rebases a stale base that touches nothing else", () => {
    const h = harness({ debounceMs: 10_000 });
    opened(h);
    expect(reasonOf(h.service.mutate(mut(1, TITLE, setText("Hello", "Hey"))))).toBeNull();
    const rebased = h.service.mutate(mut(1, CTA, setText("Start", "Launch")));
    expect(rebased).toMatchObject({ ok: true, newRevision: 3 });
    expect(h.service.html(DOC)).toContain("Launch");
    expect(h.service.html(DOC)).toContain("Hey");
  });

  it("refuses a stale base that touches the same prop", () => {
    const h = harness({ debounceMs: 10_000 });
    opened(h);
    h.service.mutate(mut(1, TITLE, setText("Hello", "A")));
    expect(reasonOf(h.service.mutate(mut(1, TITLE, setText("A", "B"))))).toBe("stale");
  });

  it("refuses a stale base when either key is *", () => {
    const h = harness({ debounceMs: 10_000 });
    opened(h);
    h.service.mutate(mut(1, TITLE, setText("Hello", "A")));
    expect(reasonOf(h.service.mutate(mut(1, TITLE, { kind: "unwrap" })))).toBe("stale");
  });

  it("refuses a base revision from the future", () => {
    const h = harness();
    opened(h);
    expect(reasonOf(h.service.mutate(mut(5, TITLE, setText("Hello", "A"))))).toBe("stale");
  });

  it("refuses a locator target on a stale base", () => {
    const h = harness({ debounceMs: 10_000 });
    opened(h);
    h.service.mutate(mut(1, CTA, setText("Start", "Go")));
    const locator = { locator: { tag: "h1", path: [1, 0], text: "Hello" } };
    const result = h.service.mutate(mut(1, locator, setText("Hello", "A")));
    expect(reasonOf(result)).toBe("stale");
  });

  it("reports an ambiguous id and leaves the html alone", () => {
    const dir = tempDir();
    const file = join(dir, "index.html");
    const doubled = PAGE.replace('<p data-agent-id="copy">', '<p data-agent-id="title">');
    writeFileSync(file, doubled);
    const service = new DocumentMutationService({ journalDir: join(dir, "journal"), debounceMs: 0 });
    closeAfter(() => service.dispose());
    const html = service.open(DOC, file).html;
    expect(reasonOf(service.mutate(mut(1, TITLE, setText("Hello", "A"))))).toBe("ambiguous");
    expect(service.html(DOC)).toBe(html);
  });

  it("reports an invalid change", () => {
    const h = harness();
    opened(h);
    const result = h.service.mutate(mut(1, TITLE, { kind: "setProp", name: "onclick", value: "x()" }));
    expect(reasonOf(result)).toBe("invalid");
    expect(result.ok).toBe(false);
    expect(h.service.html(DOC)).toBe(PAGE);
  });

  it("refuses mutate, undo and redo when read-only", () => {
    const h = harness({ debounceMs: 10_000 });
    opened(h);
    h.service.mutate(mut(1, TITLE, setText("Hello", "A")));
    h.service.setReadOnly(DOC, true);
    expect(h.service.status(DOC)?.readOnly).toBe(true);
    expect(reasonOf(h.service.mutate(mut(2, CTA, setText("Start", "Go"))))).toBe("read-only");
    expect(reasonOf(h.service.undo(DOC))).toBe("read-only");
    expect(reasonOf(h.service.redo(DOC))).toBe("read-only");
  });

  it("coalesces one transaction into one undo, splits past idleMs, and splits on closeTransaction", () => {
    const h = harness({ debounceMs: 10_000 });
    opened(h);
    const rev = (): number => h.service.status(DOC)?.revision ?? 0;
    const before = (): string => h.service.html(DOC) ?? "";

    h.service.mutate(mut(rev(), TITLE, setText("Hello", "A"), { transactionId: "t1" }));
    h.service.mutate(mut(rev(), TITLE, setText("A", "AB"), { transactionId: "t1" }));
    const grouped = before();
    expect(h.service.undo(DOC)).toMatchObject({ ok: true, newRevision: 4 });
    expect(h.service.html(DOC)).toBe(PAGE);

    h.service.redo(DOC);
    expect(before()).toBe(grouped);
    clock += 5_000;
    // The redo is a group of its own, so the next edit starts a new one after a gap.
    h.service.mutate(mut(rev(), CTA, setText("Start", "Go"), { transactionId: "t2" }));
    const withCta = before();
    expect(h.service.undo(DOC).ok).toBe(true);
    expect(before()).toBe(grouped);
    expect(before()).not.toBe(withCta);

    h.service.mutate(mut(rev(), TITLE, { kind: "setProp", name: "class", value: "panel" }, { transactionId: "t3" }));
    const beforeSplit = before();
    h.service.closeTransaction(DOC, "t3");
    h.service.mutate(mut(rev(), TITLE, { kind: "setProp", name: "class", value: "panel wide" }, { transactionId: "t3" }));
    // One undo only steps back past the close, to the state before the second half of the group.
    h.service.undo(DOC);
    expect(before()).toBe(beforeSplit);
    expect(before()).toContain('class="panel"');
    // The next undo restores the state before the whole transaction.
    h.service.undo(DOC);
    expect(before()).not.toContain("panel");
  });

  it("undoes after closeTransaction without inventing an external boundary", () => {
    const h = harness({ debounceMs: 10_000 });
    opened(h);
    h.service.mutate(mut(1, TITLE, setText("Hello", "Dragged"), { transactionId: "drag" }));
    h.service.closeTransaction(DOC, "drag");

    expect(h.service.status(DOC)?.atExternalBoundary).toBe(false);
    expect(reasonOf(h.service.undo(DOC))).toBeNull();
    expect(h.service.html(DOC)).toBe(PAGE);
  });

  it("undoes then redoes to the exact bytes, bumping the revision, and a new edit clears redo", () => {
    const h = harness({ debounceMs: 10_000 });
    opened(h);
    h.service.mutate(mut(1, TITLE, setText("Hello", "Changed & more")));
    const edited = h.service.html(DOC);
    expect(edited).not.toBe(PAGE);

    const undone = h.service.undo(DOC);
    expect(undone).toMatchObject({ ok: true, newRevision: 3 });
    expect(h.service.html(DOC)).toBe(PAGE);

    const redone = h.service.redo(DOC);
    expect(redone).toMatchObject({ ok: true, newRevision: 4 });
    expect(h.service.html(DOC)).toBe(edited);

    h.service.mutate(mut(4, CTA, setText("Start", "Go")));
    expect(h.service.status(DOC)?.canRedo).toBe(false);
    // Both directions are empty again: an undo has nothing to undo.
    expect(reasonOf(h.service.redo(DOC))).toBe("invalid");
    expect(reasonOf(h.service.undo(DOC))).toBeNull();
  });

  it("refuses to undo with nothing to undo", () => {
    const h = harness();
    opened(h);
    const result = h.service.undo(DOC);
    expect(reasonOf(result)).toBe("invalid");
    expect(result.ok).toBe(false);
  });

  it("bumps the revision on an external change, blocks undo, and refuses old-base mutations", () => {
    const h = harness({ debounceMs: 10_000 });
    opened(h);
    h.service.mutate(mut(1, TITLE, { kind: "setProp", name: "class", value: "hero" }));

    const outside = PAGE.replace("Hello", "Theirs");
    writeFileSync(h.file, outside);
    const change = h.service.noteDiskChange(DOC);
    expect(change).toMatchObject({ changed: true, conflicts: [] });
    expect(h.service.status(DOC)).toMatchObject({ revision: 3, atExternalBoundary: true });
    // The pending class edit is carried onto the outside text, not lost with it.
    expect(h.service.html(DOC)).toContain("Theirs");
    expect(h.service.html(DOC)).toContain('class="hero"');

    expect(reasonOf(h.service.undo(DOC))).toBe("external-change");
    expect(reasonOf(h.service.mutate(mut(1, CTA, setText("Start", "Go"))))).toBe("external-change");

    const crossed = h.service.undo(DOC, { crossBoundary: true });
    expect(["stale", null]).toContain(reasonOf(crossed));
    if (crossed.ok) {
      expect(h.service.html(DOC)).toContain("Theirs");
      expect(h.service.html(DOC)).not.toContain('class="hero"');
    }
  });

  it("reapplies pending edits that still resolve and reports the ones that do not", () => {
    const h = harness({ debounceMs: 10_000 });
    opened(h);
    h.service.mutate(mut(1, TITLE, setText("Hello", "Mine")));
    h.service.mutate(mut(2, CARD, { kind: "remove" }));
    expect(h.service.html(DOC)).toContain("Mine");

    // Someone else changed another part of the page and deleted the card.
    const outside = PAGE.replace("Studio", "Workshop").replace(
      '  <div data-agent-id="card"><p data-agent-id="copy">Body copy</p></div>\n',
      "",
    );
    writeFileSync(h.file, outside);
    const change = h.service.noteDiskChange(DOC);
    expect(change.changed).toBe(true);
    expect(change.conflicts).toHaveLength(1);

    h.service.flush(DOC);
    const disk = readFileSync(h.file, "utf8");
    expect(disk).toContain("Mine");
    expect(disk).toContain("Workshop");
  });

  it("detects an outside edit on flush and never overwrites it", () => {
    const h = harness({ debounceMs: 10_000 });
    opened(h);
    h.service.mutate(mut(1, TITLE, setText("Hello", "Mine")));

    const outside = PAGE.replace("Studio", "Workshop");
    writeFileSync(h.file, outside);
    h.service.flush(DOC);
    const disk = readFileSync(h.file, "utf8");
    expect(disk).toContain("Workshop");
    expect(disk).toContain("Mine");
  });

  it("recovers an edit from the journal after a crash", () => {
    const dir = tempDir();
    const file = join(dir, "index.html");
    writeFileSync(file, PAGE);
    const journalDir = join(dir, "journal");
    const crash = (): DocumentMutationService =>
      new DocumentMutationService({ journalDir, debounceMs: 10_000, newId: () => `gen-${++ids}` });

    const first = crash();
    expect(first.open(DOC, file).status.revision).toBe(1);
    first.mutate(mut(1, TITLE, { kind: "insert", html: "<span>added</span>", position: "after" }));
    // The process dies here: no flush, no dispose.

    const second = crash();
    closeAfter(() => {
      second.dispose();
      // The first process is dead: drop its idle timer without letting it save.
      first.close(DOC);
    });
    const result = second.open(DOC, file);
    expect(result.recovered).toBe(1);
    expect(result.html).toContain(">added</span>");
    expect(result.status.revision).toBe(2);
    const onDisk = readFileSync(file, "utf8");
    expect(onDisk === PAGE || onDisk.includes(">added</span>")).toBe(true);
    // The first process never saved, unless its idle timer fired: flush whatever is still held.
    if (onDisk === PAGE) {
      expect(second.flush(DOC)).toBe(true);
    }
    expect(readFileSync(file, "utf8")).toContain("added");
    expect(existsSync(join(journalDir, `${DOC}.wal`))).toBe(false);
  });

  it("replays by captured id on changed disk and reports a removed target", () => {
    const dir = tempDir();
    const file = join(dir, "index.html");
    writeFileSync(file, PAGE);
    const journalDir = join(dir, "journal");
    const first = new DocumentMutationService({ journalDir, debounceMs: 10_000, newId: () => `gen-${++ids}` });
    first.open(DOC, file);
    const inserted = first.mutate(mut(1, TITLE, { kind: "insert", html: "<em>fresh</em>", position: "after" }));
    expect(inserted.ok).toBe(true);
    const created = inserted.ok ? (inserted.createdIds ?? []) : [];
    expect(created).toHaveLength(1);
    const fresh = created[0] ?? "";
    const gone = first.mutate(mut(2, CARD, { kind: "setProp", name: "title", value: "Card" }));
    expect(gone.ok).toBe(true);

    // The page changed on disk and the card is gone, so the second edit no longer has a target.
    const outside = PAGE.replace("Hello", "Changed").replace(
      '  <div data-agent-id="card"><p data-agent-id="copy">Body copy</p></div>\n',
      "",
    );
    writeFileSync(file, outside);

    const second = new DocumentMutationService({ journalDir, debounceMs: 10_000, newId: () => `gen-${++ids}` });
    closeAfter(() => {
      second.dispose();
      first.close(DOC);
    });
    const result = second.open(DOC, file);
    // The insert replays; the card edit has lost its target, so it is reported and dropped.
    expect(result.html).toContain(`<em data-agent-id="${fresh}">`);
    expect(result.html).not.toContain('title="Card"');
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.operationId).toBe(gone.ok ? gone.operationId : "");
    if (existsSync(journalPath(journalDir))) {
      expect(result.recovered).toBe(1);
      second.flush(DOC);
    }
    // On disk: either the recovered page, or the page the outside write left while the deadline ran out.
    const disk = readFileSync(file, "utf8");
    expect(disk === outside || disk.includes(`<em data-agent-id="${fresh}">`)).toBe(true);
  });

  it("ignores a torn last journal line", () => {
    const dir = tempDir();
    const file = join(dir, "index.html");
    writeFileSync(file, PAGE);
    const journalDir = join(dir, "journal");
    const first = new DocumentMutationService({ journalDir, debounceMs: 10_000, newId: () => `gen-${++ids}` });
    first.open(DOC, file);
    first.mutate(mut(1, TITLE, setText("Hello", "Kept")));

    const wal = journalPath(journalDir);
    writeFileSync(wal, `${readFileSync(wal, "utf8")}{"operationId":"torn`);

    const second = new DocumentMutationService({ journalDir, debounceMs: 10_000, newId: () => `gen-${++ids}` });
    closeAfter(() => {
      second.dispose();
      first.close(DOC);
    });
    const result = second.open(DOC, file);
    expect(result.recovered).toBe(1);
    expect(result.html).toContain("Kept");
    expect(result.conflicts).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe(PAGE);

    // The recovering service commits the recovered text.
    second.flush(DOC);
    expect(readFileSync(file, "utf8")).toContain("Kept");
    expect(existsSync(journalPath(journalDir))).toBe(false);
  });

  it("reports not-saved when the rename fails, keeps the journal, then retries to saved", () => {
    const dir = tempDir();
    const file = join(dir, "pages", "index.html");
    mkdirSync(dirname(file));
    writeFileSync(file, PAGE);
    const journalDir = join(dir, "journal");
    const service = new DocumentMutationService({ journalDir, debounceMs: 0 });
    closeAfter(() => service.dispose());
    service.open(DOC, file);
    service.mutate(mut(1, TITLE, setText("Hello", "Retry")));

    // Hold the page away, then make the page a directory: the rename onto it cannot succeed.
    const aside = join(dir, "aside.html");
    renameSync(file, aside);
    mkdirSync(file);

    expect(service.flush(DOC)).toBe(false);
    expect(service.status(DOC)?.save).toBe("not-saved");
    expect(existsSync(join(journalDir, `${DOC}.wal`))).toBe(true);

    rmSync(file, { recursive: true, force: true });
    renameSync(aside, file);
    expect(service.flush(DOC)).toBe(true);
    expect(service.status(DOC)?.save).toBe("saved");
    expect(readFileSync(file, "utf8")).toContain("Retry");
    expect(existsSync(join(journalDir, `${DOC}.wal`))).toBe(false);
  });

  it("persists history across close and reopen, and drops it when the disk changed", () => {
    const dir = tempDir();
    const file = join(dir, "index.html");
    writeFileSync(file, PAGE);
    const journalDir = join(dir, "journal");
    const service = new DocumentMutationService({ journalDir, debounceMs: 0 });
    closeAfter(() => service.dispose());
    service.open(DOC, file);
    const edited = service.mutate(mut(1, TITLE, setText("Hello", "Saved")));
    expect(edited).toMatchObject({ ok: true, newRevision: 2 });
    expect(service.html(DOC)).toContain("Saved");
    expect(service.close(DOC)).toBe(true);
    expect(existsSync(join(journalDir, `${DOC}.wal`))).toBe(false);

    const reopened = service.open(DOC, file);
    expect(reopened.html).toContain("Saved");
    expect(reopened.html).toBe(service.html(DOC));
    expect(reopened.status.canUndo).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("Saved");

    // A reopen starts at revision 1 again, so the undo is the second revision.
    expect(service.undo(DOC)).toMatchObject({ ok: true, newRevision: 2 });
    expect(service.html(DOC)).toBe(PAGE);
    service.close(DOC);
    expect(readFileSync(file, "utf8")).toBe(PAGE);

    // An outside write leaves the history describing text that is no longer there.
    writeFileSync(file, PAGE.replace("Studio", "Elsewhere"));
    const drifted = service.open(DOC, file);
    expect(drifted.status.canUndo).toBe(false);
  });

  it("caps the undo stack at 200 groups", () => {
    const h = harness({ debounceMs: 10_000 });
    opened(h);
    for (let i = 0; i < 205; i++) {
      clock += 5_000;
      const revision = h.service.status(DOC)?.revision ?? 0;
      const result = h.service.mutate(
        mut(revision, TITLE, setText(i === 0 ? "Hello" : `n${i}`, `n${i + 1}`), {
          operationId: `cap-${i}`,
          transactionId: `cap-t-${i}`,
        }),
      );
      expect(result.ok).toBe(true);
    }
    let undone = 0;
    while (h.service.undo(DOC).ok) undone++;
    expect(undone).toBe(200);
  });

  it("keeps a stamped id through a replay on changed disk", () => {
    const dir = tempDir();
    const file = join(dir, "index.html");
    const page = PAGE.replace('<div data-agent-id="card">', "<div>");
    writeFileSync(file, page);
    const journalDir = join(dir, "journal");
    const first = new DocumentMutationService({ journalDir, debounceMs: 10_000, newId: () => `gen-${++ids}` });
    first.open(DOC, file);
    // The card has no id, so a locator target stamps a fresh one.
    const stamped = first.mutate(
      mut(1, { locator: { tag: "div", path: [1, 2] } }, { kind: "setProp", name: "title", value: "Card" }),
    );
    expect(stamped.ok).toBe(true);
    const stampedId = stamped.ok ? stamped.stampedId : undefined;
    expect(stampedId).toBeDefined();
    if (stampedId === undefined) return;

    const outside = page.replace("Studio", "Workshop");
    writeFileSync(file, outside);

    const second = new DocumentMutationService({ journalDir, debounceMs: 10_000, newId: () => `gen-${++ids}` });
    closeAfter(() => {
      second.dispose();
      first.close(DOC);
    });
    const result = second.open(DOC, file);
    expect(result.html).toContain(`data-agent-id="${stampedId}"`);
    expect(result.html).toContain('title="Card"');
    expect(result.html).toContain("Workshop");
  });

  it("reports the edits a save could not carry over to onConflicts", () => {
    const dir = tempDir();
    const file = join(dir, "index.html");
    writeFileSync(file, PAGE);
    const seen: { documentId: string; conflicts: MutationConflict[] }[] = [];
    const service = new DocumentMutationService({
      journalDir: join(dir, "journal"),
      debounceMs: 10_000,
      onConflicts: (documentId, conflicts) => seen.push({ documentId, conflicts }),
    });
    closeAfter(() => service.dispose());
    service.open(DOC, file);

    const kept = service.mutate(mut(1, TITLE, setText("Hello", "Mine")));
    expect(kept.ok).toBe(true);
    const dropped = service.mutate(mut(2, CARD, { kind: "setProp", name: "title", value: "Card" }));
    expect(dropped.ok).toBe(true);

    // Someone else edited the title and removed the card: only the title edit can be carried over.
    const outside = PAGE.replace("Studio", "Workshop").replace(
      '  <div data-agent-id="card"><p data-agent-id="copy">Body copy</p></div>\n',
      "",
    );
    writeFileSync(file, outside);
    expect(service.flush(DOC)).toBe(true);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.documentId).toBe(DOC);
    expect(seen[0]?.conflicts.map((conflict) => conflict.operationId)).toEqual([dropped.operationId]);
    const disk = readFileSync(file, "utf8");
    expect(disk).toContain("Mine");
    expect(disk).toContain("Workshop");
  });

  it("replays correctly through a second crash and undoes back to the disk text", () => {
    const dir = tempDir();
    const file = join(dir, "index.html");
    writeFileSync(file, PAGE);
    const journalDir = join(dir, "journal");
    const service = (): DocumentMutationService =>
      new DocumentMutationService({ journalDir, debounceMs: 10_000, newId: () => `gen-${++ids}` });

    const first = service();
    first.open(DOC, file);
    first.mutate(mut(1, TITLE, { kind: "insert", html: "<em>one</em>", position: "after" }));

    // A crash, then a page that moved underneath us: the insert is rebased onto the new text.
    const outside = PAGE.replace("Studio", "Workshop");
    writeFileSync(file, outside);
    const second = service();
    const recovered = second.open(DOC, file);
    expect(recovered.html).toContain("<em");
    expect(recovered.html).toContain("Workshop");

    // A second crash while the rebased journal is still held: a third service replays the same bytes.
    const third = service();
    closeAfter(() => {
      third.dispose();
      second.dispose();
      first.close(DOC);
    });
    const again = third.open(DOC, file);
    expect(again.html).toBe(recovered.html);

    const undone = third.undo(DOC);
    expect(undone.ok).toBe(true);
    expect(third.html(DOC)).toBe(outside);
  });

  describe("journal durability", () => {
    function crashable(): { file: string; journalDir: string; start: () => DocumentMutationService } {
      const dir = tempDir();
      const file = join(dir, "index.html");
      writeFileSync(file, PAGE);
      const journalDir = join(dir, "journal");
      const started: DocumentMutationService[] = [];
      closeAfter(() => {
        for (const service of [...started].reverse()) service.dispose();
      });
      return {
        file,
        journalDir,
        start: () => {
          const service = new DocumentMutationService({ journalDir, debounceMs: 10_000, newId: () => `gen-${++ids}` });
          started.push(service);
          return service;
        },
      };
    }

    it("journals every edit, not only the latest, and replays them all on the same disk", () => {
      const c = crashable();
      const first = c.start();
      first.open(DOC, c.file);
      first.mutate(mut(1, TITLE, setText("Hello", "One")));
      first.mutate(mut(2, CTA, setText("Start", "Two")));
      first.mutate(mut(3, CARD, { kind: "setProp", name: "title", value: "Three" }));
      expect(readFileSync(journalPath(c.journalDir), "utf8").trim().split("\n")).toHaveLength(4);
      const held = first.html(DOC);

      const result = c.start().open(DOC, c.file);
      expect(result.recovered).toBe(3);
      expect(result.conflicts).toEqual([]);
      expect(result.html).toBe(held);
    });

    it("replays an undo that was journaled before the crash", () => {
      const c = crashable();
      const first = c.start();
      first.open(DOC, c.file);
      first.mutate(mut(1, TITLE, setText("Hello", "One")));
      first.closeTransaction(DOC, "tx");
      first.mutate(mut(2, CTA, setText("Start", "Two")));
      first.undo(DOC);
      const held = first.html(DOC);

      expect(c.start().open(DOC, c.file).html).toBe(held);
    });

    it("keeps edits made after recovering a torn journal through the next crash", () => {
      const c = crashable();
      const first = c.start();
      first.open(DOC, c.file);
      first.mutate(mut(1, TITLE, setText("Hello", "One")));
      const wal = journalPath(c.journalDir);
      writeFileSync(wal, `${readFileSync(wal, "utf8")}{"operationId":"torn`);

      const second = c.start();
      const reopened = second.open(DOC, c.file);
      expect(reopened.recovered).toBe(1);
      second.mutate(mut(reopened.status.revision, CTA, setText("Start", "Two")));
      const held = second.html(DOC);

      const third = c.start().open(DOC, c.file);
      expect(third.recovered).toBe(2);
      expect(third.html).toBe(held);
    });

    it("doesn't apply a save twice when the crash came before the journal's removal", () => {
      const c = crashable();
      const first = c.start();
      first.open(DOC, c.file);
      const inserted = first.mutate(mut(1, TITLE, { kind: "insert", html: "<em>once</em>", position: "after" }));
      expect(inserted.ok).toBe(true);
      first.mutate(mut(2, CTA, setText("Start", "Two")));
      const wal = journalPath(c.journalDir);
      const walText = readFileSync(wal, "utf8");
      expect(first.flush(DOC)).toBe(true);
      const saved = readFileSync(c.file, "utf8");
      writeFileSync(wal, walText);

      const result = c.start().open(DOC, c.file);
      expect(result.html).toBe(saved);
      expect(result.recovered).toBe(0);
      expect(result.conflicts).toEqual([]);
      expect(result.html.match(/<em/g)).toHaveLength(1);
      expect(existsSync(wal)).toBe(false);
    });

    it("clears a saved redo stack once a replay moves the text past it", () => {
      const c = crashable();
      const first = c.start();
      first.open(DOC, c.file);
      first.mutate(mut(1, TITLE, setText("Hello", "One")));
      first.flush(DOC);
      first.undo(DOC);
      first.flush(DOC);
      expect(first.status(DOC)?.canRedo).toBe(true);
      first.mutate(mut(first.status(DOC)?.revision ?? 0, CTA, setText("Start", "Two")));

      const reopened = c.start().open(DOC, c.file);
      expect(reopened.status.canRedo).toBe(false);
    });
  });

  describe("undo past an outside change", () => {
    const REMOVED = '  <div data-agent-id="card"><p data-agent-id="copy">Body copy</p></div>\n';

    it("restores a removed element where it was, though the outside edit moved every offset", () => {
      const h = harness({ debounceMs: 10_000 });
      opened(h);
      h.service.mutate(mut(1, CARD, { kind: "remove" }));
      h.service.flush(DOC);

      const outside = readFileSync(h.file, "utf8").replace("Studio", "A much longer studio title");
      writeFileSync(h.file, outside);
      h.service.noteDiskChange(DOC);

      const undone = h.service.undo(DOC, { crossBoundary: true });
      expect(undone.ok).toBe(true);
      expect(h.service.html(DOC)).toBe(PAGE.replace("Studio", "A much longer studio title"));
      expect(h.service.status(DOC)?.atExternalBoundary).toBe(false);
    });

    it("refuses an undo whose text the outside edit rewrote, leaving the page alone", () => {
      const h = harness({ debounceMs: 10_000 });
      opened(h);
      h.service.mutate(mut(1, TITLE, setText("Hello", "Mine")));
      h.service.flush(DOC);

      const outside = readFileSync(h.file, "utf8").replace("Mine", "Theirs");
      writeFileSync(h.file, outside);
      h.service.noteDiskChange(DOC);

      expect(h.service.status(DOC)).toMatchObject({ canUndo: false, atExternalBoundary: false });
      expect(h.service.undo(DOC, { crossBoundary: true }).ok).toBe(false);
      expect(h.service.html(DOC)).toBe(outside);
    });

    it("keeps the boundary when crossing it fails to find a group", () => {
      const h = harness({ debounceMs: 10_000 });
      opened(h);
      h.service.mutate(mut(1, CARD, { kind: "remove" }));
      h.service.flush(DOC);
      writeFileSync(h.file, readFileSync(h.file, "utf8").replace("Studio", "Workshop"));
      h.service.noteDiskChange(DOC);

      expect(reasonOf(h.service.undo(DOC))).toBe("external-change");
      expect(h.service.status(DOC)).toMatchObject({ canUndo: true, atExternalBoundary: true });
      expect(h.service.html(DOC)).not.toContain(REMOVED.trim());
    });
  });
});
