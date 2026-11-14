import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesignDocuments, parseDesignMutation, parseHistoryRequest } from "../src/main/design/documents";
import { DocumentMutationService, documentIdOf } from "../src/main/design/mutation";
import type { DesignMutation } from "../src/shared/design-mutation";
import { closeAfter, tempDir } from "./helpers";

const PAGE =
  '<!DOCTYPE html><html><head><title>T</title></head><body><h1 data-agent-id="title">Hello</h1><p data-agent-id="copy">Body</p></body></html>';

const THREAD = "t1";
const REL = "index.html";
const DOC = documentIdOf(THREAD, REL);

/** A minimal valid mutation, then the field under test laid over it. */
function mutation(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    operationId: "op-1",
    documentId: DOC,
    baseRevision: 1,
    target: { id: "title" },
    transactionId: "tx",
    change: { kind: "setText", before: "Hello", after: "Hi" },
    ...over,
  };
}

function setText(before: string, after: string, extra: Partial<DesignMutation> = {}): DesignMutation {
  return {
    operationId: `op-${Math.random().toString(16).slice(2)}`,
    documentId: DOC,
    baseRevision: 1,
    target: { id: "title" },
    transactionId: "tx",
    change: { kind: "setText", before, after },
    ...extra,
  };
}

interface Harness {
  docs: DesignDocuments;
  dir: string;
  file: string;
  beforeFirstOpen: ReturnType<typeof vi.fn>;
  busy: { value: boolean };
}

function harness(over: { debounceMs?: number; onSaved?: (threadId: string, rel: string) => void } = {}): Harness {
  const dir = tempDir();
  const file = join(dir, REL);
  writeFileSync(file, PAGE);
  const busy = { value: false };
  const beforeFirstOpen = vi.fn();
  const docs = new DesignDocuments({
    journalDir: join(dir, "journal"),
    debounceMs: over.debounceMs ?? 10_000,
    isBusy: () => busy.value,
    beforeFirstOpen,
    ...(over.onSaved ? { onSaved: over.onSaved } : {}),
  });
  closeAfter(() => docs.dispose());
  return { docs, dir, file, beforeFirstOpen, busy };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseDesignMutation", () => {
  it("accepts one mutation of each kind and keeps only the known fields", () => {
    const valid: DesignMutation[] = [
      { operationId: "op-1", documentId: DOC, baseRevision: 1, target: { id: "title" }, transactionId: "tx", change: { kind: "setProp", name: "class", value: "big" } },
      { operationId: "op-2", documentId: DOC, baseRevision: 1, target: { id: "title" }, transactionId: "tx", change: { kind: "setStyle", changes: [{ prop: "color", value: "red" }] } },
      { operationId: "op-3", documentId: DOC, baseRevision: 1, target: { id: "title" }, transactionId: "tx", change: { kind: "setText", before: "Hello", after: "Hi" } },
      { operationId: "op-4", documentId: DOC, baseRevision: 1, target: { id: "copy" }, transactionId: "tx", change: { kind: "insert", html: "<b>x</b>", position: "after" } },
      { operationId: "op-5", documentId: DOC, baseRevision: 1, target: { id: "copy" }, transactionId: "tx", change: { kind: "remove" } },
      { operationId: "op-6", documentId: DOC, baseRevision: 1, target: { id: "copy" }, transactionId: "tx", change: { kind: "move", refId: "title", position: "before" } },
      { operationId: "op-7", documentId: DOC, baseRevision: 1, target: { id: "copy" }, transactionId: "tx", change: { kind: "wrap", extraIds: ["title"], tag: "section", attrs: { class: "row" } } },
      { operationId: "op-8", documentId: DOC, baseRevision: 1, target: { locator: { tag: "h1", path: [1, 0], text: "Hello" } }, transactionId: "tx", change: { kind: "unwrap" } },
      { operationId: "op-9", documentId: DOC, baseRevision: 1, target: { id: "title" }, transactionId: "tx", change: { kind: "retag", tag: "h2" } },
      { operationId: "op-10", documentId: DOC, baseRevision: 1, target: { id: "title" }, transactionId: "tx", change: { kind: "setStyle", changes: [{ prop: "padding", value: "8px" }], at: "mobile" } },
    ];
    for (const each of valid) expect(parseDesignMutation(each)).toEqual(each);
  });

  it("drops an unknown top-level field", () => {
    const parsed = parseDesignMutation({ ...mutation(), extra: true });
    expect(parsed).not.toBeNull();
    expect(parsed).not.toHaveProperty("extra");
  });

  it("returns null for anything malformed", () => {
    const cases: unknown[] = [
      "nope",
      null,
      mutation({ operationId: "" }),
      mutation({ baseRevision: 1.5 }),
      { ...mutation(), target: { id: "title", locator: { tag: "h1", path: [] } } },
      mutation({ target: { locator: { tag: "h1", path: [-1] } } }),
      mutation({ change: { kind: "setStyle", changes: [] } }),
      mutation({ change: { kind: "setStyle", changes: Array.from({ length: 33 }, () => ({ prop: "color", value: "red" })) } }),
      mutation({ change: { kind: "insert", html: "<b>x</b>", position: "middle" } }),
      mutation({ change: { kind: "insert", html: "x".repeat(1_000_001), position: "after" } }),
      mutation({ change: { kind: "wrap", extraIds: [], tag: "div", attrs: { class: 1 } } }),
      mutation({ change: { kind: "shout" } }),
      mutation({ change: { kind: "retag", tag: "script" } }),
      mutation({ change: { kind: "setStyle", changes: [{ prop: "color", value: "red" }], at: "wide" } }),
    ];
    for (const each of cases) expect(parseDesignMutation(each)).toBeNull();
  });
});

