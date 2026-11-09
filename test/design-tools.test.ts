import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildDesignExport, exportFileName, type DesignExportDeps } from "../src/main/design/export";
import { SHOT_MAX_HEIGHT, Shooter, type ShotWindow } from "../src/main/design/shooter";
import { kitIndexEntry, kitThemeIndex } from "../src/main/design/systems";
import { designTools, directionStyle, type DesignToolDeps } from "../src/main/design/tools";
import { tempDir } from "./helpers";

const PNG = Buffer.from("png-bytes");

function fakeWindow(scrollHeight = 2000) {
  const calls: string[] = [];
  const win: ShotWindow & { destroyed: boolean } = {
    destroyed: false,
    setContentSize: (w, h) => void calls.push(`size ${w}x${h}`),
    load: async (url) => void calls.push(`load ${url}`),
    evaluate: async (script) => {
      if (script.includes("scrollHeight")) return scrollHeight;
      if (script === "LINT") return JSON.stringify({ findings: [{ rule: "contrast", selector: "p", detail: "2.0:1" }], skipped: [], scanned: 3 });
      return true;
    },
    capture: async (w, h) => (calls.push(`capture ${w}x${h}`), PNG),
    pdf: async () => (calls.push("pdf"), Buffer.from("%PDF")),
    destroy() {
      this.destroyed = true;
      calls.push("destroy");
    },
    isDestroyed() {
      return this.destroyed;
    },
  };
  return { win, calls };
}

