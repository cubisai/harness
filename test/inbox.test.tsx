import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MessageCenterView } from "../src/renderer/src/components/MessageCenter";
import { automationText, formatDuration, inboxRows, threadSeen, turnEnded, type FinishedTurn } from "../src/renderer/src/inbox";
import { useStore } from "../src/renderer/src/store";
import type { AgentInfo, PermissionRequest, Thread } from "../src/shared/types";
import type { AutomationNotice } from "../src/shared/automations";

const thread = (id: string, agent = "claude"): Thread => ({
  id,
  projectId: "p",
  agent,
  title: `Thread ${id}`,
  sessionId: null,
  bindings: {},
  model: "default",
  effort: null,
  permissionMode: "ask",
  createdAt: 0,
  updatedAt: 0,
});
const threads = { p: [thread("A"), thread("B", "codex")] };
const ask = (threadId: string): PermissionRequest => ({ requestId: `r-${threadId}`, threadId, toolName: "Bash", summary: "npm test", canAlwaysAllow: true });
const notice = (over: Partial<AutomationNotice> = {}): AutomationNotice => ({
  automationId: "a1",
  name: "Repo health",
  runId: 1,
  threadId: null,
  status: "succeeded",
  costUsd: null,
  endedAt: 0,
  error: null,
  ...over,
});

describe("inboxRows", () => {
  it("lists a permission raised on a thread other than the open one", () => {
    const rows = inboxRows({ permissions: [ask("A")], finished: [], threads, selectedThreadId: "B" });
    expect(rows.needsYou).toMatchObject([{ kind: "permission", threadId: "A", requestId: "r-A", summary: "npm test", thread: { title: "Thread A" } }]);
  });

  it("leaves out the open thread's own permission: its card is on screen", () => {
    expect(inboxRows({ permissions: [ask("A")], finished: [], threads, selectedThreadId: "A" }).needsYou).toEqual([]);
  });

  it("lists finished turns newest first", () => {
    const finished: FinishedTurn[] = [
      { threadId: "A", durationMs: 1000, endedAt: 1 },
      { threadId: "B", durationMs: 2000, endedAt: 2 },
    ];
    expect(inboxRows({ permissions: [], finished, threads, selectedThreadId: null }).finished.map((r) => r.threadId)).toEqual(["B", "A"]);
  });
});

describe("automation rows", () => {
  it("lists failed and paused runs under Needs you", () => {
    const rows = inboxRows({
      permissions: [],
      finished: [],
      threads,
      selectedThreadId: null,
      automations: [notice({ automationId: "a1", status: "failed", error: "boom" }), notice({ automationId: "a2", status: "paused-budget" })],
    });
    expect(rows.needsYou.map((r) => (r.kind === "automation" ? automationText(r.notice) : r.kind))).toEqual(["failed: boom", "paused at its budget"]);
  });

  it("hides a run whose thread is the open one", () => {
    const rows = inboxRows({ permissions: [], finished: [], threads, selectedThreadId: "A", automations: [notice({ status: "failed", threadId: "A" })] });
    expect(rows.needsYou).toEqual([]);
  });

  it("attaches the notice to the finished row it delivered into", () => {
    const rows = inboxRows({
      permissions: [],
      finished: [{ threadId: "A", durationMs: 1_000, endedAt: 1 }],
      threads,
      selectedThreadId: null,
      automations: [notice({ status: "succeeded", threadId: "A" })],
    });
    expect(rows.finished).toMatchObject([{ kind: "finished", threadId: "A", automation: { status: "succeeded", name: "Repo health" } }]);
  });

  it("adds no row for a succeeded run with no finished turn", () => {
    const rows = inboxRows({ permissions: [], finished: [], threads, selectedThreadId: null, automations: [notice({ status: "succeeded" })] });
    expect(rows).toEqual({ needsYou: [], finished: [] });
  });
});

describe("automationText", () => {
  it("names the outcome, with the cost", () => {
    expect(automationText(notice({ status: "succeeded", costUsd: 1.5 }))).toBe("finished · $1.50");
    expect(automationText(notice({ status: "interrupted" }))).toBe("was interrupted");
    expect(automationText(notice({ status: "partial" }))).toBe("finished, but its result may not have been delivered");
  });

  it("truncates a long error to 80 characters", () => {
    expect(automationText(notice({ status: "failed", error: "x".repeat(120) }))).toBe(`failed: ${"x".repeat(80)}`);
  });
});

