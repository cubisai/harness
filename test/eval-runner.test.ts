// The eval runner on a scripted model: zero tokens, real fixtures, real
// native tools and real grader commands.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SAFE_DEFAULTS } from "../src/main/agents/capabilities";
import { BUILT_IN_GUARD } from "../src/main/guard";
import { createProviderDriver } from "../src/main/harness/driver";
import { emptyUsage, type AssistantPart, type LlmEvent, type LlmRequest } from "../src/main/harness/llm/types";
import { SessionStore } from "../src/main/harness/session";
import { McpClientPool, routerTools } from "../src/main/mcp/router";
import { McpToolsCache } from "../src/main/mcp/servers";
import { AgentBrowserBackend, resolveAgentBrowser } from "../src/main/browser/agent-browser";
import type { Provider } from "../src/shared/types";
import type { AgentDriver, TurnInput } from "../src/main/agents/types";
import { mcpKit, runTask, runTrial } from "../evals/lib/runner";
import type { Scenario, Task } from "../evals/lib/types";
import { loadTasks } from "../evals/run";
import { tempDir } from "./helpers";

const ROOT = join(__dirname, "..");
const FIXTURES = join(ROOT, "evals", "fixtures");
const tasks = new Map(loadTasks().map((t) => [t.id, t]));
const task = (id: string): Task => structuredClone(tasks.get(id)!);

const provider: Provider = {
  id: "eval",
  label: "eval",
  wireProtocol: "openai-chat",
  baseURL: "http://127.0.0.1:9",
  secret: { kind: "envRef", envVar: "NONE" },
  models: [{ id: "m", name: "m", capabilities: { tools: true, vision: false, reasoning: false }, contextWindow: 200_000, maxOutput: 4_000 }],
};

const call = (name: string, input: Record<string, unknown>, id = `c${Math.random().toString(36).slice(2, 8)}`): AssistantPart => ({ type: "tool-call", id, name, input });
const text = (t: string): AssistantPart => ({ type: "text", text: t });

/** A driver whose model plays `answers` in order (the last one repeats); `seen` runs before each call. */
function scripted(answers: AssistantPart[][], seen?: (cwd: string, req: LlmRequest) => void, inputTokens = 1000, mcp?: { listings: McpToolsCache; pool: McpClientPool }) {
  let calls = 0;
  const driver = (cwd: string, scenario?: Scenario) => {
    const data = tempDir();
    let n = 0;
    return createProviderDriver("eval", {
      provider: () => provider,
      secret: () => "sk-test",
      secretHeaders: () => ({}),
      sessions: new SessionStore(join(data, "sessions")),
      outputDir: join(data, "out"),
      guardScript: BUILT_IN_GUARD,
      guide: () => null,
      memory: () => scenario?.memory ?? null,
      // The app's router over the scenario's mock servers, wired like evals/lib/agents.ts.
      mcpTools: () => (mcp && scenario?.mcpServers.length ? routerTools({ servers: () => scenario.mcpServers, ...mcp }) : []),
      stream: async function* (_route, req): AsyncGenerator<LlmEvent> {
        calls++;
        seen?.(cwd, req);
        const message = answers[Math.min(n++, answers.length - 1)]!;
        const usage = { ...emptyUsage(), inputTokens, outputTokens: 50 };
        yield { type: "usage", usage };
        yield { type: "finish", reason: message.some((p) => p.type === "tool-call") ? "tool-calls" : "stop", message, usage };
      },
    });
  };
  return { driver, calls: () => calls };
}

/** A driver with just the required AgentDriver surface, running `script` per turn. */
const fakeDriver = (script: (input: TurnInput) => Promise<void>): AgentDriver => ({
  id: "fake",
  label: "Fake",
  defaultModel: "m",
  capabilities: SAFE_DEFAULTS,
  skillsDelivery: { mode: "none" },
  skillCallPrefix: "",
  models: () => [{ id: "m", label: "m" }],
  runTurn: script,
});

const FIX = [
  [call("read", { path: "src/range.js" })],
  [call("edit", { path: "src/range.js", old_string: "i < b", new_string: "i <= b" })],
  [text("Fixed: the loop now includes b.")],
];

