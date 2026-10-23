// CubiQ's permission modes on OpenCode: its plugin asks the app before every
// edit and command (OpenCode itself only asks when its own config says so).
// The server, the mode decision, the plugin against a fake app, and real
// OpenCode end to end with a fake model.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PermissionDecision, PermissionMode, ThreadEvent } from "../src/shared/types";
import { startAskServer, type PluginAsk } from "../src/main/agents/acp/ask-server";
import { createAcpDriver, decidePluginAsk, DEFAULT_MODEL } from "../src/main/agents/acp/driver";
import { ACP_PRESETS, onPath } from "../src/main/agents/registry";
import type { InjectionPlan } from "../src/main/inject";
import { ensureOpenCodeGuard, withOpenCodeGuard } from "../src/main/inject/opencode-guard";
import { BUILT_IN_GUARD } from "../src/main/guard";
import { closeAfter, tempDir } from "./helpers";

const ask = (over: Partial<PluginAsk> = {}): PluginAsk => ({ tool: "bash", kind: "execute", summary: "echo hi", callID: "call_1", ...over });

async function post(url: string, token: string | null, body: unknown): Promise<{ status: number; decision?: string }> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: res.status, ...(res.ok ? ((await res.json()) as { decision: string }) : {}) };
}

describe("startAskServer", () => {
  it("routes each token to its own process's handler, refuses others, and denies when the handler throws", async () => {
    const server = await startAskServer();
    closeAfter(() => void server.close());
    const a = server.register(async () => "allow-once");
    const b = server.register(async () => {
      throw new Error("boom");
    });
    expect(await post(server.url, a, ask())).toEqual({ status: 200, decision: "allow-once" });
    expect(await post(server.url, b, ask())).toEqual({ status: 200, decision: "deny" });
    expect((await post(server.url, null, ask())).status).toBe(401);
    expect((await post(server.url, "nope", ask())).status).toBe(401);
    expect((await post(server.url, a, { tool: "bash", kind: "read" })).status).toBe(400);
    server.revoke(a);
    expect((await post(server.url, a, ask())).status).toBe(401);
  });

  it("aborts the handler's signal when the plugin's request closes unanswered, and not after an answer", async () => {
    const server = await startAskServer();
    closeAfter(() => void server.close());
    let withdrawn!: () => void;
    const aborted = new Promise<void>((resolve) => (withdrawn = resolve));
    const waiting = server.register((_ask, signal) => {
      signal.addEventListener("abort", () => withdrawn(), { once: true });
      return new Promise<never>(() => {}); // the user never answers
    });
    const cut = new AbortController();
    const req = fetch(server.url, { method: "POST", headers: { authorization: `Bearer ${waiting}` }, body: JSON.stringify(ask()), signal: cut.signal }).catch(() => null);
    await new Promise((r) => setTimeout(r, 100));
    cut.abort();
    await req;
    await aborted;

    let abortedAfterAnswer = false;
    const answered = server.register(async (_ask, signal) => {
      signal.addEventListener("abort", () => (abortedAfterAnswer = true));
      return "allow-once";
    });
    expect(await post(server.url, answered, ask())).toEqual({ status: 200, decision: "allow-once" });
    await new Promise((r) => setTimeout(r, 50));
    expect(abortedAfterAnswer).toBe(false);
  });
});

