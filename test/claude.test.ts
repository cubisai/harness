import { describe, expect, it } from "vitest";
import { createClaudeDriver, resolvePackagedClaudeBinary } from "../src/main/agents/claude";

describe("resolvePackagedClaudeBinary", () => {
  it("leaves development installs to the SDK", () => {
    const resolve = (id: string) => `/repo/node_modules/${id}`;
    expect(resolvePackagedClaudeBinary(resolve, "darwin", "arm64")).toBeUndefined();
  });

  it("does not return a path that doesn't exist", () => {
    const resolve = (id: string) => `/Applications/UnSkilled.app/Contents/Resources/app.asar/node_modules/${id}`;
    expect(resolvePackagedClaudeBinary(resolve, "darwin", "arm64")).toBeUndefined();
  });

  it("skips platform packages that aren't installed", () => {
    const resolve = () => {
      throw new Error("not found");
    };
    expect(resolvePackagedClaudeBinary(resolve, "linux", "x64")).toBeUndefined();
  });
});

describe("Claude driver models", () => {
  it("starts with the static fallback list", () => {
    const d = createClaudeDriver({ pluginDir: () => "/tmp/plugin", guardScript: "/tmp/guard.py" });
    expect(d.models().map((m) => m.id)).toContain("opus");
    expect(d.models().find((m) => m.id === "opus")?.label).toBe("Opus 5.5");
    expect(d.defaultModel).toBe("opus");
  });

  it("refreshModels resolves and leaves a usable list even if the SDK fails", async () => {
    const d = createClaudeDriver({ pluginDir: () => "/tmp/plugin", guardScript: "/tmp/guard.py" });
    await d.refreshModels!();
    expect(d.models().length).toBeGreaterThan(0);
    expect(d.defaultModel).toBeTruthy();
    // When the SDK answers, labels carry the version (Opus 5.5, not bare Opus).
    const opus = d.models().find((m) => m.id === "opus");
    if (opus && opus.label !== "Opus 5.5") {
      // refresh fell back to the static list or an older SDK shape
      expect(opus.label).toMatch(/Opus/i);
    }
  }, 30_000);
});
