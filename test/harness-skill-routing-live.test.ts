// Live skill-routing eval for the native agent: the N1 mock kit's skills
// (overlapping descriptions, a sentinel per body) in a throwaway project, and
// its labelled prompts. Per provider it reports hits (the right skill loaded),
// misses, wrong picks and false calls (a skill loaded for a prompt that needs
// none), and asserts no false calls and at least 2 of 3 clear-cut hits.
// Skipped unless the provider's key is in the environment (load .env first:
// `set -a; . ./.env; set +a; bunx vitest run test/harness-skill-routing-live.test.ts`).
// ROUTING_SKILLS sets the kit size (default 50, the medium preset);
// TH_ROUTING_MODEL / PGS_ROUTING_MODEL override the models.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { generate } from "../scripts/mock-extensions-lib.mjs";
import type { Provider, ThreadEvent } from "../src/shared/types";
import type { TurnInput } from "../src/main/agents/types";
import { BUILT_IN_GUARD } from "../src/main/guard";
import { createProviderDriver } from "../src/main/harness/driver";
import { SessionStore } from "../src/main/harness/session";
import type { HarnessProtocol } from "../src/main/harness/llm/types";
import { discoverSkills } from "../src/main/skills/discover";
import { skillTool } from "../src/main/skills/tool";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "harness-routing-live-"));
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
  { label: "TokenHarbor Claude (Messages)", envVar: "TOKENHARBOR_API_KEY", baseURL: "https://tokenharbor.ai/v1", protocol: "anthropic-messages", model: process.env.TH_ROUTING_MODEL ?? "claude-haiku-5.5" },
  { label: "PGS Grove DeepSeek (chat)", envVar: "PGS_API_KEY", baseURL: "https://api.pgsgrove.com/v1", protocol: "openai-chat", model: process.env.PGS_ROUTING_MODEL ?? "deepseek-v4.1-flash" },
];

const SKILLS = Number(process.env.ROUTING_SKILLS ?? 50);

for (const c of cases) {
  const key = process.env[c.envVar] ?? "";
  describe.skipIf(!key)(`native agent skill routing, live on ${c.label}`, () => {
    it("loads the right skill and none for plain questions", { timeout: 900_000 }, async () => {
      const cwd = tmp();
      // Only the skills go into the project: the manifest holds the answers.
      const kit = generate({ skills: SKILLS, servers: 0, tools: 0, seed: 7, serverScript: "" });
      for (const f of kit.files.filter((f) => f.path.startsWith(".agents/skills/"))) {
        mkdirSync(dirname(join(cwd, f.path)), { recursive: true });
        writeFileSync(join(cwd, f.path), f.content);
      }
      const evals = kit.manifest.evals.filter((e) => e.kind !== "tool");
      const sentinelOwner = new Map(kit.manifest.skills.map((s) => [s.sentinel, s.name]));
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
        skills: (dir) => skillTool(() => discoverSkills({ origin: "project", dir: join(dir, ".agents", "skills") })),
      });

      const rows: { id: string; kind: string; result: "hit" | "miss" | "wrong" | "false-call" | "ok"; loaded: string[]; inputTokens: number }[] = [];
      for (const e of evals) {
        const events: ThreadEvent[] = [];
        const input: TurnInput = {
          threadId: `routing-${e.id}`,
          cwd,
          projectId: "p",
          prompt: e.prompt,
          sessionId: null,
          model: c.model,
          effort: "low",
          permissionMode: "plan",
          signal: new AbortController().signal,
          onEvent: (ev) => events.push(ev),
          onTextDelta: () => {},
          onSession: () => {},
          requestPermission: async () => "deny",
          requestPlanDecision: async () => "manual",
          tools: [],
          mcpServers: [],
        };
        await driver.runTurn(input);
        const seen = JSON.stringify(events);
        const loaded = [...sentinelOwner].filter(([sentinel]) => seen.includes(sentinel)).map(([, name]) => name);
        const want = e.expect.map((s) => sentinelOwner.get(s)!);
        const result = e.kind === "none" ? (loaded.length ? "false-call" : "ok") : want.every((w) => loaded.includes(w)) ? "hit" : loaded.length ? "wrong" : "miss";
        const end = events.find((ev) => ev.kind === "turn-end") as { inputTokens?: number } | undefined;
        rows.push({ id: e.id, kind: e.kind, result, loaded, inputTokens: end?.inputTokens ?? 0 });
      }

      console.log(`[${c.label}] ${SKILLS} skills, model ${c.model}`);
      for (const r of rows) console.log(`[${c.label}]   ${r.id.padEnd(12)} ${r.result.padEnd(10)} loaded=${r.loaded.join(",") || "-"} in=${r.inputTokens}`);
      const count = (kind: string, result: string) => rows.filter((r) => r.kind === kind && r.result === result).length;
      console.log(`[${c.label}] skill hits ${count("skill", "hit")}/${count("skill", "hit") + count("skill", "miss") + count("skill", "wrong")}, ambiguous hits ${count("ambiguous", "hit")}, false calls ${count("none", "false-call")}`);

      expect(count("none", "false-call")).toBe(0);
      expect(count("skill", "hit")).toBeGreaterThanOrEqual(2);
    });
  });
}