describe("parseHistoryRequest", () => {
  it("accepts the four shapes", () => {
    expect(parseHistoryRequest({ action: "status" })).toEqual({ action: "status" });
    expect(parseHistoryRequest({ action: "undo" })).toEqual({ action: "undo" });
    expect(parseHistoryRequest({ action: "undo", crossBoundary: true })).toEqual({ action: "undo", crossBoundary: true });
    expect(parseHistoryRequest({ action: "redo" })).toEqual({ action: "redo" });
    expect(parseHistoryRequest({ action: "close-transaction", transactionId: "tx" })).toEqual({
      action: "close-transaction",
      transactionId: "tx",
    });
  });

  it("refuses anything else", () => {
    expect(parseHistoryRequest({ action: "flip" })).toBeNull();
    expect(parseHistoryRequest({ action: "undo", crossBoundary: "yes" })).toBeNull();
    expect(parseHistoryRequest({ action: "close-transaction", transactionId: "" })).toBeNull();
    expect(parseHistoryRequest(7)).toBeNull();
  });
});

describe("DesignDocuments", () => {
  it("refuses a mutation addressed to another page without opening anything", () => {
    const h = harness();
    const result = h.docs.mutate(THREAD, REL, h.file, setText("Hello", "Hi", { documentId: "someone-else" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid");
    expect(h.beforeFirstOpen).not.toHaveBeenCalled();
  });

  it("applies a setText through ensure and reports it in the status", () => {
    const h = harness();
    const result = h.docs.mutate(THREAD, REL, h.file, setText("Hello", "Hi"));
    expect(result.ok).toBe(true);

    const status = h.docs.history(THREAD, REL, h.file, { action: "status" });
    expect(status.status.revision).toBe(2);
    expect(status.html).toContain("Hi");
    expect(status.html).not.toContain(">Hello<");
  });

  it("runs beforeFirstOpen once and lets it read the file's original text", () => {
    const h = harness();
    h.beforeFirstOpen.mockImplementation((_thread: string, rel: string) => {
      expect(readFileSync(join(h.dir, rel), "utf8")).toBe(PAGE);
    });
    h.docs.mutate(THREAD, REL, h.file, setText("Hello", "Hi"));
    h.docs.mutate(THREAD, REL, h.file, setText("Hi", "Hey"));
    expect(h.beforeFirstOpen).toHaveBeenCalledTimes(1);
    expect(h.beforeFirstOpen).toHaveBeenCalledWith(THREAD, REL);
  });

  it("opens read-only while the thread is busy, and follows setBusy", () => {
    const h = harness();
    h.busy.value = true;
    const refused = h.docs.mutate(THREAD, REL, h.file, setText("Hello", "Hi"));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe("read-only");

    h.docs.setBusy(THREAD, false);
    const accepted = h.docs.mutate(THREAD, REL, h.file, setText("Hello", "Hi"));
    expect(accepted.ok).toBe(true);

    h.docs.setBusy(THREAD, true);
    const again = h.docs.mutate(THREAD, REL, h.file, setText("Hi", "Hey"));
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toBe("read-only");
  });

  it("sees an outside write before mutating, even with no diskChanged call", () => {
    const h = harness();
    h.docs.mutate(THREAD, REL, h.file, setText("Hello", "Hi"));
    writeFileSync(h.file, PAGE.replace("Hello", "Howdy"));

    const result = h.docs.mutate(THREAD, REL, h.file, setText("Hello", "Hi", { baseRevision: 1 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("external-change");
  });

  it("adopts the outside text for a matching path and for null, but not an unrelated one", () => {
    const h = harness();
    h.docs.history(THREAD, REL, h.file, { action: "status" });
    // history() re-checks the disk itself, so only the service's own call shows what diskChanged did.
    const noted = vi.spyOn(DocumentMutationService.prototype, "noteDiskChange");

    writeFileSync(h.file, PAGE.replace("Hello", "Howdy"));
    h.docs.diskChanged(THREAD, ["other.html"]);
    h.docs.diskChanged("another-thread", null);
    expect(noted).not.toHaveBeenCalled();

    h.docs.diskChanged(THREAD, [REL]);
    expect(noted).toHaveBeenCalledTimes(1);
    expect(h.docs.history(THREAD, REL, h.file, { action: "status" }).html).toContain("Howdy");

    writeFileSync(h.file, PAGE.replace("Hello", "Yo"));
    h.docs.diskChanged(THREAD, null);
    expect(h.docs.history(THREAD, REL, h.file, { action: "status" }).html).toContain("Yo");
  });

  it("delivers conflicts once", () => {
    const h = harness();
    const changed = setText("Body", "Words", { target: { id: "copy" } });
    expect(h.docs.mutate(THREAD, REL, h.file, changed).ok).toBe(true);
    writeFileSync(h.file, PAGE.replace('<p data-agent-id="copy">Body</p>', ""));

    h.docs.diskChanged(THREAD, null);
    expect(h.docs.history(THREAD, REL, h.file, { action: "status" }).conflicts).toHaveLength(1);
    expect(h.docs.history(THREAD, REL, h.file, { action: "status" }).conflicts).toHaveLength(0);
  });

  it("keeps a throwing onSaved from escaping", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = harness({
      onSaved: () => {
        throw new Error("no");
      },
    });
    h.docs.mutate(THREAD, REL, h.file, setText("Hello", "Hi"));
    // Dispose saves, which is where onSaved runs.
    expect(() => h.docs.dispose()).not.toThrow();
    expect(readFileSync(h.file, "utf8")).toContain(">Hi<");
    expect(spy).toHaveBeenCalled();
  });
});
