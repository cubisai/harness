// T2.8 — the live invariants that remain after provider injection became native
// agents: the Service scrubs keys out of stored events and live deltas, no key
// export leaks into the shell, and the subscription plan strips every key var.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentDriver, TurnInput } from "../src/main/agents/types";
import { SAFE_DEFAULTS } from "../src/main/agents/capabilities";
import { Store } from "../src/main/db";
import { type InjectionSource, injectionFor } from "../src/main/inject";
import { Service } from "../src/main/service";
import { catalog, closeAfter, tempDir } from "./helpers";

const KEY = "test-regression-key-7f3a";

afterEach(() => vi.restoreAllMocks());

describe("injectionFor subscription", () => {
  it("returns byok:false and strips every key var from the env", () => {
    const source: InjectionSource = {
      credential: () => ({ kind: "subscription" }),
      providers: () => [],
      providerSecret: () => null,
      secretEnvNames: () => ["OPENAI_API_KEY", "MY_PROVIDER_KEY"],
      get: () => ({ theme: "system", defaultAgent: null, defaultPermissionMode: "ask", autoUpdate: false, editor: null, providerInjection: {} }),
    };
    const plan = injectionFor(source, "claude", {
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "claude-shell-key",
      OPENAI_API_KEY: "openai-shell-key",
      MY_PROVIDER_KEY: "provider-shell-key",
      KEEP: "kept",
    });
    expect(plan.byok).toBe(false);
    // A provider key exported in the shell must never reach the agent.
    expect(plan.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(plan.env.OPENAI_API_KEY).toBeUndefined();
    expect(plan.env.MY_PROVIDER_KEY).toBeUndefined();
    expect(plan.env.KEEP).toBe("kept");
  });
});

describe("redaction", () => {
  it("the Service scrubs a key out of every stored event and live delta", async () => {
    const store = new Store(join(tempDir(), "t.db"));
    closeAfter(() => store.close());
    const driver: AgentDriver = {
      id: "fake",
      label: "Fake",
      defaultModel: "m",
      capabilities: SAFE_DEFAULTS,
      skillsDelivery: { mode: "none" },
      skillCallPrefix: "",
      models: () => [{ id: "m", label: "M" }],
      runTurn: async (input: TurnInput) => {
        input.onTextDelta(`echo ${KEY}`);
        input.onEvent({ kind: "notice", text: `retrying with ${KEY}` });
        input.onEvent({ kind: "error", message: `401 for key ${KEY}` });
      },
    };
    const broadcasts: unknown[] = [];
    const service = new Service(store, () => catalog(), [driver], (u) => void broadcasts.push(u), undefined, undefined, undefined, () => [KEY]);
    const thread = service.createThread(store.addProject(tempDir()).id);
    await service.send({ threadId: thread.id, text: "hi" });
    const events = JSON.stringify(store.listEvents(thread.id));
    expect(events).not.toContain(KEY);
    expect(events).toContain("«redacted»");
    expect(JSON.stringify(broadcasts)).not.toContain(KEY);
    expect(JSON.stringify(broadcasts)).toContain("echo «redacted»");
  });

  it("no global key export remains", () => {
    const index = readFileSync(join(__dirname, "..", "src", "main", "index.ts"), "utf-8");
    expect(index).not.toMatch(/applySecretsToEnv|inheritedEnv/);
    expect(index).not.toMatch(/process\.env\[[^\]]+\]\s*=/);
  });
});