describe("decidePluginAsk", () => {
  const run = async (mode: PermissionMode, kind: PluginAsk["kind"], answer: PermissionDecision = "allow-once") => {
    const asked: { toolName: string; summary: string }[] = [];
    const decision = await decidePluginAsk({ permissionMode: mode, requestPermission: async (r) => (asked.push(r), answer) }, ask({ kind, summary: kind === "edit" ? "src/a.ts" : "echo hi" }));
    return { decision, asked };
  };

  it("Full allows edits and commands without asking", async () => {
    expect(await run("full", "edit")).toEqual({ decision: "allow-once", asked: [] });
    expect(await run("full", "execute")).toEqual({ decision: "allow-once", asked: [] });
  });

  it("Auto-edit allows edits and asks before commands", async () => {
    expect(await run("auto-edit", "edit")).toEqual({ decision: "allow-once", asked: [] });
    expect(await run("auto-edit", "execute", "deny")).toEqual({ decision: "deny", asked: [{ toolName: "Run", summary: "echo hi", canAlwaysAllow: false }] });
  });

  it("Ask asks before both and returns the user's answer", async () => {
    expect(await run("ask", "edit", "deny")).toEqual({ decision: "deny", asked: [{ toolName: "Edit", summary: "src/a.ts", canAlwaysAllow: false }] });
    expect((await run("ask", "execute")).decision).toBe("allow-once");
  });

  it("passes the ask's signal to the card, so a dropped request can withdraw it", async () => {
    const gone = new AbortController();
    let got: AbortSignal | undefined;
    await decidePluginAsk({ permissionMode: "ask", requestPermission: async (r) => ((got = r.signal), "deny") }, ask(), gone.signal);
    expect(got).toBe(gone.signal);
  });

  it("Plan defers to OpenCode's plan agent and its ACP asks, as before", async () => {
    expect(await run("plan", "edit")).toEqual({ decision: null, asked: [] });
    expect(await run("plan", "execute")).toEqual({ decision: null, asked: [] });
  });

  it("decides a sub-agent's own permission ask in every mode: Full allows, Ask shows it by name, Plan refuses all but reads", async () => {
    const outside = (permission: string, mode: PermissionMode, answer: PermissionDecision = "allow-once") => {
      const asked: { toolName: string; summary: string }[] = [];
      return decidePluginAsk({ permissionMode: mode, requestPermission: async (r) => (asked.push(r), answer) }, ask({ tool: permission, kind: "permission", summary: "/tmp/*" })).then((decision) => ({ decision, asked }));
    };
    expect(await outside("external_directory", "full")).toEqual({ decision: "allow-once", asked: [] });
    expect(await outside("external_directory", "ask", "deny")).toEqual({ decision: "deny", asked: [{ toolName: "external_directory", summary: "/tmp/*", canAlwaysAllow: false }] });
    expect((await outside("external_directory", "auto-edit")).asked).toHaveLength(1);
    expect(await outside("external_directory", "plan")).toEqual({ decision: "deny", asked: [] });
    expect(await outside("read", "plan")).toEqual({ decision: "allow-once", asked: [] });
    expect(await outside("edit", "auto-edit")).toEqual({ decision: "allow-once", asked: [] });
  });
});

describe("withOpenCodeGuard without Python", () => {
  it("still adds the plugin (it asks CubiQ) but sets no guard script", () => {
    const plan: InjectionPlan = { env: { PATH: "/usr/bin" }, byok: false };
    withOpenCodeGuard(plan, { pluginUrl: "file:///tmp/opencode-guard.mjs" });
    expect((JSON.parse(plan.env.OPENCODE_CONFIG_CONTENT!) as { plugin: string[] }).plugin).toEqual(["file:///tmp/opencode-guard.mjs"]);
    expect(plan.env.UNSKILLED_GUARD_SCRIPT).toBeUndefined();
    expect(plan.env.UNSKILLED_GUARD_PYTHON).toBeUndefined();
  });
});

type Hook = (input: unknown, output: unknown) => Promise<void>;

