// The headless browser backend: argument shapes and text against a fake CLI
// (responses copied from agent-browser 0.27), plus one real session when the
// CLI is installed.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentBrowserBackend, formatHeadlessSnapshot, parseVersion, resolveAgentBrowser, supported, type RunCli } from "../src/main/browser/agent-browser";
import { NO_NEW_LOGS } from "../src/main/browser/backend";
import { browserTools } from "../src/main/browser/tools";
import { runs, tempDir } from "./helpers";

const ok = (data: unknown) => ({ code: 0, stdout: `${JSON.stringify({ success: true, data, error: null })}\n`, stderr: "" });
const fail = (error: string) => ({ code: 1, stdout: `${JSON.stringify({ success: false, data: null, error })}\n`, stderr: "" });

const SNAPSHOT = {
  origin: "http://x/",
  refs: { e2: { name: "Go", role: "button" }, e1: { name: "hi", role: "heading" }, e3: { name: "name", role: "textbox" } },
  snapshot: '- heading "hi" [level=1, ref=e1]\n- button "Go" [ref=e2]\n- textbox "name" [ref=e3]',
};

const REFS = {
  origin: "http://x/",
  refs: { e7: { name: "Go", role: "button" }, e3: { name: "name", role: "textbox" } },
  snapshot: '- button "Go" [ref=e7]\n- textbox "name" [ref=e3]',
};

/** A fake CLI: records argument lists and answers from a table keyed by the command word. */
function fake(answers: Record<string, ReturnType<typeof ok>>, version = "agent-browser 0.27.0") {
  const calls: string[][] = [];
  const run: RunCli = async (args) => {
    calls.push(args);
    if (args[0] === "--version") return { code: 0, stdout: `${version}\n`, stderr: "" };
    const word = args.slice(3).join(" ");
    const key = Object.keys(answers).find((k) => word === k || word.startsWith(`${k} `)) ?? args[3]!;
    return answers[key] ?? ok({});
  };
  return { run, calls };
}

const backend = (run: RunCli) => new AgentBrowserBackend({ session: "job-1", screenshotDir: tempDir(), run });

