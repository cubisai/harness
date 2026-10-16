import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { InjectionPlan } from "../src/main/inject";
import { parseOpenCodeVariants, withOpenCodeReadDirs, withOpenCodeTeam, withOpenCodeVariant } from "../src/main/inject/opencode";

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

describe("withOpenCodeTeam", () => {
  const team = [
    { id: "analyst", description: "Ana, Analyst: Finds facts.", prompt: "Research." },
    { id: "writer", description: "Wren, Writer", prompt: "Write." },
  ];

  it("adds each member as a subagent and keeps the rest of the config", () => {
    const plan: InjectionPlan = { env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: ["p"], agent: { build: { variant: "high" } } }) }, byok: false };
    const out = withOpenCodeTeam(plan, team);
    expect(JSON.parse(out.env.OPENCODE_CONFIG_CONTENT!)).toEqual({
      plugin: ["p"],
      agent: {
        build: { variant: "high" },
        analyst: { mode: "subagent", description: "Ana, Analyst: Finds facts.", prompt: "Research." },
        writer: { mode: "subagent", description: "Wren, Writer", prompt: "Write." },
      },
    });
  });

  it("creates a plan from the env when none exists, and never overrides a configured agent", () => {
    const out = withOpenCodeTeam(undefined, team, [], { PATH: "/bin", OPENCODE_CONFIG_CONTENT: JSON.stringify({ agent: { writer: { model: "x" } } }) });
    expect(out.env.PATH).toBe("/bin");
    const agent = (JSON.parse(out.env.OPENCODE_CONFIG_CONTENT!) as { agent: Record<string, unknown> }).agent;
    expect(agent.writer).toEqual({ model: "x" });
    expect(agent.analyst).toMatchObject({ mode: "subagent" });
  });

  it("lets each lead hand work to the members, even when its task tool is restricted", () => {
    const config = { agent: { orchestrator: { model: "m", permission: { edit: "allow", task: { "*": "deny", researcher: "allow" } } }, plan: { permission: { task: "deny" } }, build: { permission: { task: "allow" } } } };
    const out = withOpenCodeTeam({ env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) }, byok: false }, team, ["orchestrator", "plan", "build", "analyst"]);
    const agent = (JSON.parse(out.env.OPENCODE_CONFIG_CONTENT!) as { agent: Record<string, { permission?: unknown; model?: string }> }).agent;
    expect(agent.orchestrator).toEqual({ model: "m", permission: { edit: "allow", task: { "*": "deny", researcher: "allow", analyst: "allow", writer: "allow" } } });
    expect(agent.plan!.permission).toEqual({ task: { "*": "deny", analyst: "allow", writer: "allow" } });
    // Already open to every agent, and a member is never its own lead.
    expect(agent.build!.permission).toEqual({ task: "allow" });
    expect(agent.analyst).toEqual({ mode: "subagent", description: "Ana, Analyst: Finds facts.", prompt: "Research." });
  });
});

describe("withOpenCodeReadDirs", () => {
  it("allows each folder's subtree and keeps the other rules", () => {
    const plan: InjectionPlan = { env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { bash: "ask", external_directory: { "/tmp/**": "deny" } } }) }, byok: false };
    const config = JSON.parse(withOpenCodeReadDirs(plan, ["/u/experts/team/skills/"]).env.OPENCODE_CONFIG_CONTENT!);
    expect(config.permission).toEqual({ bash: "ask", external_directory: { "/tmp/**": "deny", "/u/experts/team/skills/**": "allow" } });
  });

  it("keeps a bare rule as the default and lists a Windows folder both ways", () => {
    const plan: InjectionPlan = { env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { external_directory: "ask" } }) }, byok: false };
    const config = JSON.parse(withOpenCodeReadDirs(plan, ["C:\\Users\\me\\experts\\t\\skills"]).env.OPENCODE_CONFIG_CONTENT!);
    expect(config.permission.external_directory).toEqual({ "*": "ask", "C:\\Users\\me\\experts\\t\\skills/**": "allow", "C:/Users/me/experts/t/skills/**": "allow" });
  });

  it("starts a plan from the environment when there is none", () => {
    const out = withOpenCodeReadDirs(undefined, ["/x"], { HOME: "/h" });
    expect(out.env.HOME).toBe("/h");
    expect(JSON.parse(out.env.OPENCODE_CONFIG_CONTENT!).permission.external_directory).toEqual({ "/x/**": "allow" });
  });
});
