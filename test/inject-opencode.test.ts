import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { InjectionPlan } from "../src/main/inject";
import { parseOpenCodeVariants, withOpenCodeVariant } from "../src/main/inject/opencode";

describe("parseOpenCodeVariants", () => {
  const fixture = readFileSync(join(__dirname, "fixtures", "opencode-models.txt"), "utf8");

  it("maps model ids with variants and skips the rest", () => {
    expect(parseOpenCodeVariants(fixture)).toEqual({
      "opencode/space-bunny-free": ["low", "medium", "high", "xhigh", "max"],
    });
  });

  it("handles CRLF line endings", () => {
    expect(parseOpenCodeVariants(fixture.replace(/\n/g, "\r\n"))).toEqual({
      "opencode/space-bunny-free": ["low", "medium", "high", "xhigh", "max"],
    });
  });

  it("ignores log lines and blank input", () => {
    expect(parseOpenCodeVariants("just a log line\n\nnot/a/model id\n")).toEqual({});
  });
});

describe("withOpenCodeVariant", () => {
  const pick = { agent: "build", model: "opencode/space-bunny-free", variant: "high" };

  it("creates a plan and config when none exists", () => {
    const out = withOpenCodeVariant(undefined, pick, { PATH: "/usr/bin" });
    expect(out.byok).toBe(false);
    expect(out.env.PATH).toBe("/usr/bin");
    expect(JSON.parse(out.env.OPENCODE_CONFIG_CONTENT!)).toEqual({
      agent: { build: { model: pick.model, variant: "high" } },
    });
  });

  it("preserves provider and plugin keys", () => {
    const plan: InjectionPlan = {
      env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ $schema: "https://opencode.ai/config.json", provider: { gw: { npm: "@ai-sdk/openai-compatible" } }, plugin: ["file:///guard.mjs"] }) },
      byok: true,
    };
    const out = withOpenCodeVariant(plan, pick);
    expect(out).toBe(plan);
    const config = JSON.parse(out.env.OPENCODE_CONFIG_CONTENT!) as { $schema: string; provider: unknown; plugin: string[]; agent: Record<string, unknown> };
    expect(config.$schema).toBe("https://opencode.ai/config.json");
    expect(config.provider).toEqual({ gw: { npm: "@ai-sdk/openai-compatible" } });
    expect(config.plugin).toEqual(["file:///guard.mjs"]);
    expect(config.agent.build).toEqual({ model: pick.model, variant: "high" });
  });

  it("keeps the other fields of an existing agent entry", () => {
    const plan: InjectionPlan = {
      env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ agent: { build: { temperature: 0.2, description: "keep me" } } }) },
      byok: true,
    };
    withOpenCodeVariant(plan, pick);
    const config = JSON.parse(plan.env.OPENCODE_CONFIG_CONTENT!) as { agent: Record<string, Record<string, unknown>> };
    expect(config.agent.build).toEqual({ temperature: 0.2, description: "keep me", model: pick.model, variant: "high" });
  });
});
