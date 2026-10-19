// P5.4: readiness conditions, stale refs and compact observations on the
// visible pane, against a fake CDP; plus collectPage in a real page through
// agent-browser when the CLI is installed.

import { describe, expect, it, vi } from "vitest";
import { AgentBrowserBackend, resolveAgentBrowser } from "../src/main/browser/agent-browser";
import { describeWait, NO_LOGS, NO_NEW_LOGS, staleRefMessage, waitBudget, waitNote, waitScript, waitUntil } from "../src/main/browser/backend";
import { BrowserController, type LogEntry } from "../src/main/browser/controller";
import { collectPage, formatSnapshot, type PageSnapshot } from "../src/main/browser/snapshot";
import { browserTools } from "../src/main/browser/tools";
import { tempDir } from "./helpers";

// The controller imports electron at module load; there is no real one under vitest.
vi.mock("electron", () => ({ webContents: { fromId: () => null } }));

describe("wait helpers", () => {
  it("describes, clamps and scripts a condition", () => {
    expect(describeWait({ url: "/dash", selector: "#ok", text: "Saved" })).toBe('URL contains "/dash" and "#ok" visible and text "Saved"');
    expect(waitBudget({ text: "x" })).toBe(5000);
    expect(waitBudget({ text: "x", timeoutMs: 999_999 })).toBe(30_000);
    const script = waitScript({ url: "/a", text: 'say "hi"' }, 1234);
    expect(script).toContain('location.href.includes("/a")');
    expect(script).toContain('.includes("say \\"hi\\"")');
    expect(script).toContain("Date.now() + 1234");
  });

  it("retries through a navigation and stops at the deadline", async () => {
    const answers: (() => unknown)[] = [() => { throw new Error("Execution context was destroyed."); }, () => true];
    expect((await waitUntil(async () => answers.shift()!(), { text: "x" })).met).toBe(true);
    let t = 0;
    const r = await waitUntil(async () => { t += 3000; return false; }, { text: "x" }, () => t);
    expect(r.met).toBe(false);
  });

  it("notes a met wait briefly and a missed one with where the page is", () => {
    expect(waitNote({ text: "Saved" }, { met: true, ms: 120 }, "http://x/")).toBe('Waited 120 ms for text "Saved".');
    expect(waitNote({ url: "/dash", timeoutMs: 2000 }, { met: false, ms: 2000 }, "http://x/login")).toBe(
      'Waited 2.0 s for URL contains "/dash": not met. Now at http://x/login. Take a browser_snapshot to see the page.',
    );
  });

  it("names a stale ref's likely replacement without picking one", () => {
    expect(staleRefMessage("e3", undefined, [])).toBe("No element e3 on the page. Take a new browser_snapshot; refs change when the page does.");
    const print = { kind: "button", name: "Save" };
    expect(staleRefMessage("e3", print, ["e9"])).toBe('e3 (button "Save") is no longer on the page. The page now has button "Save" as [e9]; use that ref if it\'s the one you meant.');
    expect(staleRefMessage("e3", print, ["e9", "e10"])).toContain("2 matches: [e9], [e10]");
    expect(staleRefMessage("e3", print, [])).toBe('e3 (button "Save") is no longer on the page. Take a new browser_snapshot.');
  });
});

describe("formatSnapshot scope", () => {
  const page: PageSnapshot = { url: "http://x/", title: "T", nodes: [{ kind: "button", ref: "e4", name: "Pay" }], truncated: false };

  it("says when a snapshot is narrowed, and is unchanged otherwise", () => {
    expect(formatSnapshot(page, { selector: "#checkout", interactive: true })).toBe('Page: T\nURL: http://x/\nScope: #checkout\n(interactive elements only)\n\n[e4] button "Pay"');
    expect(formatSnapshot(page)).toBe('Page: T\nURL: http://x/\n\n[e4] button "Pay"');
  });

  it("says when the scope matches nothing", () => {
    expect(formatSnapshot({ ...page, nodes: [], noScope: true }, { selector: "#gone" })).toContain('(nothing on the page matches "#gone")');
  });
});

