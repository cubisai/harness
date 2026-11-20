import { describe, expect, it } from "vitest";
import { parseContributions, decidePluginRule, partRuntimeName } from "../src/main/apps/parts";
import { validateApp } from "../src/main/apps/manifest";
import { validateProposal } from "../src/main/extensions/manifest";

const paths = new Set(["index.html", "skills/review/SKILL.md"]);
const command = { name: "review", description: "Review", prompt: "Review the current work." };
const config = { title: "Review", prompt: "Review the current work.", agent: "codex", model: null, schedule: { kind: "interval", everyMinutes: 60 } };
describe("plugin contribution contract", () => {
  it.each(["Glob", "Grep", "Skill", "TodoWrite", "WebFetch", "WebSearch", "AskUserQuestion", "ExitPlanMode", "EnterPlanMode", "Task", "Agent", "propose_plan"])("rejects the native SDK %s alias rather than promising host enforcement", (name) => {
    expect(() => parseContributions({ rules: [{ action: "ask", target: { kind: "tool", name } }] }, paths)).toThrow(/CubiQ-managed/);
  });
  it.each(["glob", "grep", "todowrite", "web_fetch", "task", "ask_user"])("accepts the main-mediated native harness %s identity", (name) => {
    expect(parseContributions({ rules: [{ action: "ask", target: { kind: "tool", name } }] }, paths)?.rules?.[0]?.target).toEqual({ kind: "tool", name });
  });
  it("leaves empty and legacy manifests unchanged", () => {
    expect(parseContributions(undefined, paths)).toBeUndefined();
    expect(parseContributions({}, paths)).toBeUndefined();
    expect(parseContributions({ commands: [] }, paths)).toBeUndefined();
    const app = validateApp("reviewer", [{ path: "app.json", content: JSON.stringify({ name: "reviewer", title: "Reviewer", description: "Review", entry: "index.html" }) }, { path: "index.html", content: "<h1>Review</h1>" }]);
    expect(app.ok && app.manifest).toEqual({ name: "reviewer", title: "Reviewer", description: "Review", entry: "index.html", grants: [] });
  });
  it("parses all five kinds with explicit Off/Ask automation defaults", () => {
    const parts = parseContributions({ commands: [command], skills: [{ name: "review", description: "Review", path: "skills/review" }], connectors: [{ name: "shop", spec: { type: "http", url: "https://example.test/mcp" } }], rules: [{ action: "ask", target: { kind: "tool", name: "plugin_reviewer__save" } }], automations: [{ name: "review", config }] }, paths)!;
    expect(parts.commands).toEqual([command]);
    expect(parts.automations?.[0]?.input).toMatchObject({ enabled: false, permissions: "ask", template: "custom", agent: "codex", model: null });
  });
  it.each([
    { hooks: [] }, { commands: [{ ...command, run: "npm install" }] }, { commands: [command, command] },
    { commands: [{ ...command, name: "../review" }] }, { commands: [{ ...command, prompt: "x".repeat(32 * 1024 + 1) }] },
    { skills: [{ name: "review", description: "Review", path: "../review" }] },
    { skills: [{ name: "review", description: "Review", path: "absent" }] },
    { connectors: [{ name: "shop", spec: { type: "http", url: "https://user:password@example.test/" } }] },
    { connectors: [{ name: "shop", spec: { type: "http", url: "https://example.test/", headers: { Authorization: "secret" } } }] },
    { rules: [{ action: "allow", target: { kind: "tool", name: "Bash" } }] },
    { rules: [{ action: "ask", target: { kind: "tool", name: "plugin_*" } }] },
    { rules: [{ action: "ask", target: { kind: "connector", server: "shop", tool: "*" } }] },
    { automations: [{ name: "review", config: { ...config, enabled: true } }] },
    { automations: [{ name: "review", config: { ...config, agent: undefined } }] },
    { automations: [{ name: "review", config: { ...config, projectId: "other" } }] },
  ])("rejects unsafe or ambiguous parts %#", (raw) => expect(() => parseContributions(raw, paths)).toThrow());
  it("binds bundle automation scope into the proposal digest", () => {
    const files = [{ path: "app.json", content: JSON.stringify({ name: "reviewer", title: "Reviewer", description: "Review", contributes: { automations: [{ name: "review", config }] } }) }, { path: "index.html", content: "<h1>Review</h1>" }];
    expect(validateProposal({ kind: "app", name: "reviewer", files }, { scope: { kind: "global" } }).ok).toBe(false);
    const a = validateProposal({ kind: "app", name: "reviewer", files, bundleProjectId: "one" }, { scope: { kind: "global" } });
    const b = validateProposal({ kind: "app", name: "reviewer", files, bundleProjectId: "two" }, { scope: { kind: "global" } });
    expect(a.ok && b.ok && a.proposal.digest !== b.proposal.digest).toBe(true);
  });
  it("normalizes validated skill files before the reviewed snapshot is hashed", () => {
    const app = validateApp("reviewer", [{ path: "app.json", content: JSON.stringify({ name: "reviewer", title: "Reviewer", description: "Review", contributes: { skills: [{ name: "review", description: "Review: carefully", path: "skills/review" }] } }) }, { path: "index.html", content: "<h1>Review</h1>" }, { path: "skills/review/SKILL.md", content: "---\r\nname: review\r\ndescription: old\r\n---\r\nReview it.\r\n" }]);
    expect(app.ok && app.files.find((f) => f.path.endsWith("SKILL.md"))?.content).toBe('---\nname: review\ndescription: "Review: carefully"\n---\nReview it.\n');
  });
  it("keeps qualified runtime names stable, short and collision-safe", () => {
    const a = partRuntimeName("x".repeat(64), "x".repeat(32));
    expect(a.length).toBeLessThanOrEqual(40);
    expect(a).toBe(partRuntimeName("x".repeat(64), "x".repeat(32)));
    expect(partRuntimeName("ab-c", "d")).not.toBe(partRuntimeName("ab", "c-d"));
  });
  it("makes Ask win and never lets Allow upgrade a mutation or unknown call", () => {
    const target = { kind: "tool", name: "plugin_reviewer__save" } as const;
    const allow = { action: "allow", target } as const, ask = { action: "ask", target } as const;
    expect(decidePluginRule([allow], target, false)).toBeNull();
    expect(decidePluginRule([allow], target, true)).toBe("allow");
    expect(decidePluginRule([allow, ask], target, true)).toBe("ask");
    expect(decidePluginRule([ask], { kind: "tool", name: "other" }, true)).toBeNull();
  });
});