describe("Shooter", () => {
  it("makes one window on first use, reuses it, and refuses anything but design pages", async () => {
    const { win, calls } = fakeWindow();
    const create = vi.fn(() => win);
    const shooter = new Shooter(create, 10_000);
    await shooter.screenshot("cubiq-design://d/t/index.html", { width: 390, height: 844 });
    await shooter.evaluate("cubiq-design://d/t/index.html", 1440, 900, "1");
    expect(create).toHaveBeenCalledTimes(1);
    expect(calls.slice(0, 3)).toEqual(["size 390x844", "load cubiq-design://d/t/index.html", "capture 390x844"]);
    await expect(shooter.screenshot("https://example.com", { width: 390, height: 844 })).rejects.toThrow(/design pages/);
    await expect(shooter.screenshot("file:///etc/passwd", { width: 390, height: 844 })).rejects.toThrow(/design pages/);
    shooter.close();
    expect(win.destroyed).toBe(true);
    await expect(shooter.screenshot("cubiq-design://d/t/index.html", { width: 390, height: 844 })).rejects.toThrow(/closed/);
  });

  it("grows to the page for a full-page shot, capped at the max height", async () => {
    const tall = fakeWindow(9000);
    const shooter = new Shooter(() => tall.win, 10_000);
    const shot = await shooter.screenshot("cubiq-design://d/t/index.html", { width: 1440, height: 900, fullPage: true });
    expect(shot).toMatchObject({ width: 1440, height: SHOT_MAX_HEIGHT, cut: true });
    expect(tall.calls).toContain(`capture 1440x${SHOT_MAX_HEIGHT}`);
    const short = fakeWindow(1200);
    const s2 = new Shooter(() => short.win, 10_000);
    expect(await s2.screenshot("cubiq-design://d/t/index.html", { width: 1440, height: 900, fullPage: true })).toMatchObject({ height: 1200, cut: false });
    shooter.close();
    s2.close();
  });

  it("runs jobs one at a time, and a failed job doesn't stall the queue", async () => {
    const { win } = fakeWindow();
    let active = 0;
    let peak = 0;
    const load = win.load;
    win.load = async (url) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      if (url.endsWith("bad.html")) throw new Error("load failed");
      return load(url);
    };
    const created: number[] = [];
    const shooter = new Shooter(() => (created.push(1), win.destroyed ? fakeWindow().win : win), 10_000);
    const results = await Promise.allSettled([
      shooter.evaluate("cubiq-design://d/t/a.html", 800, 600, "1"),
      shooter.evaluate("cubiq-design://d/t/bad.html", 800, 600, "1"),
      shooter.evaluate("cubiq-design://d/t/c.html", 800, 600, "1"),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
    expect(peak).toBe(1);
    // The failed job's window was thrown away and the next job got a fresh one.
    expect(created.length).toBe(2);
    shooter.close();
  });

  it("destroys the window after it sits idle", async () => {
    vi.useFakeTimers();
    try {
      const { win } = fakeWindow();
      const shooter = new Shooter(() => win, 1000);
      await shooter.evaluate("cubiq-design://d/t/a.html", 800, 600, "1");
      expect(win.destroyed).toBe(false);
      vi.advanceTimersByTime(1001);
      expect(win.destroyed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

function toolDeps(root: string | null, over: Partial<DesignToolDeps> = {}): DesignToolDeps & { shots: unknown[]; evals: unknown[]; saved: string[] } {
  const shots: unknown[] = [];
  const evals: unknown[] = [];
  const saved: string[] = [];
  return {
    shots,
    evals,
    saved,
    root: () => root,
    folder: () => "designs/abcd1234",
    url: (id, rel) => `cubiq-design://d/${id}/${rel}`,
    screenshot: async (url, opts) => (shots.push({ url, ...opts }), { png: PNG, width: opts.width, height: opts.height, cut: false }),
    evaluate: async (url, width, height, script) => (evals.push({ url, width, height, script }), JSON.stringify({ findings: [], skipped: [], scanned: 4 })),
    lintScript: "LINT",
    saveCritique: (_id, md) => (saved.includes(md) ? null : (saved.push(md), { version: saved.length })),
    setDirection: (_id, d) => {
      if (d.style !== "riso") throw new Error(`Unknown style "${d.style}". Pick one of: riso.`);
      return `Direction: ${d.surface}, ${d.mode}, tier ${d.tier}.`;
    },
    kitIndex: () => "riso: Riso print [print, warm; persuade; web]",
    ...over,
  };
}

function tool(deps: DesignToolDeps, name: string) {
  const t = designTools(deps, "thread-1").find((x) => x.name === name);
  if (!t) throw new Error(`no ${name}`);
  return t;
}

describe("design tools", () => {
  it("offers exactly the four design tools, all safe to run without asking", () => {
    const list = designTools(toolDeps(tempDir()), "t");
    expect(list.map((t) => t.name)).toEqual(["design_screenshot", "design_lint", "design_critique_save", "design_set_direction"]);
    expect(list.every((t) => t.autoAllow)).toBe(true);
  });

  it("screenshots a page in the design folder with clamped sizes and returns the PNG", async () => {
    const root = tempDir();
    writeFileSync(join(root, "index.html"), "<p>hi</p>");
    const deps = toolDeps(root);
    const out = await tool(deps, "design_screenshot").run({ width: 10, height: 99999 });
    expect(out.isError).toBeUndefined();
    expect(out.imagePng).toBe(PNG.toString("base64"));
    expect(out.text).toContain("designs/abcd1234/index.html at 320×4000");
    expect(deps.shots).toEqual([{ url: "cubiq-design://d/thread-1/index.html", width: 320, height: 4000, fullPage: false }]);
    // Defaults, and a path written with the design folder in front.
    await tool(deps, "design_screenshot").run({ path: "designs/abcd1234/index.html" });
    expect(deps.shots[1]).toEqual({ url: "cubiq-design://d/thread-1/index.html", width: 1440, height: 900, fullPage: false });
  });

  it("refuses pages that are missing, outside the folder, not pages, or in a thread without a design folder", async () => {
    const root = tempDir();
    mkdirSync(join(root, "img"));
    writeFileSync(join(root, "img", "a.png"), "x");
    const deps = toolDeps(root);
    expect(await tool(deps, "design_screenshot").run({})).toMatchObject({ isError: true, text: expect.stringContaining("doesn't exist yet") });
    expect(await tool(deps, "design_screenshot").run({ path: "../../etc/passwd" })).toMatchObject({ isError: true, text: expect.stringContaining("outside") });
    expect(await tool(deps, "design_lint").run({ path: "img/a.png" })).toMatchObject({ isError: true, text: expect.stringContaining("isn't a page") });
    expect(await tool(toolDeps(null), "design_lint").run({})).toMatchObject({ isError: true, text: "This thread has no design folder." });
    expect(deps.shots).toHaveLength(0);
    expect(deps.evals).toHaveLength(0);
  });

  it("lints through the page script and formats the report", async () => {
    const root = tempDir();
    writeFileSync(join(root, "index.html"), "<p>hi</p>");
    const deps = toolDeps(root, {
      evaluate: async () => JSON.stringify({ findings: [{ rule: "targets", selector: "button", detail: "20×20px, needs 44×44" }], skipped: [], scanned: 9 }),
    });
    const out = await tool(deps, "design_lint").run({ width: 390 });
    expect(out.text).toContain("designs/abcd1234/index.html at 390px");
    expect(out.text).toContain("- [targets] button — 20×20px, needs 44×44");
  });

  it("reports a renderer failure as a tool error, not a throw", async () => {
    const root = tempDir();
    writeFileSync(join(root, "index.html"), "<p>hi</p>");
    const deps = toolDeps(root, { screenshot: async () => Promise.reject(new Error("boom")) });
    expect(await tool(deps, "design_screenshot").run({})).toEqual({ text: "Screenshot failed: boom", isError: true });
  });

  it("saves critiques as versions; unchanged or empty text adds none", async () => {
    const deps = toolDeps(tempDir());
    const save = tool(deps, "design_critique_save");
    expect((await save.run({ markdown: "# Round 1" })).text).toBe("Saved as Critique v1.");
    expect((await save.run({ markdown: "# Round 1\n" })).text).toContain("Unchanged");
    expect(await save.run({ markdown: "   " })).toMatchObject({ isError: true });
    expect(await save.run({ markdown: "x".repeat(40_000) })).toMatchObject({ isError: true });
    expect(deps.saved).toEqual(["# Round 1\n"]);
  });
});

describe("design export", () => {
  function exportDeps(root: string, over: Partial<DesignExportDeps> = {}): DesignExportDeps & { urls: string[] } {
    const urls: string[] = [];
    return {
      urls,
      root: () => root,
      readVersion: (_t, rel, v) => (rel === "index.html" && v === 2 ? Buffer.from("<title>Old</title><p>v2</p>") : null),
      url: (t, rel, v) => `cubiq-design://d/${t}/${rel}${v ? `?v=${v}` : ""}`,
      screenshot: async (url, opts) => (urls.push(url), { png: PNG, width: opts.width, height: 1200, cut: false }),
      pdf: async (url) => (urls.push(url), Buffer.from("%PDF")),
      ...over,
    };
  }

  it("inlines the page's local files into one html, with no bridge", async () => {
    const root = tempDir();
    writeFileSync(join(root, "index.html"), '<link rel="stylesheet" href="system/tokens.css"><p>hi</p>');
    mkdirSync(join(root, "system"));
    writeFileSync(join(root, "system", "tokens.css"), ":root{--color-bg:#fff}");
    const out = (await buildDesignExport(exportDeps(root), { threadId: "t", format: "html", rel: "index.html", version: null, width: 1440 })).toString();
    expect(out).toContain("<style>:root{--color-bg:#fff}</style>");
    expect(out).not.toContain("cubiq-design");
  });

  it("exports the version on screen", async () => {
    const root = tempDir();
    writeFileSync(join(root, "index.html"), "<p>now</p>");
    const deps = exportDeps(root);
    expect((await buildDesignExport(deps, { threadId: "t", format: "html", rel: "index.html", version: 2, width: 1440 })).toString()).toContain("<p>v2</p>");
    await buildDesignExport(deps, { threadId: "t", format: "png", rel: "index.html", version: 2, width: 390 });
    await buildDesignExport(deps, { threadId: "t", format: "pdf", rel: "index.html", version: null, width: 1920 });
    expect(deps.urls).toEqual(["cubiq-design://d/t/index.html?v=2", "cubiq-design://d/t/index.html"]);
  });

  it("fails clearly when the page is gone", async () => {
    const deps = exportDeps(tempDir());
    await expect(buildDesignExport(deps, { threadId: "t", format: "png", rel: "index.html", version: null, width: 1440 })).rejects.toThrow(/not found/);
    await expect(buildDesignExport(deps, { threadId: "t", format: "html", rel: "../x.html", version: null, width: 1440 })).rejects.toThrow(/not found/);
  });

  it("names the file from the page title, safe on every OS", () => {
    expect(exportFileName("<title>Acme: Pricing / Plans</title>", "abcd1234ffff", "html", null)).toBe("Acme Pricing Plans.html");
    expect(exportFileName("<title>Q3 &amp; Q4</title>", "abcd1234ffff", "pdf", 3)).toBe("Q3 & Q4 v3.pdf");
    expect(exportFileName("<p>no title</p>", "abcd1234ffff", "png", null)).toBe("design-abcd1234.png");
    expect(exportFileName("<title> ... </title>", "abcd1234ffff", "png", null)).toBe("design-abcd1234.png");
    expect(exportFileName(null, "abcd1234ffff", "png", null)).toBe("design-abcd1234.png");
  });
});

describe("the direction tool's kit and theme", () => {
  it("records a Foundation theme as its style and another kit's as kit:<kit>/<theme>", () => {
    expect(directionStyle(undefined, "riso")).toBe("riso");
    expect(directionStyle("foundation", "riso")).toBe("riso");
    expect(directionStyle("kit:mui", "indigo")).toBe("kit:mui/indigo");
    expect(directionStyle("mui", "mui/indigo")).toBe("kit:mui/indigo");
    expect(directionStyle("mui", "project")).toBe("project");
  });

  it("indexes Foundation's themes, then each other kit with its themes", () => {
    const mui = kitIndexEntry(join(process.cwd(), "design-kits", "kits", "mui"));
    expect(mui?.id).toBe("mui");
    expect(mui?.themes).toContain("indigo");
    const styles = [{ id: "style:riso", name: "Riso", description: "Riso print: inks", tags: ["print"], modes: ["persuade"], platform: "web" }] as never;
    const index = kitThemeIndex(styles, [mui!, { id: "foundation", name: "Foundation", themes: ["x"] }]).split("\n");
    expect(index[0]).toMatch(/^Kit "foundation"/);
    expect(index[1]).toBe("riso: Riso print [print; persuade; web]");
    expect(index.at(-1)).toMatch(/^mui \(MUI, @mui\/material\): .*indigo/);
    expect(index.filter((l) => l.startsWith("foundation"))).toEqual([]);
    expect(kitThemeIndex(styles, []).split("\n")).toHaveLength(2);
  });
});