describe("eval runner (scripted model)", () => {
  it("passes fix-off-by-one when the edit is right, with the hidden test run after the turn", async () => {
    let hiddenDuringTurn = false;
    const s = scripted(FIX, (cwd) => (hiddenDuringTurn ||= existsSync(join(cwd, "test", "range.test.mjs"))));
    const r = await runTrial({ task: task("fix-off-by-one"), fixturesRoot: FIXTURES, driver: s.driver, model: "m" });
    expect(hiddenDuringTurn).toBe(false);
    expect(r.graders.map((g) => [g.type, g.pass])).toEqual([["command", true], ["file", true], ["event", true], ["budget", true]]);
    expect(r).toMatchObject({ pass: true, score: 1, overBudget: false, harnessError: null, toolCalls: 2 });
    expect(r.inputTokens).toBeGreaterThan(0);
    expect(r.events.some((e) => e.kind === "tool-use" && e.name === "Edit")).toBe(true);
  }, 60_000);

  it("fails it when the agent only claims the tests pass", async () => {
    const s = scripted([[text("Done, all tests pass.")]]);
    const r = await runTrial({ task: task("fix-off-by-one"), fixturesRoot: FIXTURES, driver: s.driver, model: "m" });
    expect(r.pass).toBe(false);
    expect(r.graders.find((g) => g.type === "command")?.pass).toBe(false);
    expect(r.graders.find((g) => g.type === "event")?.why).toMatch(/claimed/);
    expect(r.score).toBeLessThan(0.5);
  }, 60_000);

  it("aborts a turn over its step budget and fails the budget grader", async () => {
    const t = task("explain-no-edit");
    t.budget.maxSteps = 2;
    const s = scripted([[call("read", { path: "src/sum.js" })]]);
    const r = await runTrial({ task: t, fixturesRoot: FIXTURES, driver: s.driver, model: "m" });
    expect(r.overBudget).toBe(true);
    expect(r.graders.find((g) => g.type === "budget")?.pass).toBe(false);
    expect(s.calls()).toBeLessThanOrEqual(4);
  });

  it("aborts a turn over its input-token budget", async () => {
    const t = task("explain-no-edit");
    t.budget.maxInputTokens = 500;
    const s = scripted([[call("read", { path: "src/sum.js" })]], undefined, 1000);
    const r = await runTrial({ task: t, fixturesRoot: FIXTURES, driver: s.driver, model: "m" });
    expect(r.overBudget).toBe(true);
    expect(s.calls()).toBe(1);
  });

  it("passes explain-no-edit on a read and an answer, and fails it on an edit", async () => {
    const ok = await runTrial({ task: task("explain-no-edit"), fixturesRoot: FIXTURES, driver: scripted([[call("read", { path: "src/sum.js" })], [text("It sums finite numbers.")]]).driver, model: "m" });
    expect(ok.pass).toBe(true);
    // Plan mode blocks the edit itself; the grader still sees the attempt.
    const bad = await runTrial({
      task: task("explain-no-edit"),
      fixturesRoot: FIXTURES,
      driver: scripted([[call("read", { path: "src/sum.js" })], [call("edit", { path: "src/sum.js", old_string: "total", new_string: "t" })], [text("Renamed.")]]).driver,
      model: "m",
    });
    expect(bad.graders.find((g) => g.type === "tool")?.pass).toBe(false);
    expect(bad.graders.find((g) => g.type === "file")?.pass).toBe(true);
    expect(bad.pass).toBe(false);
  });

  it("ends a plan-mode turn at the proposal and grades it", async () => {
    const s = scripted([[call("read", { path: "src/form.js" })], [call("propose_plan", { plan: "## Goal\nValidate email and age in submit()." })], [text("unreachable")]]);
    const r = await runTrial({ task: task("plan-proposes"), fixturesRoot: FIXTURES, driver: s.driver, model: "m" });
    expect(r.graders.map((g) => [g.type, g.pass])).toEqual([["event", true], ["file", true], ["event", true], ["budget", true]]);
    expect(r.pass).toBe(true);
    expect(s.calls()).toBe(2);
    expect(r.events).toContainEqual({ kind: "plan-proposal", text: expect.stringContaining("Validate email") });
  });

  it("fails plan-proposes when the agent answers without proposing a plan", async () => {
    const r = await runTrial({ task: task("plan-proposes"), fixturesRoot: FIXTURES, driver: scripted([[text("Add checks for email and age.")]]).driver, model: "m" });
    expect(r.graders[0]).toMatchObject({ type: "event", pass: false, why: "no plan proposed" });
  });

  it("writes the skill kit into each of the agent's skill folders", async () => {
    let seen: string[] = [];
    const s = scripted([[text("ok")]], (cwd) => (seen = [".agents/skills", ".claude/skills"].filter((d) => existsSync(join(cwd, d, "backup-ansible-infra", "SKILL.md")))));
    await runTrial({ task: task("route-skill-1"), fixturesRoot: FIXTURES, driver: s.driver, model: "m", skillDirs: [".claude/skills"] });
    expect(seen).toEqual([".claude/skills"]);
  });

  it("every task file loads and names an existing fixture", () => {
    expect(tasks.size).toBeGreaterThanOrEqual(20);
    for (const t of tasks.values()) expect(existsSync(join(FIXTURES, t.fixture)), t.id).toBe(true);
  });

  it("folds trials into pass@k and pass^k", async () => {
    let trial = 0;
    const driver = (cwd: string) => (trial++ === 0 ? scripted(FIX).driver(cwd) : scripted([[text("No change needed.")]]).driver(cwd));
    const r = await runTask({ task: task("fix-off-by-one"), fixturesRoot: FIXTURES, driver, model: "m", trials: 2, cacheKey: "k" });
    expect(r.trials.map((t) => t.pass)).toEqual([true, false]);
    expect(r).toMatchObject({ passAtK: true, passHatK: false, cached: false, cacheKey: "k" });
  }, 60_000);

  it("an infrastructure failure never passes, even when the graders would", async () => {
    const t = task("explain-no-edit");
    t.graders = [{ type: "file", path: "src/sum.js", unchanged: true }];
    const failing = () => ({ runTurn: async () => { throw new Error("fetch failed"); } }) as unknown as AgentDriver;
    const r = await runTrial({ task: t, fixturesRoot: FIXTURES, driver: failing, model: "m" });
    expect(r.graders[0]?.pass).toBe(true);
    expect(r).toMatchObject({ status: "harness-error", pass: false, harnessError: "fetch failed", usageCoverage: "unavailable", costCoverage: "unavailable" });
    expect(r.trialId).toMatch(/[0-9a-f-]{36}/);
  });

  it("a task with no graders is ungraded, not passed", async () => {
    const t = task("explain-no-edit");
    t.graders = [];
    const r = await runTrial({ task: t, fixturesRoot: FIXTURES, driver: scripted([[text("ok")]]).driver, model: "m" });
    expect(r).toMatchObject({ status: "ungraded", pass: false, usageCoverage: "reported" });
  });

  it("writes a redacted trace with timed events and spans", async () => {
    const dir = tempDir();
    const r = await runTrial({
      task: task("fix-off-by-one"),
      fixturesRoot: FIXTURES,
      driver: scripted(FIX).driver,
      model: "m",
      trace: { dir: join(dir, "traces", "run1"), root: dir, fidelity: "test", redact: (t) => t.replaceAll("range.js", "***") },
    });
    expect(r.trace).toMatch(/^traces\/run1\/fix-off-by-one-[0-9a-f]{8}\.json$/);
    const body = JSON.parse(readFileSync(join(dir, r.trace!), "utf8"));
    expect(body).toMatchObject({ trialId: r.trialId, status: "passed", fidelity: "test" });
    expect(body.spans.map((s: { name: string }) => s.name)).toEqual(["Read", "Edit"]);
    expect(body.events[0]).toHaveProperty("t");
    expect(JSON.stringify(body)).not.toContain("range.js");
    expect(r.toolMs).toBeGreaterThanOrEqual(0);
  }, 60_000);

  it("labels a price-derived cost as estimated", async () => {
    const r = await runTrial({ task: task("explain-no-edit"), fixturesRoot: FIXTURES, driver: scripted([[text("It adds.")]]).driver, model: "m", price: { input: 1, output: 2 } });
    expect(r.costCoverage).toBe("estimated");
    expect(r.costUsd).toBeCloseTo((1000 * 1 + 50 * 2) / 1e6);
  });

  it("runs follow-up turns on the same session and sums their root turn-end usage", async () => {
    const inputs: TurnInput[] = [];
    const base = scripted([[text("The codename is HERONFALL.")], [text("LLAFNOREH")]]);
    const driver = (cwd: string, scenario?: Scenario): AgentDriver => {
      const d = base.driver(cwd, scenario);
      return { ...d, runTurn: async (input: TurnInput) => { inputs.push(input); await d.runTurn(input); } };
    };
    const r = await runTrial({ task: task("memory-multi-turn"), fixturesRoot: FIXTURES, driver, model: "m" });
    expect(inputs).toHaveLength(2);
    expect(inputs[0]!.prompt).toBe("What's the release codename for this project?");
    expect(inputs[0]!.sessionId).toBeNull();
    expect(inputs[1]!.prompt).toBe("Spell it backwards, in capitals.");
    expect(inputs[1]!.sessionId).toBeTruthy();
    expect(r.inputTokens).toBe(2000);
    expect(r.outputTokens).toBe(100);
    expect(r.events.some((e) => e.kind === "assistant-text" && e.text?.includes("LLAFNOREH"))).toBe(true);
  }, 60_000);

  it("threads memory from the scenario into the native driver's prompt", async () => {
    let sent = "";
    const s = scripted([[text("ok")]], (_cwd, req) => (sent = req.system.join("\n")));
    await runTrial({ task: task("memory-multi-turn"), fixturesRoot: FIXTURES, driver: s.driver, model: "m" });
    expect(sent).toContain("HERONFALL");
  }, 60_000);

  it("answers requestUserInput with task.reply, or dismisses it", async () => {
    const answers: unknown[] = [];
    const ask = fakeDriver(async (input) => {
      answers.push(await input.requestUserInput!([{ id: "q1", header: "h", question: "?", options: [], multiSelect: false, allowOther: true }]));
    });
    const withReply = task("explain-no-edit");
    withReply.reply = "yes";
    await runTrial({ task: withReply, fixturesRoot: FIXTURES, driver: () => ask, model: "m" });
    expect(answers[0]).toEqual({ answers: { q1: ["yes"] } });

    await runTrial({ task: task("explain-no-edit"), fixturesRoot: FIXTURES, driver: () => ask, model: "m" });
    expect(answers[1]).toBe("dismiss");
  });

  it("mcp-lookup passes end to end: router tools call a real mock MCP server and its sentinel reaches the grader", async () => {
    const mcp = { listings: new McpToolsCache(), pool: new McpClientPool() };
    try {
      const s = scripted([[call("call_mcp_tool", { server: "mock-frontend", tool: "seed_react", arguments: { target: "main" } })], [text("Status: ok")]], undefined, 1000, mcp);
      const r = await runTrial({ task: task("mcp-lookup"), fixturesRoot: FIXTURES, driver: s.driver, model: "m" });
      expect(r.graders.map((g) => [g.type, g.pass, g.why])).toContainEqual(["mcp", true, "called mock-frontend/seed_react"]);
      expect(r.status).toBe("passed");
    } finally {
      await mcp.pool.closeAll();
    }
  }, 60_000);

  it("a browser task runs on a headless backend the runner hands it, closed after the trial", async () => {
    const calls: string[][] = [];
    const ok = (data: unknown) => ({ code: 0, stdout: JSON.stringify({ success: true, data, error: null }), stderr: "" });
    const browser = new AgentBrowserBackend({
      session: "trial",
      screenshotDir: tempDir(),
      run: async (args) => {
        calls.push(args);
        if (args[0] === "--version") return { code: 0, stdout: "agent-browser 0.27.0", stderr: "" };
        if (args[3] === "open") return ok({ title: "KESTREL-42", url: "data:x" });
        if (args[3] === "snapshot") return ok({ origin: "data:x", refs: { e1: { role: "button", name: "Ship it" } } });
        if (args[3] === "get") return ok({ title: "KESTREL-42" });
        return ok({ closed: true });
      },
    });
    let seen = "";
    const s = scripted([[call("browser_open", { url: "data:text/html,<title>KESTREL-42</title>" })], [text('The title is KESTREL-42 and the button says "Ship it".')]], (_cwd, req) => {
      const last = req.messages.at(-1);
      if (last?.role === "tool") seen = last.results.map((r) => r.text).join(" | ");
    });
    const r = await runTrial({ task: task("browser-smoke"), fixturesRoot: FIXTURES, driver: s.driver, model: "m", browser: () => browser });
    expect(seen).toContain('[e1] button "Ship it"');
    expect(r.status).toBe("passed");
    expect(calls.at(-1)?.[3]).toBe("close");
  }, 60_000);

  const headless = process.platform === "win32" ? resolveAgentBrowser() : null;
  it.skipIf(!headless || !existsSync(headless))("browser-smoke passes end to end on a real agent-browser session", async () => {
    const s = scripted([[call("browser_open", { url: task("browser-smoke").prompt.slice(task("browser-smoke").prompt.indexOf("data:")) })], [text('The title is KESTREL-42 and the button says "Ship it".')]]);
    const r = await runTrial({ task: task("browser-smoke"), fixturesRoot: FIXTURES, driver: s.driver, model: "m", browser: () => new AgentBrowserBackend({ session: `cubiq-eval-test-${process.pid}`, command: headless!, screenshotDir: tempDir() }) });
    expect(r.graders.map((g) => [g.type, g.pass])).toEqual([["answer", true], ["tool", true], ["event", true], ["budget", true]]);
  }, 120_000);

  it("mcpKit builds the task's stdio servers and tool sentinels", () => {
    const kit = mcpKit(task("mcp-lookup"))!;
    expect(kit.servers).toHaveLength(2);
    for (const s of kit.servers) {
      expect(s.spec.type).toBe("stdio");
      expect(s.enabled).toBe(true);
    }
    expect(kit.sentinels.size).toBe(20);
    expect(mcpKit(task("explain-no-edit"))).toBeUndefined();
  });

  it("--dry prints the worst case without a key or a model call", () => {
    const out = execFileSync(process.execPath.includes("bun") ? process.execPath : "bun", ["evals/run.ts", "--tier", "smoke", "--dry"], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, PGS_API_KEY: "", TOKENHARBOR_API_KEY: "" },
    });
    expect(out).toMatch(/6 tasks, 6 trials, worst case 350,000 input tokens/);
    expect(out).toContain("fix-off-by-one");
  });
});
