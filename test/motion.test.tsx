import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsStore, type SecretBox } from "../src/main/settings";
import { applyMotion } from "../src/renderer/src/store";
import type { Motion } from "../src/shared/types";
import { tempDir } from "./helpers";

const box: SecretBox = { available: false, encrypt: (s) => s, decrypt: (s) => s };
const css = readFileSync(join(__dirname, "..", "src", "renderer", "src", "styles", "app.css"), "utf-8");

describe("motion setting", () => {
  it("defaults to full, round-trips, and ignores unknown values", () => {
    const file = join(tempDir(), "settings.json");
    const store = new SettingsStore(file, box);
    expect(store.get().motion).toBe("full");
    store.update({ motion: "instant" });
    expect(new SettingsStore(file, box).get().motion).toBe("instant");
    store.update({ motion: "wild" as Motion });
    expect(store.get().motion).toBe("instant");
  });

  it("fills in full for a file written before the setting existed", () => {
    const file = join(tempDir(), "settings.json");
    writeFileSync(file, JSON.stringify({ schemaVersion: 3, settings: { theme: "dark" } }));
    expect(new SettingsStore(file, box).get().motion).toBe("full");
  });
});

describe("applyMotion", () => {
  const saved = globalThis.document;
  afterEach(() => {
    globalThis.document = saved;
  });

  it("writes data-motion on the root, full when unset", () => {
    const root = { dataset: {} as Record<string, string> };
    globalThis.document = { documentElement: root } as unknown as Document;
    applyMotion("subtle");
    expect(root.dataset.motion).toBe("subtle");
    applyMotion(undefined);
    expect(root.dataset.motion).toBe("full");
  });
});

describe("app.css motion gating", () => {
  /** The declarations of the first top-level rule for `selector`. */
  const rule = (selector: string) => css.match(new RegExp(`\\n${selector.replace(/[.]/g, "\\.")} \\{([^}]*)\\}`))?.[1] ?? "";

  it("gives panels, sheets, menus and notices no entrance animation by default", () => {
    for (const selector of [".inspector", ".permission-card", ".skill-menu", ".sheet-backdrop", ".palette", ".sheet", ".library", ".open-menu", ".toast"]) {
      expect(rule(selector), selector).not.toBe("");
      expect(rule(selector), selector).not.toContain("animation");
    }
  });

  it("keeps in-thread notices inline; only the toast floats", () => {
    expect(css.match(/\n\.notice \{/g)).toHaveLength(1);
    expect(rule(".notice")).not.toContain("position");
    expect(rule(".toast")).toContain("position: fixed");
  });

  it("plays the inspector slide only for subtle/full motion, inside prefers-reduced-motion: no-preference", () => {
    const block = css.slice(css.indexOf("@media (prefers-reduced-motion: no-preference)"));
    expect(block).toMatch(/^@media \(prefers-reduced-motion: no-preference\) \{[^@]*\[data-motion="full"\] \.inspector \{ animation: slide-in 220ms/);
    expect(block).toMatch(/\[data-motion="subtle"\] \.inspector \{ animation: slide-in 120ms/);
  });
});