describe("turnEnded / threadSeen", () => {
  it("records a turn that ends on an unselected thread, with its duration", () => {
    expect(turnEnded([], "A", 1_000, 13_500, "B")).toEqual([{ threadId: "A", durationMs: 12_500, endedAt: 13_500 }]);
  });

  it("records nothing for the open thread", () => {
    expect(turnEnded([], "A", 1_000, 2_000, "A")).toEqual([]);
  });

  it("keeps one row per thread, the latest turn", () => {
    const once = turnEnded([], "A", 0, 1_000, null);
    expect(turnEnded(once, "A", 5_000, 6_000, null)).toEqual([{ threadId: "A", durationMs: 1_000, endedAt: 6_000 }]);
  });

  it("clears a thread's row when it is opened", () => {
    const rows = turnEnded(turnEnded([], "A", 0, 1, null), "B", 0, 2, null);
    expect(threadSeen(rows, "A").map((r) => r.threadId)).toEqual(["B"]);
  });
});

describe("store", () => {
  // The store refreshes agents and branches at a turn's end; any preload call resolves empty here.
  (globalThis as { window?: unknown }).window ??= { unskilled: new Proxy({}, { get: () => async () => null }) };

  it("makes a Finished row for a turn that ends while another thread is open, and clears it on open", async () => {
    useStore.setState({ threads, selectedThreadId: "B", running: {}, finished: [], turnStartedAt: {} });
    const s = useStore.getState();
    s.apply({ type: "running", threadId: "A", running: true });
    s.apply({ type: "running", threadId: "A", running: false });
    expect(useStore.getState().finished.map((f) => f.threadId)).toEqual(["A"]);
    useStore.setState({ events: { A: [] } }); // selectThread won't fetch
    await s.selectThread("A");
    expect(useStore.getState().finished).toEqual([]);
  });

  it("keeps transient notices out of the inbox", () => {
    useStore.setState({ finished: [], permissions: [] });
    useStore.getState().showNotice("Copied.");
    const s = useStore.getState();
    expect(inboxRows({ permissions: s.permissions, finished: s.finished, threads, selectedThreadId: null })).toEqual({ needsYou: [], finished: [] });
  });
});

describe("MessageCenterView", () => {
  const agents = [{ id: "codex", label: "Codex" }] as AgentInfo[];

  it("shows each row's title, agent and what happened", () => {
    const rows = inboxRows({ permissions: [ask("A")], finished: [{ threadId: "B", durationMs: 12_000, endedAt: 1 }], threads, selectedThreadId: null });
    const html = renderToStaticMarkup(<MessageCenterView {...rows} agents={agents} onOpen={() => {}} onClose={() => {}} />);
    expect(html).toContain("Needs you");
    expect(html).toContain("Thread A");
    expect(html).toContain("wants to run npm test");
    expect(html).toContain("Finished");
    expect(html).toContain("Codex");
    expect(html).toContain("finished in 12s");
  });

  it("renders a run that paused at its budget", () => {
    const rows = inboxRows({ permissions: [], finished: [], threads, selectedThreadId: null, automations: [notice({ name: "Repo health", status: "paused-budget" })] });
    const html = renderToStaticMarkup(<MessageCenterView {...rows} agents={agents} onOpen={() => {}} onClose={() => {}} />);
    expect(html).toContain("Automation · paused at its budget");
    expect(html).toContain("Repo health");
  });

  it("says so when nothing is waiting", () => {
    const html = renderToStaticMarkup(<MessageCenterView needsYou={[]} finished={[]} agents={[]} onOpen={() => {}} onClose={() => {}} />);
    expect(html).toContain("Nothing waiting");
  });
});

describe("formatDuration", () => {
  it("reads naturally", () => {
    expect([formatDuration(42_000), formatDuration(184_000), formatDuration(3_720_000)]).toEqual(["42s", "3m 04s", "1h 02m"]);
  });
});