describe("the generated plugin's ask", () => {
  async function hook(): Promise<Hook> {
    const mod = (await import(ensureOpenCodeGuard(tempDir()))) as { default: () => Promise<Record<string, Hook>> };
    return (await mod.default())["tool.execute.before"]!;
  }

  function withEnv(vars: Record<string, string | undefined>): void {
    const previous = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    closeAfter(() => {
      for (const [k, v] of Object.entries(previous)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
  }

  it("asks the app for edits and commands, passes on an allow, and throws the denial to the model", async () => {
    const server = await startAskServer();
    closeAfter(() => void server.close());
    const seen: PluginAsk[] = [];
    const token = server.register(async (a) => (seen.push(a), a.summary.includes("rm") ? "deny" : "allow-once"));
    withEnv({ CUBIQ_ASK_URL: server.url, CUBIQ_ASK_TOKEN: token, UNSKILLED_GUARD_SCRIPT: undefined });
    const before = await hook();
    await expect(before({ tool: "bash", sessionID: "s", callID: "c1" }, { args: { command: "ls" } })).resolves.toBeUndefined();
    await expect(before({ tool: "bash", sessionID: "s", callID: "c2" }, { args: { command: "rm -rf x" } })).rejects.toThrow("The user denied this command.");
    await expect(before({ tool: "write", sessionID: "s", callID: "c3" }, { args: { filePath: "/p/a.txt", content: "hi" } })).resolves.toBeUndefined();
    await expect(before({ tool: "apply_patch", sessionID: "s", callID: "c4" }, { args: { patchText: "*** Begin Patch\n*** Update File: src/b.ts\n@@\n-a\n+b\n*** End Patch" } })).resolves.toBeUndefined();
    // Reads and other tools never ask.
    await expect(before({ tool: "read", sessionID: "s", callID: "c5" }, { args: { filePath: "/p/a.txt" } })).resolves.toBeUndefined();
    expect(seen.map((a) => [a.tool, a.kind, a.summary, a.callID])).toEqual([
      ["bash", "execute", "ls", "c1"],
      ["bash", "execute", "rm -rf x", "c2"],
      ["write", "edit", "/p/a.txt", "c3"],
      ["apply_patch", "edit", "src/b.ts", "c4"],
    ]);
  });

  it("waits as long as the user takes: the ask turns off Bun's 300 s fetch timeout", async () => {
    withEnv({ CUBIQ_ASK_URL: "http://127.0.0.1:9/ask", CUBIQ_ASK_TOKEN: "t", UNSKILLED_GUARD_SCRIPT: undefined });
    const inits: RequestInit[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => (inits.push(init), new Response(JSON.stringify({ decision: "allow-once" })))) as typeof fetch;
    closeAfter(() => void (globalThis.fetch = real));
    const before = await hook();
    await expect(before({ tool: "bash", callID: "c" }, { args: { command: "ls" } })).resolves.toBeUndefined();
    expect(inits).toHaveLength(1);
    expect((inits[0] as RequestInit & { timeout?: unknown }).timeout).toBe(false);
  });

  async function eventHook(client: unknown): Promise<(input: unknown) => Promise<void>> {
    const mod = (await import(ensureOpenCodeGuard(tempDir()))) as { default: (ctx: unknown) => Promise<{ event: (input: unknown) => Promise<void> }> };
    return (await mod.default({ client })).event;
  }

  function fakeClient(parents: Record<string, string | undefined>) {
    const replies: { id: string; permissionID: string; response: string }[] = [];
    return {
      replies,
      session: { get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, ...(parents[path.id] ? { parentID: parents[path.id] } : {}) } }) },
      postSessionIdPermissionsPermissionId: async ({ path, body }: { path: { id: string; permissionID: string }; body: { response: string } }) => void replies.push({ ...path, response: body.response }),
    };
  }

  const asked = (sessionID: string, id: string) => ({ event: { type: "permission.asked", properties: { id, sessionID, permission: "external_directory", patterns: ["/tmp/*"], metadata: {}, always: [] } } });

  it("answers a sub-agent's own permission ask with the app's decision, and leaves the main session's to ACP", async () => {
    const server = await startAskServer();
    closeAfter(() => void server.close());
    const seen: PluginAsk[] = [];
    const token = server.register(async (a) => (seen.push(a), a.sessionID === "child-ok" ? "allow-once" : "deny"));
    withEnv({ CUBIQ_ASK_URL: server.url, CUBIQ_ASK_TOKEN: token });
    const client = fakeClient({ "child-ok": "main", "child-no": "main" });
    const event = await eventHook(client);
    await event(asked("main", "per_0"));
    await event(asked("child-ok", "per_1"));
    await event(asked("child-no", "per_2"));
    await event({ event: { type: "session.idle", properties: { sessionID: "main" } } });
    expect(seen.map((a) => [a.tool, a.kind, a.summary, a.callID])).toEqual([
      ["external_directory", "permission", "/tmp/*", "per_1"],
      ["external_directory", "permission", "/tmp/*", "per_2"],
    ]);
    expect(client.replies).toEqual([
      { id: "child-ok", permissionID: "per_1", response: "once" },
      { id: "child-no", permissionID: "per_2", response: "reject" },
    ]);
  });

  it("refuses a sub-agent's ask when the app can't be reached, rather than leaving it waiting", async () => {
    withEnv({ CUBIQ_ASK_URL: "http://127.0.0.1:9/ask", CUBIQ_ASK_TOKEN: "t" });
    const client = fakeClient({ child: "main" });
    await (await eventHook(client))(asked("child", "per_1"));
    expect(client.replies).toEqual([{ id: "child", permissionID: "per_1", response: "reject" }]);
  });

  it("fails closed when the app can't be reached, and asks nothing without the app's address", async () => {
    withEnv({ CUBIQ_ASK_URL: "http://127.0.0.1:9/ask", CUBIQ_ASK_TOKEN: "t", UNSKILLED_GUARD_SCRIPT: undefined });
    const before = await hook();
    await expect(before({ tool: "edit", callID: "c" }, { args: { filePath: "a" } })).rejects.toThrow("CubiQ couldn't ask the user about this edit, so it was blocked.");
    withEnv({ CUBIQ_ASK_URL: undefined, CUBIQ_ASK_TOKEN: undefined });
    await expect(before({ tool: "bash", callID: "c" }, { args: { command: "ls" } })).resolves.toBeUndefined();
  });
});

