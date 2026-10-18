import { describe, expect, it, vi } from "vitest";
import { formatSnapshot } from "../src/main/browser/snapshot";
import { browserTools } from "../src/main/browser/tools";
import { isAllowedUrl, normalizeUrl } from "../src/main/browser/url";
import { BrowserController, type LogEntry } from "../src/main/browser/controller";
import { tempDir } from "./helpers";

// The controller imports electron at module load; there is no real one under vitest.
vi.mock("electron", () => ({ webContents: { fromId: () => null } }));

describe("browser urls", () => {
  it("adds a scheme the way an address bar does", () => {
    expect(normalizeUrl("localhost:3000/login")).toBe("http://localhost:3000/login");
    expect(normalizeUrl("127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    expect(normalizeUrl("example.com")).toBe("https://example.com");
    expect(normalizeUrl("https://example.com/x")).toBe("https://example.com/x");
  });

  it("only allows web, file, and data pages", () => {
    expect(isAllowedUrl("http://localhost:3000")).toBe(true);
    expect(isAllowedUrl("about:blank")).toBe(true);
    expect(isAllowedUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedUrl("chrome://settings")).toBe(false);
    expect(isAllowedUrl("not a url")).toBe(false);
  });
});

describe("formatSnapshot", () => {
  it("renders refs, values, and states compactly", () => {
    const text = formatSnapshot({
      url: "http://localhost:3000/login",
      title: "Sign in",
      truncated: false,
      nodes: [
        { kind: "heading", level: 1, name: "Sign in" },
        { kind: "input", ref: "e1", name: "Email", value: "ada@example.com" },
        { kind: "checkbox", ref: "e2", name: "Remember me", checked: false },
        { kind: "button", ref: "e3", name: "Continue", disabled: true },
        { kind: "link", ref: "e4", name: "Forgot password?", href: "/reset" },
        { kind: "text", name: "Too many attempts. Try again in a minute." },
      ],
    });
    expect(text).toBe(
      [
        "Page: Sign in",
        "URL: http://localhost:3000/login",
        "",
        "# Sign in",
        '[e1] input "Email" = "ada@example.com"',
        '[e2] checkbox "Remember me" (unchecked)',
        '[e3] button "Continue" (disabled)',
        '[e4] link "Forgot password?" -> /reset',
        "Too many attempts. Try again in a minute.",
      ].join("\n"),
    );
  });

  it("says when a page is empty or cut short", () => {
    expect(formatSnapshot({ url: "about:blank", title: "", nodes: [], truncated: false })).toContain("(no visible content)");
    expect(formatSnapshot({ url: "x", title: "t", nodes: [{ kind: "text", name: "a" }], truncated: true })).toContain("snapshot truncated");
  });
});

describe("browser tools gate", () => {
  const args: Record<string, unknown> = { url: "http://x", ref: "e1", text: "a", expression: "1" };

  it("offers exactly the seven named tools", () => {
    const tools = browserTools({ enabled: false } as unknown as BrowserController);
    expect(tools.map((t) => t.name)).toEqual([
      "browser_open",
      "browser_snapshot",
      "browser_click",
      "browser_type",
      "browser_eval",
      "browser_logs",
      "browser_screenshot",
    ]);
  });

  it("reports a pane that never opens for every tool", async () => {
    const requestOpen = vi.fn();
    const browser = new BrowserController(requestOpen, tempDir(), () => {}, {}, { openTimeoutMs: 50 });
    for (const tool of browserTools(browser)) {
      const out = await tool.run(args);
      expect(out.isError).toBe(true);
      expect(out.text).toContain("Couldn't open the browser pane");
    }
    expect(requestOpen).toHaveBeenCalledTimes(7);
  });

  it("opens the pane before running the tool body", async () => {
    const browser = new BrowserController(() => {}, tempDir(), () => {}, {}, { openTimeoutMs: 50 });
    const ensureOpen = vi.spyOn(browser, "ensureOpen").mockResolvedValue();
    const snapshot = vi.spyOn(browser, "snapshot").mockResolvedValue("page text");
    const tool = browserTools(browser).find((t) => t.name === "browser_snapshot")!;
    expect(await tool.run({})).toEqual({ text: "page text" });
    expect(ensureOpen).toHaveBeenCalled();
    expect(ensureOpen.mock.invocationCallOrder[0]!).toBeLessThan(snapshot.mock.invocationCallOrder[0]!);
  });
});

describe("describePick", () => {
  it("gives the agent the selector, text, HTML, and screenshot path", async () => {
    const { describePick } = await import("../src/main/browser/picker");
    const text = describePick(
      { selector: "#login > button", tag: "button", text: "Sign in", html: '<button class="primary">Sign in</button>', rect: { x: 0, y: 0, width: 80, height: 30 } },
      "http://localhost:3000/login",
      "/tmp/el.png",
    );
    expect(text).toBe(
      ["Element `#login > button` on http://localhost:3000/login", 'Text: "Sign in"', "```html", '<button class="primary">Sign in</button>', "```", "Screenshot: /tmp/el.png"].join("\n"),
    );
  });
});

describe("BrowserController", () => {
  /** A controller with a fake page, collecting CDP commands and the events it emits. */
  function make() {
    const sent: [string, unknown][] = [];
    const wc = {
      isDestroyed: () => false,
      debugger: {
        sendCommand: async (m: string, p?: unknown) => {
          sent.push([m, p]);
        },
      },
    };
    const seen: { logs: (LogEntry | null)[]; shots: string[]; devices: string[] } = { logs: [], shots: [], devices: [] };
    const events = {
      onLog: (entry: LogEntry | null) => seen.logs.push(entry),
      onScreenshot: (path: string) => seen.shots.push(path),
      onDevice: (device: string) => seen.devices.push(device),
    };
    const controller = new BrowserController(() => {}, tempDir(), () => {}, events);
    (controller as unknown as { wc: unknown }).wc = wc;
    return { controller, wc, sent, seen };
  }

  it("emulates a device and clears it back to desktop", async () => {
    const { controller, sent, seen } = make();
    await controller.setDevice("mobile");
    expect(sent).toContainEqual(["Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true }]);
    expect(seen.devices).toContain("mobile");
    await controller.setDevice("desktop");
    expect(sent).toContainEqual(["Emulation.clearDeviceMetricsOverride", undefined]);
  });

  it("buffers logs for the renderer without clearing them", async () => {
    const { controller, wc, seen } = make();
    (controller as unknown as { onCdp(m: string, p: Record<string, unknown>): void }).onCdp("Runtime.consoleAPICalled", {
      type: "error",
      args: [{ value: "boom" }],
    });
    expect(controller.logsView()).toHaveLength(1);
    expect(seen.logs).toContainEqual({ level: "error", text: "console.error: boom" });
    // A second read is a copy: the console tab never eats the agent's buffer.
    expect(controller.logsView()).toHaveLength(1);
    controller.page = async () => wc as never;
    expect(await controller.readLogs(false)).toContain("boom");
  });

  it("exposes a device argument on browser_open", () => {
    const tools = browserTools({ enabled: false } as unknown as BrowserController);
    expect(Object.keys(tools.find((t) => t.name === "browser_open")!.input)).toContain("device");
  });

  it("refuses acting tools while the user has taken over", async () => {
    const { controller } = make();
    controller.setPaused(true);
    await expect(controller.click("e1")).rejects.toThrow(/took over/);
    expect(() => controller.assertOpenAllowed()).toThrow(/took over/);
    controller.setPaused(false);
    expect(() => controller.assertOpenAllowed()).not.toThrow();
  });

  it("browser_open reports the takeover instead of fighting the pointer", async () => {
    const stub = {
      enabled: true,
      paused: true,
      ensureOpen: vi.fn(),
      assertOpenAllowed() {
        throw new Error("The user took over the browser pane and paused you.");
      },
      page: vi.fn(),
      snapshot: vi.fn(),
      announce: vi.fn(),
    };
    const open = browserTools(stub as unknown as BrowserController).find((t) => t.name === "browser_open")!;
    const out = await open.run({ url: "http://x" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("took over");
    expect(stub.page).not.toHaveBeenCalled();
  });
});
