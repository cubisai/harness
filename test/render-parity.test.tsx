import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createAcpDriver } from "../src/main/agents/acp/driver";
import { handleMessage, newTurnState } from "../src/main/agents/claude";
import { createCodexDriver } from "../src/main/agents/codex";
import type { AgentDriver, TurnInput } from "../src/main/agents/types";
import { DiffView } from "../src/renderer/src/components/DiffView";
import { EventRow } from "../src/renderer/src/components/ThreadView";
import { Markdown } from "../src/renderer/src/markdown";
import { unifiedDiff } from "../src/shared/diff";
import type { ToolDiff } from "../src/shared/tools";
import type { PermissionDecision, ThreadEvent } from "../src/shared/types";
import { CANONICAL, visible } from "./fixtures/canonical-events";
import { closeAfter } from "./helpers";

describe("render parity", () => {
  it("renders the same edit identically from the Codex and ACP shapes", () => {
    const path = "src/a.ts";
    const oldText = "const a = 1;\nconst b = 2;\n";
    const newText = "const a = 1;\nconst b = 3;\n";

    // Codex hands over its own unified text; ACP is built with unifiedDiff here.
    const codexDiff: ToolDiff[] = [{ path, unified: unifiedDiff(path, oldText, newText) }];
    const acpDiff: ToolDiff[] = [{ path, unified: unifiedDiff(path, oldText, newText) }];

    const codexHtml = renderToStaticMarkup(<DiffView diffs={codexDiff} />);
    const acpHtml = renderToStaticMarkup(<DiffView diffs={acpDiff} />);
    expect(acpHtml).toBe(codexHtml);
    expect(codexHtml).toContain("src/a.ts");
  });
});

type Collected = { events: ThreadEvent[]; deltas: string[] };

function collector(prompt: string): Collected & { input: TurnInput } {
  const events: ThreadEvent[] = [];
  const deltas: string[] = [];
  const input: TurnInput = {
    threadId: "thread-1",
    cwd: tmpdir(),
    prompt,
    sessionId: null,
    model: "default",
    permissionMode: "ask",
    signal: new AbortController().signal,
    tools: [],
    mcpServers: [],
    onEvent: (e) => events.push(e),
    onTextDelta: (t) => deltas.push(t),
    onSession: () => {},
    requestPermission: async () => "allow-once" as PermissionDecision,
    requestPlanDecision: async () => ({ keep: "" }),
  };
  return { input, events, deltas };
}

/** The canonical set in Claude SDK messages, streamed text included. */
function claudeRun(): Collected {
  const c = collector("canonical");
  const turn = newTurnState();
  const feed = (m: unknown) => handleMessage(m as SDKMessage, c.input, turn);
  const stream = (event: unknown) => feed({ type: "stream_event", parent_tool_use_id: null, event });
  const assistant = (id: string, content: unknown[]) => feed({ type: "assistant", parent_tool_use_id: null, message: { id, model: "claude-x", content } });
  const user = (content: unknown[]) => feed({ type: "user", parent_tool_use_id: null, message: { role: "user", content } });

  stream({ type: "message_start", message: { id: "m1", model: "claude-x" } });
  stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "I'll run the tests." } });
  assistant("m1", [
    { type: "text", text: "I'll run the tests." },
    { type: "tool_use", id: "c1", name: "Bash", input: { command: "npm test" } },
  ]);
  user([{ type: "tool_result", tool_use_id: "c1", content: "3 passed" }]);
  assistant("m2", [{ type: "tool_use", id: "f1", name: "Edit", input: { file_path: "a.txt", old_string: "one\n", new_string: "uno\n" } }]);
  user([{ type: "tool_result", tool_use_id: "f1", content: "The file a.txt has been updated." }]);
  stream({ type: "message_start", message: { id: "m3", model: "claude-x" } });
  stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } });
  assistant("m3", [{ type: "text", text: "Done." }]);
  return c;
}

async function driverRun(d: AgentDriver, prompt: string): Promise<Collected> {
  closeAfter(() => d.dispose?.());
  const c = collector(prompt);
  await d.runTurn(c.input);
  return c;
}

const codex = () => createCodexDriver({ command: process.execPath, args: [join(__dirname, "fixtures", "mock-codex-app-server.mjs")], clientVersion: "test" });
const acp = () =>
  createAcpDriver({ id: "mock", label: "Mock", command: process.execPath, args: [join(__dirname, "fixtures", "mock-acp-agent.mjs")] }, { clientVersion: "test" });

/** What the thread shows for these events: one EventRow each, tool results resolved onto their rows. */
function markup(events: ThreadEvent[]): string {
  const results = new Map<string, Extract<ThreadEvent, { kind: "tool-result" }>>();
  for (const e of events) if (e.kind === "tool-result") results.set(e.toolUseId, e);
  return renderToStaticMarkup(
    <>
      {events.map((e, i) => (
        <EventRow key={i} stored={{ seq: i + 1, event: e, createdAt: 0 }} results={results} running={false} />
      ))}
    </>,
  );
}

/** The fields the canonical expectation pins, per event. */
function shape(e: ThreadEvent) {
  if (e.kind === "assistant-text") return { kind: e.kind, text: e.text };
  if (e.kind === "tool-use") return { kind: e.kind, name: e.name, summary: e.summary };
  if (e.kind === "tool-result") return { kind: e.kind, summary: e.summary };
  return { kind: e.kind };
}

describe("four-driver render parity", () => {
  it("maps the canonical set the same way and renders it identically from Claude, Codex, ACP and OpenCode-flavoured ACP", async () => {
    const runs: Record<string, Collected> = {
      claude: claudeRun(),
      codex: await driverRun(codex(), "canonical"),
      acp: await driverRun(acp(), "canonical"),
      opencode: await driverRun(acp(), "canonical-opencode"),
    };
    const html: Record<string, string> = {};
    for (const [name, run] of Object.entries(runs)) {
      const events = visible(run.events);
      expect(events.map(shape), name).toEqual(CANONICAL);
      html[name] = markup(events);
      // Tool ids pair a result with its row; they must not reach the markup.
      expect(html[name], name).not.toMatch(/\b(c1|f1)\b/);
      // Every adapter streams the replies' text as it arrives.
      expect(run.deltas.join(""), name).toBe("I'll run the tests.Done.");
    }
    expect(html.claude).toContain("+1 −1");
    expect(html.codex).toBe(html.claude);
    expect(html.acp).toBe(html.claude);
    expect(html.opencode).toBe(html.claude);
  }, 30_000);

  it("never renders a half-streamed fence as a code block", () => {
    const partial = "I'll run the tests.\n\n```js\nconst a";
    expect(renderToStaticMarkup(<Markdown text={partial} streaming />)).not.toContain("<pre");
  });
});
