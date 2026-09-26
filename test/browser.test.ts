import { describe, expect, it } from "vitest";
import { formatSnapshot } from "../src/main/browser/snapshot";
import { browserTools } from "../src/main/browser/tools";
import { isAllowedUrl, normalizeUrl } from "../src/main/browser/url";
import type { BrowserController } from "../src/main/browser/controller";

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
  const tools = browserTools({ enabled: false } as unknown as BrowserController);

  it("offers exactly the seven named tools", () => {
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

  it("answers \"Browser pane not open\" for every tool", async () => {
    const args: Record<string, unknown> = { url: "http://x", ref: "e1", text: "a", expression: "1" };
    for (const tool of tools) {
      expect(await tool.run(args)).toEqual({ text: "Browser pane not open", isError: true });
    }
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
