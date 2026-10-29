import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createCodexDriver } from "../src/main/agents/codex";
import type { TurnInput } from "../src/main/agents/types";
import { ToolRow } from "../src/renderer/src/components/ThreadView";
import type { PermissionDecision, StoredEvent, ThreadEvent } from "../src/shared/types";
import { closeAfter } from "./helpers";

const MOCK = join(__dirname, "fixtures", "mock-codex-app-server.mjs");

/** The child's reply renders under the Agent row's Steps, like Claude's subagents. */
describe("Codex subagent render", () => {
  it("shows a child thread's reply under its Agent row's Steps", async () => {
    const events: ThreadEvent[] = [];
    const input: TurnInput = {
      threadId: "thread-1",
      cwd: tmpdir(),
      prompt: "subagent",
      sessionId: null,
      model: "default",
      permissionMode: "ask",
      signal: new AbortController().signal,
      tools: [],
      mcpServers: [],
      onEvent: (e) => events.push(e),
      onTextDelta: () => {},
      onSession: () => {},
      requestPermission: async () => "allow-once" as PermissionDecision,
      requestPlanDecision: async () => ({ keep: "" }),
    };
    const d = createCodexDriver({ command: process.execPath, args: [MOCK], clientVersion: "test" });
    closeAfter(() => d.dispose?.());
    await d.runTurn(input);

    const stored: StoredEvent[] = events.map((event, i) => ({ seq: i + 1, event, createdAt: 0 }));
    const results = new Map<string, Extract<ThreadEvent, { kind: "tool-result" }>>();
    for (const { event } of stored) if (event.kind === "tool-result") results.set(event.toolUseId, event);
    const children = new Map<string, StoredEvent[]>();
    for (const s of stored) {
      const parentId = s.event.parentId;
      if (!parentId) continue;
      const list = children.get(parentId);
      if (list) list.push(s);
      else children.set(parentId, [s]);
    }

    const agent = stored.find((s): s is StoredEvent & { event: Extract<ThreadEvent, { kind: "tool-use" }> } => s.event.kind === "tool-use" && s.event.name === "Agent");
    expect(agent).toBeDefined();
    const tool = agent!.event;
    const html = renderToStaticMarkup(
      <ToolRow tool={tool} result={results.get(tool.toolUseId)} children={children.get(tool.toolUseId)} results={results} running={false} open onToggle={() => {}} />,
    );
    expect(html).toContain("Steps");
    expect(html).toContain("tool-step-text");
    // The child's own "391" is inside the Steps section, not only the row's summary.
    expect(html.slice(html.indexOf("Steps"))).toContain("391");
  });
});
