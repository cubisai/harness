import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isFromAppWindow } from "../src/main/design/documents";
import { designCsp } from "../src/main/design/serve";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("isFromAppWindow", () => {
  it("accepts the top-level page only", () => {
    expect(isFromAppWindow({ senderFrame: { parent: null } })).toBe(true);
    expect(isFromAppWindow({ senderFrame: { parent: { url: "app" } } })).toBe(false);
    expect(isFromAppWindow({ senderFrame: null })).toBe(false);
    expect(isFromAppWindow({})).toBe(false);
  });

  it("guards every handler that edits a page, installs a kit or downloads references", () => {
    const main = read("src/main/index.ts");
    const channels = ["design:mutate", "design:history", "design:systems:catalog", "design:systems:ensure"];
    channels.push("design:references:status", "design:references:download", "design:references:cancel", "design:references:remove");
    for (const channel of channels) {
      const at = main.indexOf(`ipcMain.handle("${channel}"`);
      expect(at, channel).toBeGreaterThan(-1);
      expect(main.slice(at, at + 200), channel).toContain("isFromAppWindow(e)");
    }
  });
});

describe("what a design page can't do", () => {
  const FRAMES = ["src/renderer/src/design/Board.tsx", "src/renderer/src/design/DesignCanvas.tsx", "src/renderer/src/design/Present.tsx"];

  it("runs every frame with scripts only: no same origin, popups, forms or top navigation", () => {
    for (const file of FRAMES) {
      const sandboxes = [...read(file).matchAll(/sandbox="([^"]*)"/g)].map((m) => m[1]);
      expect(sandboxes.length, file).toBeGreaterThan(0);
      expect(new Set(sandboxes), file).toEqual(new Set(["allow-scripts"]));
    }
  });

  it("serves pages with no network and no form posts", () => {
    const csp = designCsp();
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).not.toMatch(/https?:|\*/);
  });

  it("registers the design scheme with CORS, or a kit's fonts fail in the frame's opaque origin", () => {
    expect(read("src/main/index.ts")).toMatch(/scheme: DESIGN_SCHEME, privileges: \{[^}]*corsEnabled: true[^}]*\}/);
  });

  it("gives a frame no preload, so the bridge to the app isn't there to find", () => {
    expect(read("src/main/index.ts")).not.toMatch(/nodeIntegrationInSubFrames:\s*true/);
  });

  it("only hears messages from its own frame", () => {
    expect(read("src/renderer/src/design/DesignCanvas.tsx")).toContain("e.source !== frameRef.current.contentWindow");
  });
});