describe("agent-browser backend", () => {
  it("puts the session and --json first on every call", async () => {
    const f = fake({ open: ok({ title: "T", url: "http://x/" }) });
    await backend(f.run).open("http://x/");
    expect(f.calls.at(-1)).toEqual(["--session", "job-1", "--json", "open", "http://x/"]);
  });

  it("formats a snapshot in the visible pane's shape, refs in order", async () => {
    const f = fake({ snapshot: ok(SNAPSHOT), "get title": ok({ title: "T1" }) });
    expect(await backend(f.run).snapshot()).toBe('Page: T1\nURL: http://x/\n[e1] heading "hi"\n[e2] button "Go"\n[e3] textbox "name"');
    expect(formatHeadlessSnapshot({ refs: {}, snapshot: "" }, "", "u")).toContain("(no visible content)");
  });

  it("accepts e7 and @e7 and reports the URL after acting", async () => {
    const f = fake({ snapshot: ok(REFS), "get url": ok({ url: "http://x/next" }) });
    const b = backend(f.run);
    await b.snapshot();
    expect(await b.click("e7")).toBe("Clicked e7. Now at http://x/next");
    expect(await b.click("@e7")).toBe("Clicked e7. Now at http://x/next");
    expect(f.calls.filter((c) => c[3] === "click").map((c) => c[4])).toEqual(["@e7", "@e7"]);
    expect(await b.type("e3", "Ada", true)).toBe("Typed into e3 and pressed Enter. Now at http://x/next");
    expect(f.calls.some((c) => c[3] === "fill" && c[4] === "@e3" && c[5] === "Ada")).toBe(true);
    expect(f.calls.some((c) => c[3] === "press" && c[4] === "Enter")).toBe(true);
  });

  it("hands out fresh refs each snapshot, and a stale one names its same-kind-and-name replacement", async () => {
    const f = fake({ snapshot: ok(SNAPSHOT), "get url": ok({ url: "http://x/next" }) });
    const b = backend(f.run);
    expect(await b.snapshot()).toContain('[e2] button "Go"');
    const again = await b.snapshot();
    expect(again).toContain('[e4] heading "hi"');
    expect(again).toContain('[e5] button "Go"');
    expect(again).toContain('[e6] textbox "name"');
    // The stale ref looks at the page afresh (a third snapshot, e7…e9) and names the match there.
    await expect(b.click("e2")).rejects.toThrow('The page now has button "Go" as [e8]');
    expect(f.calls.some((c) => c[3] === "click")).toBe(false);
    await expect(b.click("e5")).rejects.toThrow("is no longer on the page");
    expect(await b.click("e11")).toBe("Clicked e11. Now at http://x/next");
    expect(f.calls.filter((c) => c[3] === "click").map((c) => c[4])).toEqual(["@e2"]);
  });

  it("refuses a ref it never handed out with the no-print message", async () => {
    await expect(backend(fake({}).run).click("e99")).rejects.toThrow("No element e99 on the page");
  });

  it("narrows a snapshot to a selector and to interactive elements", async () => {
    const f = fake({ snapshot: ok(SNAPSHOT) });
    const text = await backend(f.run).snapshot({ selector: "#main", interactive: true });
    expect(f.calls.find((c) => c[3] === "snapshot")).toEqual(["--session", "job-1", "--json", "snapshot", "-i", "-s", "#main"]);
    expect(text).toContain("Scope: #main");
    expect(text).toContain("(interactive elements only)");
  });

  it("waits after an action when asked, and reports it", async () => {
    const met = fake({ snapshot: ok(SNAPSHOT), "get url": ok({ url: "http://x/next" }), eval: ok({ result: true }) });
    const b1 = backend(met.run);
    await b1.snapshot();
    const out = await b1.click("e2", { text: "Saved" });
    expect(out).toContain("Waited");
    expect(out).toContain('for text "Saved".');

    const missed = fake({ snapshot: ok(SNAPSHOT), "get url": ok({ url: "http://x/next" }), eval: ok({ result: false }) });
    const b2 = backend(missed.run);
    await b2.snapshot();
    expect(await b2.click("e2", { text: "Saved", timeoutMs: 100 })).toContain(": not met. Now at");
  });

  it("returns eval results as text, JSON for objects", async () => {
    const f = fake({ "eval 1": ok({ origin: "x", result: "Ada" }), "eval 2": ok({ origin: "x", result: { a: 1 } }) });
    const b = backend(f.run);
    expect(await b.evaluate("1")).toBe("Ada");
    expect(JSON.parse(await b.evaluate("2"))).toEqual({ a: 1 });
  });

  it("reports console errors and warnings like the pane, and says so when there are none", async () => {
    const withLogs = fake({ console: ok({ messages: [{ text: "boom", type: "error" }, { text: "careful", type: "warning" }, { text: "hi", type: "log" }] }), errors: ok({ errors: [] }) });
    expect(await backend(withLogs.run).logs(false)).toBe("[error] boom\n[warning] careful");
    const quiet = fake({ console: ok({ messages: [] }), errors: ok({ errors: [] }) });
    expect(await backend(quiet.run).logs(true)).toMatch(/^No console errors/);
    expect(quiet.calls.find((c) => c[3] === "console")).toContain("--clear");
  });

  it("returns only logs since the last read with newOnly", async () => {
    const f = fake({ console: ok({ messages: [{ text: "boom", type: "error" }] }), errors: ok({ errors: [] }) });
    const b = backend(f.run);
    expect(await b.logs(false)).toBe("[error] boom");
    expect(await b.logs(false, true)).toBe(NO_NEW_LOGS);
  });

  it("surfaces the CLI's error, and the tools turn it into an error result", async () => {
    const f = fake({ snapshot: ok(SNAPSHOT), "get url": ok({ url: "http://x/" }), click: fail("Unknown ref: e9") });
    const b = backend(f.run);
    await b.snapshot();
    await expect(b.click("e2")).rejects.toThrow("Unknown ref: e9");
    const click = browserTools(b).find((t) => t.name === "browser_click")!;
    expect(await click.run({ ref: "e2" })).toEqual({ text: "Unknown ref: e9", isError: true });
  });

  it("refuses a CLI version it doesn't speak", async () => {
    expect(parseVersion("agent-browser 0.27.0")).toBe("0.27.0");
    expect(supported("0.27.0")).toBe(true);
    expect(supported("0.39.1")).toBe(true);
    expect(supported("0.26.9")).toBe(false);
    expect(supported("1.0.0")).toBe(false);
    expect(supported(null)).toBe(false);
    const f = fake({}, "agent-browser 0.20.0");
    await expect(backend(f.run).open("http://x/")).rejects.toThrow(/isn't supported/);
  });

  it("finds the Windows exe under the npm prefix, or nothing", () => {
    expect(resolveAgentBrowser({}, "win32")).toBeNull();
    expect(resolveAgentBrowser({ APPDATA: join(tempDir(), "none") }, "win32")).toBeNull();
    expect(resolveAgentBrowser({}, "linux")).toBe("agent-browser");
  });
});

const installed = resolveAgentBrowser();

describe.skipIf(!runs(installed) || (process.platform === "win32" && !existsSync(installed!)))("agent-browser backend, real session", () => {
  it("opens a page, clicks, fills and reads it back, then closes", { timeout: 90_000 }, async () => {
    const b = new AgentBrowserBackend({ session: `cubiq-test-${process.pid}`, screenshotDir: tempDir() });
    try {
      await b.open("data:text/html,<title>T</title><button onclick=\"document.title='clicked'\">Go</button><input placeholder=name>");
      const snap = await b.snapshot();
      expect(snap).toContain('button "Go"');
      const button = /\[(e\d+)\] button "Go"/.exec(snap)![1]!;
      // A second snapshot renumbers the CLI refs; ours move on, so the old ref is refused.
      const again = await b.snapshot();
      const button2 = /\[(e\d+)\] button "Go"/.exec(again)![1]!;
      expect(button2).not.toBe(button);
      // The old ref is refused with the match on the page as it is now, which the agent then uses.
      const stale = await b.click(button).then(() => "", (err: Error) => err.message);
      expect(stale).toContain("is no longer on the page");
      const button3 = /as \[(e\d+)\]/.exec(stale)![1]!;
      await b.click(button3);
      const field = /\[(e\d+)\] textbox/.exec(await b.snapshot())![1]!;
      expect(await b.evaluate("document.title")).toBe("clicked");
      await b.type(field, "Ada", false);
      expect(await b.evaluate("document.querySelector('input').value")).toBe("Ada");
      const shot = await b.screenshot();
      expect(shot.png.length).toBeGreaterThan(100);
    } finally {
      await b.close();
    }
  });
});

describe("browser target ownership (P5.3)", () => {
  it("runs page-changing calls one at a time, in order", async () => {
    const { TargetLock } = await import("../src/main/browser/tools");
    const lock = new TargetLock();
    const order: string[] = [];
    const step = (name: string, ms: number) => lock.run("t1", async () => {
      order.push(`${name}+`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`${name}-`);
    });
    await Promise.all([step("a", 30), step("b", 1), step("c", 1)]);
    expect(order).toEqual(["a+", "a-", "b+", "b-", "c+", "c-"]);
  });

  it("refuses another thread's action while the owner's turn runs, and hands over once it ends", async () => {
    const { TargetLock } = await import("../src/main/browser/tools");
    const running = new Set(["t1"]);
    const lock = new TargetLock((id) => running.has(id));
    await lock.run("t1", async () => {});
    await expect(lock.run("t2", async () => {})).rejects.toThrow(/in use by another thread/);
    expect(lock.current).toBe("t1");
    running.delete("t1");
    await lock.run("t2", async () => {});
    expect(lock.current).toBe("t2");
  });

  it("a failed action doesn't block the queue", async () => {
    const { TargetLock } = await import("../src/main/browser/tools");
    const lock = new TargetLock();
    await expect(lock.run("t1", async () => { throw new Error("x"); })).rejects.toThrow("x");
    await expect(lock.run("t1", async () => "ok")).resolves.toBe("ok");
  });

  it("browser_click from another thread is refused as a tool error; reads still work", async () => {
    const f = fake({ "get url": ok({ url: "http://x/" }), snapshot: ok(SNAPSHOT), "get title": ok({ title: "T" }) });
    const tools = browserTools(backend(f.run), { busy: (id) => id === "owner" });
    const click = tools.find((t) => t.name === "browser_click")!;
    const snapshot = tools.find((t) => t.name === "browser_snapshot")!;
    expect((await snapshot.run({}, { threadId: "owner" })).text).toContain('[e2] button "Go"');
    expect((await click.run({ ref: "e2" }, { threadId: "owner" })).isError).toBeUndefined();
    expect(await click.run({ ref: "e2" }, { threadId: "other" })).toMatchObject({ isError: true, text: expect.stringContaining("in use by another thread") });
    expect((await snapshot.run({}, { threadId: "other" })).text).toContain('[e5] button "Go"');
  });
});
