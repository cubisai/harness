import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agyPermissionArgs, agyTool, createAgyDriver, parseAgyModels } from "../src/main/agents/agy";
import type { TurnInput } from "../src/main/agents/types";
import type { PermissionMode, ThreadEvent } from "../src/shared/types";
import { fixturesDir } from "./helpers";

const FAKE = join(fixturesDir, "fake-agy.mjs");

function driver(guide?: (cwd: string) => string) {
  return createAgyDriver({ command: process.execPath, args: [FAKE], guide });
}

function turn(prompt: string, over: Partial<TurnInput> = {}) {
  const events: ThreadEvent[] = [];
  const deltas: string[] = [];
  const sessions: string[] = [];
  const input: TurnInput = {
    threadId: "t1",
    cwd: tmpdir(),
    prompt,
    sessionId: null,
    model: "default",
    permissionMode: "auto-edit" as PermissionMode,
    signal: new AbortController().signal,
    onEvent: (e) => events.push(e),
    onTextDelta: (t) => deltas.push(t),
    onSession: (s) => sessions.push(s),
    requestPermission: async () => "deny",
    tools: [],
    mcpServers: [],
    ...over,
  };
  return { input, events, deltas, sessions };
}

/** Run the fake's "echo" scenario: its reply is its own argv and raw stdin line. */
async function echo(over: Partial<TurnInput> = {}, guide?: (cwd: string) => string) {
  const t = turn("echo", over);
  await driver(guide).runTurn(t.input);
  return JSON.parse(t.deltas.join("")) as { argv: string[]; stdin: string };
}

