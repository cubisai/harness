// T2.8 — the phase's invariants for every injector in one place: a complete
// environment (PATH/HOME), no key in anything serialized or logged, and no file
// inside the project. Plus T2.7's redaction of the event and error paths.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentDriver, TurnInput } from "../src/main/agents/types";
import { SAFE_DEFAULTS } from "../src/main/agents/capabilities";
import { Store } from "../src/main/db";
import { type InjectionSource, type InjectorKind, injectionFor } from "../src/main/inject";
import { prepareCodexPlan } from "../src/main/inject/codex";
import { Service } from "../src/main/service";
import type { Provider, WireProtocol } from "../src/shared/types";
import { catalog, closeAfter, tempDir } from "./helpers";

const KEY = "test-regression-key-7f3a";
const CIPHERTEXT = Buffer.from(KEY).toString("base64");

function provider(id: string, wireProtocol: WireProtocol): Provider {
  return {
    id,
    label: id,
    wireProtocol,
    baseURL: `https://${id}.example.com/v1`,
    secret: { kind: "safeStorage", ciphertext: CIPHERTEXT },
    models: [{ id: "m", capabilities: { tools: true, vision: false, reasoning: false }, contextWindow: 8000, maxOutput: 1024 }],
  };
}

function source(p: Provider): InjectionSource {
  return {
    credential: () => ({ kind: "byok", providerId: p.id }),
    providers: () => [p],
    providerSecret: () => KEY,
    secretEnvNames: () => [],
    get: () => ({ theme: "system", defaultAgent: null, defaultPermissionMode: "ask", autoUpdate: false, editor: null, providerInjection: {} }),
  };
}

const AGENTS: { agent: string; protocol: WireProtocol; injector?: InjectorKind }[] = [
  { agent: "claude", protocol: "anthropic-messages", injector: "claude" },
  { agent: "codex", protocol: "openai-responses", injector: "codex" },
  { agent: "opencode", protocol: "openai-chat", injector: "opencode" },
  { agent: "cursor", protocol: "openai-chat" }, // the generic ACP injector
];

afterEach(() => vi.restoreAllMocks());

describe("every injector", () => {
  for (const { agent, protocol, injector } of AGENTS) {
    it(`${agent}: complete env, key never serialized, no file in the project`, () => {
      const cwd = tempDir();
      const logged: string[] = [];
      for (const level of ["log", "warn", "error"] as const) {
        vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));
      }
      const plan = injectionFor(source(provider("gw", protocol)), agent, process.env, {
        injector,
        codexCatalogDir: tempDir(),
        codexInstructions: () => "test instructions",
        opencodeVersion: () => "1.18.32",
        agentLabel: agent,
      });
      expect(plan.error).toBeUndefined();
      expect(plan.env.PATH).toBe(process.env.PATH);
      expect(plan.env.HOME).toBe(process.env.HOME);
      // The key is in the env (that's the point) but nowhere else.
      expect(Object.values(plan.env)).toContain(KEY);
      expect(JSON.stringify(plan)).not.toContain(KEY);
      for (const arg of plan.args ?? []) expect(arg).not.toContain(KEY);
      for (const file of plan.files ?? []) {
        expect(file.path.startsWith(cwd)).toBe(false);
        expect(file.contents).not.toContain(KEY);
      }
      expect(logged.join("\n")).not.toContain(KEY);
    });
  }
});

describe("redaction on failure paths", () => {
  it("a Codex catalog that can't be written fails without leaking the key", () => {
    const logged: string[] = [];
    for (const level of ["log", "warn", "error"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));
    }
    // A file where the folder's parent should be: unwritable on every OS (chmod doesn't stop writes on Windows).
    const blocker = join(tempDir(), "not-a-dir");
    writeFileSync(blocker, "");
    const plan = prepareCodexPlan(
      injectionFor(source(provider("gw", "openai-responses")), "codex", process.env, {
        injector: "codex",
        codexCatalogDir: join(blocker, "catalogs"),
        codexInstructions: () => "x",
      }),
      "codex",
    );
    expect(plan.error).toMatch(/Couldn't write the Codex model catalog/);
    for (const text of [plan.error!, JSON.stringify(plan), logged.join("\n")]) {
      expect(text).not.toContain(KEY);
      expect(text).not.toContain(CIPHERTEXT);
    }
  });

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
    const service = new Service(store, catalog(), [driver], (u) => void broadcasts.push(u), undefined, undefined, undefined, () => [KEY]);
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
