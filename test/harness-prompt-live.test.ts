// Live check of the native agent's first prompt: a question about the project
// starts with tool calls, not prose, and three independent reads go out in one
// step. Batching is asserted on Claude (its family notes ask for it) and only
// logged elsewhere. Requires CUBIQ_LIVE_TESTS=1 and the LIVE_* settings
// documented in .env.example. Run with a disposable provider account.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Provider, ThreadEvent } from "../src/shared/types";
import type { TurnInput } from "../src/main/agents/types";
import { BUILT_IN_GUARD } from "../src/main/guard";
import { createProviderDriver } from "../src/main/harness/driver";
import { SessionStore } from "../src/main/harness/session";
import { liveProvider } from "./live-provider";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "harness-prompt-live-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const configured = liveProvider();
const cases = [{ ...configured, batches: /claude/i.test(configured.model) }];

/** Lengths of each run of consecutive tool-use events: one run is one step's calls. */
function callRuns(events: ThreadEvent[]): number[] {
  const runs: number[] = [];
  let open = false;
  for (const e of events) {
    if (e.kind === "tool-use") {
      if (open) runs[runs.length - 1]!++;
      else runs.push(1);
      open = true;
    } else if (e.kind === "tool-result") open = false;
  }
  return runs;
}

for (const c of cases) {
  const key = process.env[c.envVar] ?? "";
  describe.skipIf(!c.enabled)(`native agent first prompt, live on ${c.label}`, () => {
    it("opens with tool calls and batches independent reads", { timeout: 300_000 }, async () => {
      const cwd = tmp();
      mkdirSync(join(cwd, "src"));
      writeFileSync(join(cwd, "src", "math.ts"), "export function add(a: number, b: number) {\n  return a + b;\n}\nexport const PI_ISH = 3.14;\n");
      writeFileSync(join(cwd, "AGENTS.md"), "# Agents\nUse tabs for indentation.\n");
      writeFileSync(join(cwd, "notes.txt"), "Release codename: KESTREL\nmore notes\n");
      const provider: Provider = {
        id: "live",
        label: c.label,
        wireProtocol: c.protocol,
        baseURL: c.baseURL,
        secret: { kind: "envRef", envVar: c.envVar },
        models: [{ id: c.model, name: c.model, capabilities: { tools: true, vision: false, reasoning: true }, contextWindow: 200_000, maxOutput: 4_000 }],
      };
      const driver = createProviderDriver("live", {
        provider: () => provider,
        secret: () => key,
        secretHeaders: () => ({}),
        sessions: new SessionStore(join(tmp(), "sessions")),
        outputDir: join(tmp(), "out"),
        guardScript: BUILT_IN_GUARD,
        guide: () => null,
        memory: () => null,
        mcpTools: () => [],
      });
      const events: ThreadEvent[] = [];
      const input: TurnInput = {
        threadId: "live",
        cwd,
        projectId: "p",
        prompt: "What does src/math.ts export, what indentation does AGENTS.md ask for, and what's the release codename in notes.txt?",
        sessionId: null,
        model: c.model,
        effort: "low",
        permissionMode: "full",
        signal: new AbortController().signal,
        onEvent: (e) => events.push(e),
        onTextDelta: () => {},
        onSession: () => {},
        requestPermission: async () => "allow-once",
        requestPlanDecision: async () => "manual",
        tools: [],
        mcpServers: [],
      };
      await driver.runTurn(input);

      const runs = callRuns(events);
      const answer = events.filter((e) => e.kind === "assistant-text").map((e) => (e as { text: string }).text).join("");
      console.log(`[${c.label}] calls per step: ${JSON.stringify(runs)}; answer: ${answer.replace(/\s+/g, " ").slice(0, 400)}`);
      for (const e of events) if (e.kind === "error") console.log(`[${c.label}] error: ${JSON.stringify(e).slice(0, 300)}`);

      // A step with no calls ends the turn, so any call at all means the first step called tools.
      expect(runs.length).toBeGreaterThan(0);
      expect(answer).toContain("KESTREL");
      // The batching rule is for the model only; the answer never talks about it.
      expect(answer).not.toMatch(/harness note|private(ly)? list|batch/i);
      if (c.batches) expect(runs[0]).toBeGreaterThanOrEqual(3);
    });
  });
}
