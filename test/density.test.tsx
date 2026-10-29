import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsStore, type SecretBox } from "../src/main/settings";
import { applyDensity } from "../src/renderer/src/store";
import type { Density } from "../src/shared/types";
import { tempDir } from "./helpers";

const box: SecretBox = { available: false, encrypt: (s) => s, decrypt: (s) => s };
const css = readFileSync(join(__dirname, "..", "src", "renderer", "src", "styles", "app.css"), "utf-8");

describe("density setting", () => {
  it("defaults to comfortable, round-trips, and ignores unknown values", () => {
    const file = join(tempDir(), "settings.json");
    const store = new SettingsStore(file, box);
    expect(store.get().density).toBe("comfortable");
    store.update({ density: "compact" });
    expect(new SettingsStore(file, box).get().density).toBe("compact");
    store.update({ density: "tiny" as Density });
    expect(store.get().density).toBe("compact");
  });
});

describe("applyDensity", () => {
  const saved = globalThis.document;
  afterEach(() => {
    globalThis.document = saved;
  });

  it("writes data-density on the root, comfortable when unset", () => {
    const root = { dataset: {} as Record<string, string> };
    globalThis.document = { documentElement: root } as unknown as Document;
    applyDensity("compact");
    expect(root.dataset.density).toBe("compact");
    applyDensity(undefined);
    expect(root.dataset.density).toBe("comfortable");
  });
});

describe("app.css compact density", () => {
  it("gives thread, tool and turn-meta rows a smaller line height than the default", () => {
    for (const selector of [".thread-row", ".tool-row", ".turn-meta"]) {
      const rule = css.match(new RegExp(`\\[data-density="compact"\\] \\${selector} \\{([^}]*)\\}`))?.[1] ?? "";
      const lh = Number(rule.match(/line-height: ([\d.]+)/)?.[1]);
      // The default is the browser's "normal" (about 1.2).
      expect(lh, selector).toBeLessThan(1.2);
    }
  });
});
