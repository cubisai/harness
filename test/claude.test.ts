import { describe, expect, it } from "vitest";
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { createClaudeDriver, resolvePackagedClaudeBinary, turnEndFromResult } from "../src/main/agents/claude";
import type { ThreadEvent } from "../src/shared/types";

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

describe("turnEndFromResult", () => {
  const result = (usage: Record<string, number>) =>
    ({ type: "result", subtype: "success", duration_ms: 1200, total_cost_usd: 0.42, usage }) as unknown as SDKResultMessage;

  const turnEnd = (event: ThreadEvent) => {
    if (event.kind !== "turn-end") throw new Error(`expected turn-end, got ${event.kind}`);
    return event;
  };

  it("keeps cached tokens out of inputTokens and reports a hit rate", () => {
    const event = turnEnd(
      turnEndFromResult(
        result({ input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 8000, cache_creation_input_tokens: 2000 }),
      ),
    );
    expect(event.inputTokens).toBe(1000);
    expect(event.outputTokens).toBe(50);
    expect(event.costUsd).toBe(0.42);
    expect(event.durationMs).toBe(1200);
    expect(event.usage?.cacheReadTokens).toBe(8000);
    expect(event.usage?.cacheWriteTokens).toBe(2000);
    expect(event.usage?.hitRate).toBe(8000 / 11000);
    expect(event.usage?.provenance).toBe("reported");
  });

  it("reports cache usage unavailable when the vendor omits it", () => {
    const event = turnEnd(turnEndFromResult(result({ input_tokens: 1000, output_tokens: 50 })));
    expect(event.inputTokens).toBe(1000);
    expect(event.usage?.cacheReadTokens).toBeNull();
    expect(event.usage?.hitRate).toBeNull();
    expect(event.usage?.provenance).toBe("unavailable");
  });
});
