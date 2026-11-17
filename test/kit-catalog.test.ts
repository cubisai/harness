import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KIT_CATALOG, KIT_HOSTS } from "../src/main/design/kit-catalog";

const registry = JSON.parse(readFileSync(join(process.cwd(), "design-kits", "registry.json"), "utf8")) as { kits: { id: string; name: string; version: string }[] };

describe("kit catalog", () => {
  it("offers every registry kit at its registry version and name", () => {
    expect(KIT_CATALOG.map((k) => [k.id, k.name, k.version])).toEqual(registry.kits.map((k) => [k.id, k.name, k.version]));
  });

  it("downloads each kit from a cubisai/harness-plugin release over https, pinned by a SHA-256", () => {
    for (const k of KIT_CATALOG) {
      const url = new URL(k.url);
      expect(url.protocol, k.id).toBe("https:");
      expect(KIT_HOSTS, k.id).toContain(url.hostname);
      expect(url.pathname, k.id).toMatch(new RegExp(`^/cubisai/harness-plugin/releases/download/[^/]+/${k.id}-${k.version.replace(/\./g, "\\.")}\\.zip$`));
      expect(k.sha256, k.id).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(new Set(KIT_CATALOG.map((k) => k.sha256)).size).toBe(KIT_CATALOG.length);
  });
});
