// The headless browser backend: argument shapes and text against a fake CLI
// (responses copied from agent-browser 0.27), plus one real session when the
// CLI is installed.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentBrowserBackend, formatHeadlessSnapshot, parseVersion, resolveAgentBrowser, supported, type RunCli } from "../src/main/browser/agent-browser";
import { browserTools } from "../src/main/browser/tools";
import { tempDir } from "./helpers";

const ok = (data: unknown) => ({ code: 0, stdout: `${JSON.stringify({ success: true, data, error: null })}\n`, stderr: "" });
const fail = (error: string) => ({ code: 1, stdout: `${JSON.stringify({ success: false, data: null, error })}\n`, stderr: "" });

const SNAPSHOT = {
  origin: "http://x/",
  refs: { e2: { name: "Go", role: "button" }, e1: { name: "hi", role: "heading" }, e3: { name: "name", role: "textbox" } },
  snapshot: '- heading "hi" [level=1, ref=e1]\n- button "Go" [ref=e2]\n- textbox "name" [ref=e3]',
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
    const f = fake({ "get url": ok({ url: "http://x/next" }) });
    const b = backend(f.run);
    expect(await b.click("e7")).toBe("Clicked e7. Now at http://x/next");
    expect(await b.click("@e7")).toBe("Clicked e7. Now at http://x/next");
    expect(f.calls.filter((c) => c[3] === "click").map((c) => c[4])).toEqual(["@e7", "@e7"]);
    expect(await b.type("e3", "Ada", true)).toBe("Typed into e3 and pressed Enter. Now at http://x/next");
    expect(f.calls.some((c) => c[3] === "fill" && c[4] === "@e3" && c[5] === "Ada")).toBe(true);
    expect(f.calls.some((c) => c[3] === "press" && c[4] === "Enter")).toBe(true);
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

  it("surfaces the CLI's error, and the tools turn it into an error result", async () => {
    const f = fake({ click: fail("Unknown ref: e9") });
    await expect(backend(f.run).click("e9")).rejects.toThrow("Unknown ref: e9");
    const click = browserTools(backend(f.run)).find((t) => t.name === "browser_click")!;
    expect(await click.run({ ref: "e9" })).toEqual({ text: "Unknown ref: e9", isError: true });
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

const installed = process.platform === "win32" ? resolveAgentBrowser() : null;

describe.skipIf(!installed || !existsSync(installed))("agent-browser backend, real session", () => {
  it("opens a page, clicks, fills and reads it back, then closes", { timeout: 90_000 }, async () => {
    const b = new AgentBrowserBackend({ session: `cubiq-test-${process.pid}`, screenshotDir: tempDir() });
    try {
      await b.open("data:text/html,<title>T</title><button onclick=\"document.title='clicked'\">Go</button><input placeholder=name>");
      const snap = await b.snapshot();
      expect(snap).toContain('button "Go"');
      const button = /\[(e\d+)\] button "Go"/.exec(snap)![1]!;
      const field = /\[(e\d+)\] textbox/.exec(snap)![1]!;
      await b.click(button);
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
