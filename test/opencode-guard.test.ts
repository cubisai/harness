import { appendFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ThreadEvent } from "../src/shared/types";
import { createAcpDriver, DEFAULT_MODEL } from "../src/main/agents/acp/driver";
import { ACP_PRESETS, onPath } from "../src/main/agents/registry";
import { findPython } from "../src/main/guard";
import { type InjectionPlan } from "../src/main/inject";
import { ensureOpenCodeGuard, withOpenCodeGuard } from "../src/main/inject/opencode-guard";
import { closeAfter, fixturesDir, tempDir } from "./helpers";

const GUARD = join(fixturesDir, "fake-guard.py");

describe("withOpenCodeGuard", () => {
  it("adds the plugin to a subscription plan that has no config", () => {
    const plan: InjectionPlan = { env: { PATH: "/usr/bin" }, byok: false };
    const out = withOpenCodeGuard(plan, { pluginUrl: "file:///tmp/opencode-guard.mjs", script: "/s.py", python: ["python3"] });
    expect(out).toBe(plan);
    const config = JSON.parse(out.env.OPENCODE_CONFIG_CONTENT!) as { $schema: string; plugin: string[] };
    expect(config.$schema).toBe("https://opencode.ai/config.json");
    expect(config.plugin).toEqual(["file:///tmp/opencode-guard.mjs"]);
    expect(out.env.UNSKILLED_GUARD_SCRIPT).toBe("/s.py");
    expect(out.env.UNSKILLED_GUARD_PYTHON).toBe(JSON.stringify(["python3"]));
  });

  it("keeps a BYOK provider's config and appends to its plugins", () => {
    const plan: InjectionPlan = {
      env: {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ $schema: "https://opencode.ai/config.json", provider: { gw: { npm: "@ai-sdk/openai-compatible" } }, plugin: ["file:///existing.mjs"] }),
      },
      byok: true,
    };
    withOpenCodeGuard(plan, { pluginUrl: "file:///new.mjs", script: "/s.py", python: ["python3", "-u"] });
    const config = JSON.parse(plan.env.OPENCODE_CONFIG_CONTENT!) as { provider: Record<string, unknown>; plugin: string[] };
    expect(config.provider).toEqual({ gw: { npm: "@ai-sdk/openai-compatible" } });
    expect(config.plugin).toEqual(["file:///existing.mjs", "file:///new.mjs"]);
  });

  it("leaves an errored plan untouched", () => {
    const plan: InjectionPlan = { env: {}, byok: true, error: "no key" };
    expect(withOpenCodeGuard(plan, { pluginUrl: "file:///x.mjs", script: "/s.py", python: ["python3"] })).toBe(plan);
    expect(plan.env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
  });
});

describe("ensureOpenCodeGuard", () => {
  it("writes the plugin once and returns its file URL", () => {
    const dir = tempDir();
    const url = ensureOpenCodeGuard(dir);
    expect(url.startsWith("file://")).toBe(true);
    expect(fileURLToPath(url)).toBe(join(dir, "opencode-guard.mjs"));
    const first = statSync(fileURLToPath(url)).mtimeMs;
    expect(ensureOpenCodeGuard(dir)).toBe(url);
    expect(statSync(fileURLToPath(url)).mtimeMs).toBe(first);
  });
});

describe.skipIf(!findPython())("the generated OpenCode guard plugin", () => {
  it("rejects a blocked command and resolves the rest", async () => {
    const url = ensureOpenCodeGuard(tempDir());
    const mod = (await import(url)) as { default: (ctx: unknown) => Promise<Record<string, (input: unknown, output: unknown) => Promise<void>>> };
    const hooks = await mod.default({});
    const before = hooks["tool.execute.before"]!;
    const previousScript = process.env.UNSKILLED_GUARD_SCRIPT;
    const previousPython = process.env.UNSKILLED_GUARD_PYTHON;
    process.env.UNSKILLED_GUARD_SCRIPT = GUARD;
    process.env.UNSKILLED_GUARD_PYTHON = JSON.stringify(findPython());
    try {
      await expect(before({ tool: "bash" }, { args: { command: "git push --force" } })).rejects.toThrow(/Blocked by git guardrails/);
      await expect(before({ tool: "bash" }, { args: { command: "ls" } })).resolves.toBeUndefined();
      // A non-bash tool never spawns the guard, even with a dangerous-looking command.
      await expect(before({ tool: "read" }, { args: { command: "git push --force" } })).resolves.toBeUndefined();
    } finally {
      if (previousScript === undefined) delete process.env.UNSKILLED_GUARD_SCRIPT;
      else process.env.UNSKILLED_GUARD_SCRIPT = previousScript;
      if (previousPython === undefined) delete process.env.UNSKILLED_GUARD_PYTHON;
      else process.env.UNSKILLED_GUARD_PYTHON = previousPython;
    }
  });
});