/** A fake chat endpoint: the first request with tools (and `after` in its body, when given) answers one bash call (`command`), the rest say done. */
function fakeToolChat(command: string, after?: string): Promise<{ server: Server; url: string; bodies: unknown[] }> {
  const bodies: unknown[] = [];
  let sent = false;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) return void res.writeHead(404).end();
      const parsed = JSON.parse(body) as { model?: string; tools?: unknown };
      bodies.push(parsed);
      const model = parsed.model ?? "unknown";
      const chunk = (delta: unknown, finish: string | null, extra: Record<string, unknown> = {}) => `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (Array.isArray(parsed.tools) && parsed.tools.length > 0 && !sent && (!after || body.includes(after))) {
        sent = true;
        res.end(chunk({ role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command, description: "run it" }) } }] }, null) + chunk({}, "tool_calls") + "data: [DONE]\n\n");
      } else {
        res.end(chunk({ role: "assistant", content: "done" }, null) + chunk({}, "stop", { usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } }) + "data: [DONE]\n\n");
      }
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, bodies })));
}

/** A fake chat endpoint that answers tool-bearing requests with `calls` in order (one tool call each), then says done. */
function fakeChatScript(calls: { name: string; args: Record<string, unknown> }[]): Promise<{ server: Server; url: string; bodies: unknown[] }> {
  const bodies: unknown[] = [];
  let next = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) return void res.writeHead(404).end();
      const parsed = JSON.parse(body) as { model?: string; tools?: unknown };
      bodies.push(parsed);
      const model = parsed.model ?? "unknown";
      const chunk = (delta: unknown, finish: string | null, extra: Record<string, unknown> = {}) => `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const call = Array.isArray(parsed.tools) && parsed.tools.length > 0 ? calls[next] : undefined;
      if (call) {
        next++;
        res.end(chunk({ role: "assistant", content: null, tool_calls: [{ index: 0, id: `call_${next}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }] }, null) + chunk({}, "tool_calls") + "data: [DONE]\n\n");
      } else {
        res.end(chunk({ role: "assistant", content: "done" }, null) + chunk({}, "stop", { usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } }) + "data: [DONE]\n\n");
      }
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, bodies })));
}

describe.skipIf(!onPath("opencode"))("OpenCode asks CubiQ before a command (real acp, fake model)", () => {
  // Never touch the user's real ~/.config/opencode and friends: their agents may allow everything.
  function isolate(): void {
    const names = ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "OPENCODE_DISABLE_AUTOUPDATE", "OPENCODE_DISABLE_MODELS_FETCH"];
    const previous = Object.fromEntries(names.map((n) => [n, process.env[n]]));
    for (const n of names.slice(0, 4)) process.env[n] = tempDir();
    process.env.OPENCODE_DISABLE_AUTOUPDATE = "1";
    process.env.OPENCODE_DISABLE_MODELS_FETCH = "1";
    closeAfter(() => {
      for (const [k, v] of Object.entries(previous)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
  }

  async function turn(mode: PermissionMode, answer: PermissionDecision, ownBash: "allow" | "ask" = "allow", plan?: "auto" | "manual", opts: { prefix?: string; guardScript?: string } = {}) {
    isolate();
    const cwd = tempDir();
    const marker = join(cwd, "ran.txt");
    const fake = await fakeToolChat(`${opts.prefix ?? ""}echo ran > ${JSON.stringify(marker)}`, plan ? "Implement the plan." : undefined);
    closeAfter(() => void fake.server.close());
    const pluginUrl = ensureOpenCodeGuard(tempDir());
    const preset = ACP_PRESETS.find((p) => p.id === "opencode")!;
    const driver = createAcpDriver(preset, {
      clientVersion: "test",
      ...(opts.guardScript ? { guardScript: opts.guardScript } : {}),
      injection: () => {
        // By default OpenCode's own config allows bash outright: only the plugin can stop it.
        const config = {
          $schema: "https://opencode.ai/config.json",
          provider: { gw: { npm: "@ai-sdk/openai-compatible", name: "GW", options: { baseURL: fake.url, apiKey: "k" }, models: { "vendor/wire-1": { name: "Picked" } } } },
          model: "gw/vendor/wire-1",
          permission: { bash: ownBash, edit: "allow" },
        };
        return withOpenCodeGuard({ env: { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) }, byok: false }, { pluginUrl });
      },
    });
    closeAfter(() => driver.dispose?.());
    const asked: { toolName: string; summary: string }[] = [];
    const events: ThreadEvent[] = [];
    await driver.runTurn({
      threadId: `t-${mode}`,
      cwd,
      prompt: "Run it.",
      sessionId: null,
      model: DEFAULT_MODEL,
      permissionMode: mode,
      signal: new AbortController().signal,
      tools: [],
      mcpServers: [],
      onEvent: (e) => events.push(e),
      onTextDelta: () => {},
      onSession: () => {},
      requestPermission: async (r) => (asked.push(r), answer),
      requestPlanDecision: async () => plan ?? { keep: "" },
    });
    return { asked, events, ran: existsSync(marker) && readFileSync(marker, "utf8").includes("ran"), seen: fake.bodies.map((b) => JSON.stringify(b)).join("\n") };
  }

  it("Ask: the command waits for the card, and a denial blocks it and reaches the model", async () => {
    const r = await turn("ask", "deny");
    expect(r.asked).toHaveLength(1);
    expect(r.asked[0]!.toolName).toBe("Run");
    expect(r.asked[0]!.summary).toContain("echo ran");
    expect(r.ran).toBe(false);
    expect(r.seen).toContain("The user denied this command.");
  }, 120_000);

  it("Ask: an approval runs it", async () => {
    const r = await turn("ask", "allow-once");
    expect(r.asked).toHaveLength(1);
    expect(r.ran).toBe(true);
  }, 120_000);

  it("Ask: when OpenCode's own config also asks, its ACP ask for the approved call isn't a second card", async () => {
    const r = await turn("ask", "allow-once", "ask");
    expect(r.asked).toHaveLength(1);
    expect(r.ran).toBe(true);
  }, 120_000);

  it("Plan approved with manual edits: the implementing round's command waits for a card", async () => {
    const r = await turn("plan", "deny", "allow", "manual");
    expect(r.asked.map((a) => a.toolName)).toEqual(["Run"]);
    expect(r.ran).toBe(false);
  }, 120_000);

  it("Plan approved with auto-accepted edits: the implementing round still asks before a command", async () => {
    const r = await turn("plan", "allow-once", "allow", "auto");
    expect(r.asked.map((a) => a.toolName)).toEqual(["Run"]);
    expect(r.ran).toBe(true);
  }, 120_000);

  it("Full: a dangerous git command is blocked by the app's built-in guardrail, with no Python script", async () => {
    const r = await turn("full", "allow-once", "allow", undefined, { prefix: "git push --force origin main; ", guardScript: BUILT_IN_GUARD });
    expect(r.asked).toEqual([]);
    expect(r.ran).toBe(false);
    expect(r.events.some((e) => e.kind === "notice" && e.text.startsWith("Blocked by git guardrails: git push --force"))).toBe(true);
    // The model is told why, not that a user it never asked said no.
    expect(r.seen).toContain("BLOCKED:");
    expect(r.seen).not.toContain("The user denied");
  }, 120_000);

  it("Full: runs without a card", async () => {
    const r = await turn("full", "deny");
    expect(r.asked).toEqual([]);
    expect(r.ran).toBe(true);
  }, 120_000);

  /** The main agent hands a step to a sub-agent, which reads a file outside the project: OpenCode's own external_directory ask. */
  async function subagentReadsOutside(mode: PermissionMode, answer: PermissionDecision) {
    isolate();
    const cwd = tempDir();
    const outside = join(tempDir(), "notes.txt");
    writeFileSync(outside, "OUTSIDE_SECRET_42\n");
    const fake = await fakeChatScript([
      { name: "task", args: { description: "read notes", prompt: "Read the notes file.", subagent_type: "general" } },
      { name: "read", args: { filePath: outside } },
    ]);
    closeAfter(() => void fake.server.close());
    const pluginUrl = ensureOpenCodeGuard(tempDir());
    const preset = ACP_PRESETS.find((p) => p.id === "opencode")!;
    const driver = createAcpDriver(preset, {
      clientVersion: "test",
      injection: () => {
        const config = {
          $schema: "https://opencode.ai/config.json",
          provider: { gw: { npm: "@ai-sdk/openai-compatible", name: "GW", options: { baseURL: fake.url, apiKey: "k" }, models: { "vendor/wire-1": { name: "Picked" } } } },
          model: "gw/vendor/wire-1",
          permission: { bash: "allow", edit: "allow", external_directory: "ask" },
        };
        return withOpenCodeGuard({ env: { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) }, byok: false }, { pluginUrl });
      },
    });
    closeAfter(() => driver.dispose?.());
    const asked: { toolName: string; summary: string }[] = [];
    const events: ThreadEvent[] = [];
    await driver.runTurn({
      threadId: `sub-${mode}`,
      cwd,
      prompt: "Read the notes.",
      sessionId: null,
      model: DEFAULT_MODEL,
      permissionMode: mode,
      signal: new AbortController().signal,
      tools: [],
      mcpServers: [],
      onEvent: (e) => events.push(e),
      onTextDelta: () => {},
      onSession: () => {},
      requestPermission: async (r) => (asked.push(r), answer),
      requestPlanDecision: async () => ({ keep: "" }),
    });
    return { asked, events, seen: fake.bodies.map((b) => JSON.stringify(b)).join("\n") };
  }

  it("Full: a sub-agent reading outside the project goes on without a card or a stall", async () => {
    const r = await subagentReadsOutside("full", "deny");
    expect(r.asked).toEqual([]);
    expect(r.seen).toContain("OUTSIDE_SECRET_42");
    expect(r.events.some((e) => e.kind === "notice" && e.text.includes("can't ask here"))).toBe(false);
  }, 120_000);

  it("Ask: a sub-agent's read outside the project shows a card, and a denial keeps the file out", async () => {
    const r = await subagentReadsOutside("ask", "deny");
    expect(r.asked.map((a) => a.toolName)).toEqual(["external_directory"]);
    expect(r.seen).not.toContain("OUTSIDE_SECRET_42");
  }, 120_000);
});