describe("agy driver", () => {
  it("streams text into one assistant-text event and reports the conversation and usage", async () => {
    const t = turn("hi");
    await driver().runTurn(t.input);
    expect(t.deltas.join("")).toBe("Hello\n");
    expect(t.sessions).toEqual(["conv-1"]);
    const kinds = t.events.map((e) => e.kind);
    expect(kinds).toEqual(["turn-start", "assistant-text", "turn-end"]);
    expect(t.events[1]).toMatchObject({ kind: "assistant-text", text: "Hello" });
    expect(t.events.at(-1)).toMatchObject({ kind: "turn-end", inputTokens: 100, outputTokens: 7, usage: { cacheReadTokens: 40, provenance: "reported" } });
  });

  it("resumes a conversation with --conversation", async () => {
    const t = turn("hi", { sessionId: "conv-9" });
    await driver().runTurn(t.input);
    expect(t.sessions).toEqual(["conv-9"]);
  });

  it("renders tool steps as canonical rows and reports what headless agy skipped", async () => {
    const t = turn("tool");
    await driver().runTurn(t.input);
    const rows = t.events.filter((e) => e.kind === "tool-use" || e.kind === "tool-result");
    expect(rows).toEqual([
      expect.objectContaining({ kind: "tool-use", name: "Edit", summary: "hello.txt" }),
      expect.objectContaining({ kind: "tool-result", isError: false, summary: "Done" }),
      expect.objectContaining({ kind: "tool-use", name: "Run", summary: "dir hello.txt", payload: { command: "dir hello.txt" } }),
      expect.objectContaining({ kind: "tool-result", isError: true, summary: "user denied permission to run command" }),
    ]);
    // Text before a tool is flushed as its own row, ahead of the tool.
    expect(t.events.map((e) => e.kind).slice(0, 3)).toEqual(["turn-start", "assistant-text", "tool-use"]);
    const notice = t.events.find((e) => e.kind === "notice" && (e as { text: string }).text.includes("skipped"));
    expect(notice).toMatchObject({ text: expect.stringContaining("RunCommand") });
  });

  it("turns an ERROR result into an error event with agy's own words", async () => {
    const t = turn("fail");
    await driver().runTurn(t.input);
    expect(t.events.find((e) => e.kind === "error")).toMatchObject({ message: expect.stringContaining("something broke") });
  });

  it("says so when agy exits without a result", async () => {
    const t = turn("silent");
    await driver().runTurn(t.input);
    expect(t.events.find((e) => e.kind === "error")).toMatchObject({ message: expect.stringContaining("without a result") });
  });

  it("stops the process when the turn is aborted", async () => {
    const controller = new AbortController();
    const t = turn("hang", { signal: controller.signal });
    const running = driver().runTurn(t.input);
    setTimeout(() => controller.abort(), 300);
    await running;
    expect(t.events.at(-1)).toMatchObject({ kind: "notice", text: "Stopped." });
  });

  it("warns once per thread that Ask runs read-only", async () => {
    const d = driver();
    const a = turn("hi", { permissionMode: "ask" });
    await d.runTurn(a.input);
    const b = turn("hi", { permissionMode: "ask" });
    await d.runTurn(b.input);
    const notices = [...a.events, ...b.events].filter((e) => e.kind === "notice" && (e as { text: string }).text.includes("only plans"));
    expect(notices).toHaveLength(1);
  });

  it("lists models from `agy models`", async () => {
    const d = driver();
    await d.refreshModels!();
    expect(d.models().map((m) => m.id)).toEqual(["default", "gemini-3.8-flash-high", "claude-sonnet-4-6"]);
    expect(d.models()[1]).toMatchObject({ label: "Gemini 3.8 Flash (High)", efforts: ["low", "medium", "high", "max"] });
  });

  it("passes model, effort and the permission mode as flags, and the prompt on stdin", async () => {
    const { argv, stdin } = await echo({ model: "gemini-3.8-flash-high", effort: "high", permissionMode: "full" });
    expect(argv.slice(0, 5)).toEqual(["--input-format", "stream-json", "--output-format", "stream-json", "-p="]);
    expect(argv).toEqual(expect.arrayContaining(["--model", "gemini-3.8-flash-high", "--effort", "high", "--dangerously-skip-permissions"]));
    expect(JSON.parse(stdin)).toEqual({ event: "user", message: { content: "echo" } });
    const plain = await echo();
    expect(plain.argv).not.toContain("--model");
    expect(plain.argv).not.toContain("--effort");
    expect(plain.argv).toEqual(expect.arrayContaining(["--mode", "accept-edits"]));
  });

  it("sends the harness guide ahead of a new conversation's first prompt only", async () => {
    const fresh = await echo({}, () => "GUIDE");
    expect(JSON.parse(fresh.stdin).message.content).toBe("<harness-guide>\nGUIDE\n</harness-guide>\n\necho");
    const resumed = await echo({ sessionId: "conv-2" }, () => "GUIDE");
    expect(JSON.parse(resumed.stdin).message.content).toBe("echo");
    expect(resumed.argv).toEqual(expect.arrayContaining(["--conversation", "conv-2"]));
  });
});

describe("agy helpers", () => {
  it("maps permission modes to what headless agy can do", () => {
    expect(agyPermissionArgs("ask")).toEqual(["--mode", "plan"]);
    expect(agyPermissionArgs("auto-edit")).toEqual(["--mode", "accept-edits"]);
    expect(agyPermissionArgs("full")).toEqual(["--dangerously-skip-permissions"]);
  });

  it("parses the models list, skipping the Fetching line", () => {
    expect(parseAgyModels("Fetching available models...\r\na-high\tA (High)\r\n\r\n").map((m) => m.id)).toEqual(["a-high"]);
  });

  it("names tools like the other adapters", () => {
    const cwd = join(tmpdir(), "proj");
    expect(agyTool("view_file", { AbsolutePath: join(cwd, "src", "a.ts") }, cwd)).toMatchObject({ name: "Read", summary: "src/a.ts" });
    expect(agyTool("grep_search", { Query: "TODO" }, cwd)).toMatchObject({ name: "Search", summary: "TODO" });
    expect(agyTool("read_url_content", { Url: "https://x.dev" }, cwd)).toMatchObject({ name: "Fetch", summary: "https://x.dev" });
    expect(agyTool("open_browser_url", { Url: "http://localhost:3000" }, cwd)).toMatchObject({ name: "open_browser_url", summary: "http://localhost:3000" });
  });
});