const KEY = "test-opencode-guard-key";

/** A fake chat endpoint: the first request with tools answers a bash tool call, the rest say done. */
function startFakeToolChat(): Promise<{ server: Server; url: string; bodies: unknown[] }> {
  const bodies: unknown[] = [];
  let sentToolCall = false;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) return void res.writeHead(404).end();
      let parsed: { model?: string; tools?: unknown };
      try {
        parsed = JSON.parse(body) as { model?: string; tools?: unknown };
      } catch {
        return void res.writeHead(400).end();
      }
      bodies.push(parsed);
      if (process.env.DEBUG_OC_TOOLS && Array.isArray(parsed.tools)) {
        appendFileSync("/tmp/oc-tools.log", `${(parsed.tools as { function?: { name?: string } }[]).map((t) => t.function?.name).join(",")}\n`);
      }
      const model = parsed.model ?? "unknown";
      const hasTools = Array.isArray(parsed.tools) && parsed.tools.length > 0;
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (hasTools && !sentToolCall) {
        sentToolCall = true;
        res.end(
          [
            `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "git push --force origin main", description: "push" }) } }] }, finish_reason: null }] })}\n\n`,
            `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
            "data: [DONE]\n\n",
          ].join(""),
        );
      } else {
        res.end(
          [
            `data: ${JSON.stringify({ id: "c2", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] })}\n\n`,
            `data: ${JSON.stringify({ id: "c2", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } })}\n\n`,
            "data: [DONE]\n\n",
          ].join(""),
        );
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, bodies }));
  });
}

describe.skipIf(!onPath("opencode") || !findPython())("OpenCode guard plugin end to end (real acp, fake model)", () => {
  it("blocks a guarded bash call and sends the error back to the model", async () => {
    // Never touch the user's real ~/.config/opencode and friends.
    const xdgConfig = tempDir();
    const previous = {
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
      XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
      XDG_STATE_HOME: process.env.XDG_STATE_HOME,
      OPENCODE_DISABLE_AUTOUPDATE: process.env.OPENCODE_DISABLE_AUTOUPDATE,
      OPENCODE_DISABLE_MODELS_FETCH: process.env.OPENCODE_DISABLE_MODELS_FETCH,
    };
    process.env.XDG_CONFIG_HOME = xdgConfig;
    process.env.XDG_DATA_HOME = tempDir();
    process.env.XDG_CACHE_HOME = tempDir();
    process.env.XDG_STATE_HOME = tempDir();
    process.env.OPENCODE_DISABLE_AUTOUPDATE = "1";
    process.env.OPENCODE_DISABLE_MODELS_FETCH = "1";
    closeAfter(() => {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });

    const fake = await startFakeToolChat();
    closeAfter(() => void fake.server.close());

    const preset = ACP_PRESETS.find((p) => p.id === "opencode")!;
    const pluginUrl = ensureOpenCodeGuard(tempDir());
    const driver = createAcpDriver(preset, {
      clientVersion: "test",
      guardScript: GUARD,
      injection: () => {
        // The provider is its own native agent now, so the injection plan is
        // built by hand: point OpenCode at the fake server via OPENCODE_CONFIG_CONTENT.
        const config = {
          $schema: "https://opencode.ai/config.json",
          provider: {
            gw: {
              npm: "@ai-sdk/openai-compatible",
              name: "GW",
              options: { baseURL: fake.url, apiKey: KEY },
              models: { "vendor/wire-1": { name: "Picked" } },
            },
          },
          model: "gw/vendor/wire-1",
        };
        const plan: InjectionPlan = {
          env: { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) },
          byok: false,
        };
        return withOpenCodeGuard(plan, {
          pluginUrl,
          script: GUARD,
          python: findPython()!,
        });
      },
    });
    closeAfter(() => driver.dispose?.());

    const events: ThreadEvent[] = [];
    await driver.runTurn({
      threadId: "t",
      cwd: tempDir(),
      prompt: "Push the branch.",
      sessionId: null,
      model: DEFAULT_MODEL,
      // Full so OpenCode's own permission prompt doesn't interfere: the plugin is the guard.
      permissionMode: "full",
      signal: new AbortController().signal,
      tools: [],
      mcpServers: [],
      onEvent: (e) => events.push(e),
      onTextDelta: () => {},
      onSession: () => {},
      requestPermission: async () => "deny",
      requestPlanDecision: async () => ({ keep: "" }),
    });

    const seen = fake.bodies.map((b) => JSON.stringify(b)).join("\n");
    expect(seen).toContain("Blocked by git guardrails");
  }, 120_000);
});