describe("BrowserController readiness and refs", () => {
  /** A controller over a fake page: `answer` gets each Runtime.evaluate expression and returns its value. */
  function make(answer: (expression: string) => unknown) {
    const expressions: string[] = [];
    const wc = {
      isDestroyed: () => false,
      isLoading: () => false,
      getURL: () => "http://x/after",
      debugger: {
        sendCommand: async (m: string, p?: { expression?: string }) => {
          if (m !== "Runtime.evaluate") return {};
          expressions.push(p!.expression!);
          return { result: { value: answer(p!.expression!) } };
        },
      },
    };
    const controller = new BrowserController(() => {}, tempDir());
    (controller as unknown as { wc: unknown }).wc = wc;
    return { controller, expressions };
  }
  const located = { x: 1, y: 2, label: "Save" };
  const isLocate = (e: string) => e.includes("scrollIntoView");
  const isCollect = (e: string) => e.startsWith("(function collectPage") || e.includes("collectPage");

  it("waits on the agent's condition instead of the fixed pause", async () => {
    const { controller, expressions } = make((e) => (isLocate(e) ? located : e.includes("new Promise((done)") ? true : undefined));
    const started = Date.now();
    const text = await controller.click("e1", { text: "Saved" });
    expect(Date.now() - started).toBeLessThan(200);
    expect(text).toMatch(/^Clicked e1 \("Save"\)\. Now at http:\/\/x\/after\nWaited \d+ ms for text "Saved"\.$/);
    expect(expressions.some((e) => e.includes('.includes("Saved")'))).toBe(true);
  });

  it("keeps the old settle and result text without a condition", async () => {
    const { controller } = make((e) => (isLocate(e) ? located : undefined));
    const started = Date.now();
    expect(await controller.click("e1")).toBe('Clicked e1 ("Save"). Now at http://x/after');
    expect(Date.now() - started).toBeGreaterThanOrEqual(240);
  });

  it("carries the ref counter on between snapshots", async () => {
    const snaps: PageSnapshot[] = [
      { url: "u", title: "t", nodes: [{ kind: "button", ref: "e1", name: "Save" }], truncated: false, next: 2 },
      { url: "u", title: "t", nodes: [{ kind: "button", ref: "e2", name: "Save" }], truncated: false, next: 3 },
    ];
    const { controller, expressions } = make((e) => (isCollect(e) ? snaps.shift() : undefined));
    await controller.snapshot();
    await controller.snapshot({ selector: "main", interactive: true });
    const calls = expressions.filter(isCollect);
    expect(calls[0]).toMatch(/\)\(400, 1, null, false\)$/);
    expect(calls[1]).toMatch(/\)\(400, 2, "main", true\)$/);
  });

  it("names the replacement of a ref that went stale, through the tool, without clicking", async () => {
    const snaps: PageSnapshot[] = [
      { url: "u", title: "t", nodes: [{ kind: "button", ref: "e1", name: "Save" }, { kind: "link", ref: "e2", name: "Home" }], truncated: false, next: 3 },
      { url: "u", title: "t", nodes: [{ kind: "button", ref: "e3", name: "Save" }, { kind: "link", ref: "e2", name: "Home" }], truncated: false, next: 4 },
    ];
    const { controller, expressions } = make((e) => (isCollect(e) ? snaps.shift() : isLocate(e) ? null : undefined));
    vi.spyOn(controller, "ensureOpen").mockResolvedValue();
    await controller.snapshot();
    const click = browserTools(controller).find((t) => t.name === "browser_click")!;
    const out = await click.run({ ref: "e1" });
    expect(out).toEqual({ text: 'e1 (button "Save") is no longer on the page. The page now has button "Save" as [e3]; use that ref if it\'s the one you meant.', isError: true });
    expect(expressions.filter(isCollect)).toHaveLength(2);
  });

  it("reports a ref it never handed out the old way, and a hidden one as hidden", async () => {
    const { controller } = make((e) => (isLocate(e) ? null : undefined));
    await expect(controller.click("e8")).rejects.toThrow("No element e8 on the page. Take a new browser_snapshot; refs change when the page does.");
    const hidden = make((e) => (isLocate(e) ? { ...located, hidden: true } : undefined));
    await expect(hidden.controller.click("e8")).rejects.toThrow("e8 is on the page but hidden now.");
  });

  it("reads only new log lines when asked, across a full buffer", async () => {
    const { controller } = make(() => undefined);
    const push = (text: string) => (controller as unknown as { push(e: LogEntry): void }).push({ level: "error", text });
    expect(await controller.readLogs(false, true)).toBe(NO_NEW_LOGS);
    push("a");
    expect(await controller.readLogs(false, true)).toBe("[error] a");
    expect(await controller.readLogs(false, true)).toBe(NO_NEW_LOGS);
    expect(await controller.readLogs(false)).toBe("[error] a");
    for (let i = 0; i < 250; i++) push(`n${i}`);
    const fresh = (await controller.readLogs(false, true)).split("\n");
    expect(fresh).toHaveLength(200);
    expect(fresh.at(-1)).toBe("[error] n249");
    push("last");
    expect(await controller.readLogs(false, true)).toBe("[error] last");
    expect(await controller.readLogs(true)).toContain("[error] last");
    expect(await controller.readLogs(false)).toBe(NO_LOGS);
  });
});

const cli = resolveAgentBrowser();

describe.skipIf(!cli || process.platform === "win32")("collectPage in a real page (agent-browser)", () => {
  it("keeps refs across snapshots, never reuses one, scopes, and waits for delayed text", { timeout: 90_000 }, async () => {
    const b = new AgentBrowserBackend({ session: `cubiq-p54-${process.pid}`, screenshotDir: tempDir() });
    const collect = async (startAt: number, scope: string | null = null, interactive = false) =>
      JSON.parse(await b.evaluate(`(${collectPage.toString()})(400, ${startAt}, ${JSON.stringify(scope)}, ${interactive})`)) as PageSnapshot;
    try {
      await b.open(
        "data:text/html,<title>T</title><h1>Hi</h1><main><button id=a>One</button><button id=b>Two</button></main><footer><a href=/x>Link</a></footer>" +
          "<script>setTimeout(()=>document.body.insertAdjacentHTML('beforeend','<p>Saved</p>'),400)</script>",
      );
      const first = await collect(1);
      expect(first.nodes.filter((n) => n.ref).map((n) => [n.ref, n.name])).toEqual([["e1", "One"], ["e2", "Two"], ["e3", "Link"]]);
      // Replace One: Two and Link keep their refs; the new One gets a fresh number.
      await b.evaluate("document.getElementById('a').replaceWith(Object.assign(document.createElement('button'), { textContent: 'One' }))");
      const second = await collect(first.next!);
      expect(second.nodes.filter((n) => n.ref).map((n) => [n.ref, n.name])).toEqual([["e4", "One"], ["e2", "Two"], ["e3", "Link"]]);
      const scoped = await collect(second.next!, "main", true);
      expect(scoped.nodes.map((n) => n.name)).toEqual(["One", "Two"]);
      expect((await collect(second.next!, "#nope")).noScope).toBe(true);
      // The wait script, as the pane runs it, on delayed content.
      expect(await waitUntil((e) => b.evaluate(e), { text: "Saved", timeoutMs: 5000 })).toMatchObject({ met: true });
    } finally {
      await b.close();
    }
  });
});
