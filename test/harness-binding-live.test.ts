// Live check that the native agent never replays signed thinking after it
// rewrote history: a small context window forces an auto-compaction mid-turn,
// then a memory change between turns changes the system prompt. Both must go
// through without a 400. Skipped unless the provider's key is in the
// environment (load it from .env: `bun --env-file=.env x vitest run test/harness-binding-live.test.ts`).
// TH_BINDING_MODEL / PGS_BINDING_MODEL override the models.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Provider, ThreadEvent } from "../src/shared/types";
import type { TurnInput } from "../src/main/agents/types";
import { BUILT_IN_GUARD } from "../src/main/guard";
import { createProviderDriver } from "../src/main/harness/driver";
import { SessionStore } from "../src/main/harness/session";
import type { HarnessProtocol } from "../src/main/harness/llm/types";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "harness-binding-live-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

interface Case {
  label: string;
  envVar: string;
  baseURL: string;
  protocol: HarnessProtocol;
  model: string;
}

const cases: Case[] = [
  { label: "TokenHarbor Claude (Messages)", envVar: "TOKENHARBOR_API_KEY", baseURL: "https://tokenharbor.ai/v1", protocol: "anthropic-messages", model: process.env.TH_BINDING_MODEL ?? "claude-haiku-5.5" },
  { label: "PGS Grove DeepSeek (Messages)", envVar: "PGS_API_KEY", baseURL: "https://api.pgsgrove.com/v1", protocol: "anthropic-messages", model: process.env.PGS_BINDING_MODEL ?? "deepseek-v4.1-flash" },
  { label: "PGS Grove DeepSeek (chat)", envVar: "PGS_API_KEY", baseURL: "https://api.pgsgrove.com/v1", protocol: "openai-chat", model: process.env.PGS_BINDING_MODEL ?? "deepseek-v4.1-flash" },
];

for (const c of cases) {
  const key = process.env[c.envVar] ?? "";
  describe.skipIf(!key)(`native agent history rewrites, live on ${c.label}`, () => {
    it("compacts mid-turn and survives a prefix change between turns", { timeout: 600_000 }, async () => {
      const cwd = tmp();
      // Four files of ~6k tokens each: reading them overflows a 24k window, so the turn auto-compacts.
      for (const name of ["a", "b", "c", "d"]) writeFileSync(join(cwd, `${name}.txt`), `FIRST LINE OF ${name.toUpperCase()}\n${`${name} filler line for the context test\n`.repeat(700)}`);
      const provider: Provider = {
        id: "live",
        label: c.label,
        wireProtocol: c.protocol,
        baseURL: c.baseURL,
        secret: { kind: "envRef", envVar: c.envVar },
        contextWindowOverride: 24_000,
        models: [{ id: c.model, name: c.model, capabilities: { tools: true, vision: false, reasoning: true }, contextWindow: 200_000, maxOutput: 4_000 }],
      };
      const sessions = new SessionStore(join(tmp(), "sessions"));
      let memory = "<harness-memory>\nNo notes yet.\n</harness-memory>";
      const driver = createProviderDriver("live", {
        provider: () => provider,
        secret: () => key,
        secretHeaders: () => ({}),
        sessions,
        outputDir: join(tmp(), "out"),
        guardScript: BUILT_IN_GUARD,
        guide: () => null,
        memory: () => memory,
        mcpTools: () => [],
      });
      let session: string | null = null;
      const events: ThreadEvent[] = [];
      const usages: { cacheReadTokens?: number | null }[] = [];
      const input = (prompt: string): TurnInput => ({
        threadId: "live",
        cwd,
        projectId: "p",
        prompt,
        sessionId: session,
        model: c.model,
        effort: "low",
        permissionMode: "full",
        signal: new AbortController().signal,
        onEvent: (e) => events.push(e),
        onTextDelta: () => {},
        onUsageUpdate: (u) => usages.push(u),
        onSession: (id) => (session = id),
        requestPermission: async () => "allow-once",
        requestPlanDecision: async () => "manual",
        tools: [],
        mcpServers: [],
      });

      await driver.runTurn(input("Use the read tool on a.txt, then b.txt, then c.txt, then d.txt: one file per step, in that order. Then reply with only the first line of each file."));
      const compactions = events.filter((e) => e.kind === "compaction");
      console.log(`[${c.label}] turn 1: ${compactions.length} compaction(s), ${usages.length} usage updates`);
      for (const e of events) if (e.kind === "error" || e.kind === "notice") console.log(`[${c.label}] ${e.kind}: ${JSON.stringify(e).slice(0, 300)}`);
      expect(compactions.length).toBeGreaterThan(0);

      // A new memory note changes the system prompt: earlier thinking must not go back.
      memory = "<harness-memory>\nuser-likes-short-answers.md: the user wants one-line answers\n</harness-memory>";
      const before = events.length;
      await driver.runTurn(input("What is the first line of a.txt? One line."));
      const turn2 = events.slice(before);
      const answer = turn2.filter((e) => e.kind === "assistant-text").map((e) => (e as { text: string }).text).join("");
      console.log(`[${c.label}] turn 2 answer: ${answer.slice(0, 120)}`);
      expect(turn2.some((e) => e.kind === "turn-end")).toBe(true);

      // A third turn with the same prefix should read the cached prefix (where the provider reports it).
      const usageBefore = usages.length;
      await driver.runTurn(input("And the first line of b.txt? One line."));
      const reads = usages.slice(usageBefore).map((u) => u.cacheReadTokens ?? 0);
      console.log(`[${c.label}] turn 3 cache reads: ${JSON.stringify(reads)}`);
    });
  });
}
