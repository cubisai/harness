import { describe, expect, it } from "vitest";
import { SAFE_DEFAULTS } from "../src/main/agents/capabilities";
import { agentCatalog, skillDetail, skillRoute } from "../src/main/library";
import { catalog } from "./helpers";

describe("skillRoute", () => {
  it("words each delivery mode, and names the gap otherwise", () => {
    expect(skillRoute({ skillsDelivery: { mode: "plugin", prefix: "harness-skills:" } })).toMatch(/plugin/);
    expect(skillRoute({ skillsDelivery: { mode: "extraRoots", prefix: "" } })).toMatch(/extra skills folder/);
    expect(skillRoute({ skillsDelivery: { mode: "envDir", prefix: "" }, skillsDirEnv: "DSH_BUNDLED_SKILL_DIR" })).toMatch(/DSH_BUNDLED_SKILL_DIR/);
    expect(skillRoute({ skillsDelivery: { mode: "projectWrite", prefix: "" } })).toMatch(/^Not automatic: .*install/);
    expect(skillRoute({ skillsDelivery: { mode: "none" } })).toMatch(/^Not automatic: /);
  });
});

describe("agentCatalog", () => {
  it("lists every known agent, installed or not, with how skills and MCP reach it", () => {
    const list = agentCatalog({ installed: (c) => c === "dsh", custom: [{ id: "qwen", label: "Qwen Code", command: "qwen", args: ["--acp"] }] });
    expect(list.map((a) => [a.id, a.installed, a.source])).toEqual([
      ["claude", true, "built-in"],
      ["codex", false, "built-in"],
      ["deepseek", true, "built-in"],
      ["antigravity", false, "built-in"],
      ["opencode", false, "built-in"],
      ["cursor", false, "built-in"],
      ["qwen", false, "agents.json"],
    ]);
    const byId = Object.fromEntries(list.map((a) => [a.id, a]));
    expect(byId.claude!.skills).toMatch(/plugin/);
    expect(byId.deepseek!.skills).toMatch(/DSH_BUNDLED_SKILL_DIR/);
    expect(byId.antigravity!).toMatchObject({ command: "agy-acp", install: "npm install -g agy-acp" });
    expect(byId.antigravity!.skills).toMatch(/install/);
  });

  it("gives every entry capabilities, and prefers a live patched set", () => {
    const list = agentCatalog({ installed: () => true, custom: [] });
    for (const entry of list) expect(entry.capabilities).toBeDefined();
    const patched = { ...SAFE_DEFAULTS, mcpHttp: true };
    const withLive = agentCatalog({ installed: () => true, custom: [], liveCapabilities: (id) => (id === "opencode" ? patched : undefined) });
    expect(withLive.find((a) => a.id === "opencode")!.capabilities).toBe(patched);
  });
});

describe("skillDetail", () => {
  it("returns the body, callers, and a route per installed agent", () => {
    const agents = agentCatalog({ installed: () => false, custom: [] });
    const tdd = skillDetail(catalog(), "tdd", agents);
    expect(tdd.skill.invocation).toBe("model");
    expect(tdd.body).not.toMatch(/^---/);
    expect(tdd.body.length).toBeGreaterThan(10);
    expect(tdd.calledBy.length).toBeGreaterThan(0);
    expect(tdd.routes).toEqual([{ agent: "Claude", how: expect.stringMatching(/plugin/) }]);
    const implement = skillDetail(catalog(), "implement", agents);
    expect(implement.routes[0]!.how).toMatch(/\/ menu/);
    expect(() => skillDetail(catalog(), "nope", agents)).toThrow();
  });
});
