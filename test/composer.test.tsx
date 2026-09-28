import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { describePick, type PickedElement } from "../src/main/browser/picker";
import { chipLabel, composeMessage } from "../src/renderer/src/composer";
import { Composer } from "../src/renderer/src/components/Composer";
import { useStore } from "../src/renderer/src/store";
import type { SendRequest } from "../src/shared/types";

const element: PickedElement = { selector: "button.primary", tag: "button", text: "Save", html: "<button class=\"primary\">Save</button>", rect: { x: 0, y: 0, width: 1, height: 1 } };
const picked = describePick(element, "http://localhost:3000/");

describe("chipLabel", () => {
  it("names a picked element by its selector", () => {
    expect(chipLabel(picked)).toBe("button.primary");
  });

  it("falls back to the first line, clipped", () => {
    expect(chipLabel("\nsome long context line that keeps going and going", 20)).toBe("some long context l…");
  });
});

describe("composeMessage", () => {
  it("sends what was typed, then each chip's full text", () => {
    expect(composeMessage("  make it blue ", [picked])).toBe(`make it blue\n\n${picked}`);
  });

  it("sends a chip alone", () => {
    expect(composeMessage("", [picked])).toBe(picked);
  });
});

describe("queued send", () => {
  const sent: SendRequest[] = [];
  const interrupted: string[] = [];
  (globalThis as { window?: unknown }).window = {
    unskilled: new Proxy(
      {
        send: async (r: SendRequest) => void sent.push(r),
        interrupt: async (id: string) => void interrupted.push(id),
        createThread: async (pid: string, _agent?: string, opts?: { worktree?: boolean }) => ({
          id: "t-bg",
          projectId: pid,
          agent: "claude",
          title: "New thread",
          sessionId: null,
          bindings: {},
          model: "opus",
          effort: null,
          permissionMode: "ask",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          ...(opts?.worktree ? { branch: "harness/bg", worktreePath: "/wt/bg" } : {}),
        }),
      } as Record<string, unknown>,
      { get: (target, key: string) => target[key] ?? (async () => null) },
    ),
  };

  beforeEach(() => {
    sent.length = 0;
    interrupted.length = 0;
    useStore.setState({ selectedThreadId: "t", running: { t: true }, outbox: {}, finished: [], turnStartedAt: {} });
  });

  it("delivers a message queued mid-turn exactly once, as the next turn", () => {
    const s = useStore.getState();
    s.enqueue("t", "and add a test", "tdd");
    expect(useStore.getState().outbox.t).toEqual([{ text: "and add a test", skill: "tdd" }]);
    s.apply({ type: "running", threadId: "t", running: false });
    expect(sent).toEqual([{ threadId: "t", text: "and add a test", skill: "tdd" }]);
    expect(useStore.getState().outbox.t).toEqual([]);
    s.apply({ type: "running", threadId: "t", running: true });
    s.apply({ type: "running", threadId: "t", running: false });
    expect(sent).toHaveLength(1);
  });

  it("sends queued messages one turn at a time, in order", () => {
    const s = useStore.getState();
    s.enqueue("t", "first");
    s.enqueue("t", "second");
    s.apply({ type: "running", threadId: "t", running: false });
    expect(sent.map((r) => r.text)).toEqual(["first"]);
    s.apply({ type: "running", threadId: "t", running: true });
    s.apply({ type: "running", threadId: "t", running: false });
    expect(sent.map((r) => r.text)).toEqual(["first", "second"]);
  });

  it("clears the queue on Stop, before the turn's end could deliver it", async () => {
    const s = useStore.getState();
    s.enqueue("t", "never mind");
    await s.interrupt();
    expect(interrupted).toEqual(["t"]);
    s.apply({ type: "running", threadId: "t", running: false });
    expect(sent).toEqual([]);
    expect(useStore.getState().outbox.t).toBeUndefined();
  });

  describe("sendInBackground", () => {
    it("starts the message in its own thread and leaves the current one selected", async () => {
      useStore.setState({ selectedProjectId: "p", selectedThreadId: "keep", running: {}, threads: {}, events: {} });
      await useStore.getState().sendInBackground("do it", "tdd", undefined, ["src/a.ts"]);
      expect(sent).toEqual([{ threadId: "t-bg", text: "do it", skill: "tdd", mentions: ["src/a.ts"] }]);
      expect(useStore.getState().selectedThreadId).toBe("keep");
      expect(useStore.getState().threads.p!.map((t) => t.id)).toEqual(["t-bg"]);
    });
  });
});

describe("composer actions row", () => {
  // Server rendering reads zustand's initial state; seed it, then restore.
  const withRunning = (running: Record<string, boolean>, fn: () => void) => {
    const state = useStore.getInitialState();
    const saved = state.running;
    try {
      state.running = running;
      fn();
    } finally {
      state.running = saved;
    }
  };

  it("keeps Stop inside composer-actions while running", () => {
    withRunning({ t: true }, () => {
      const html = renderToStaticMarkup(<Composer threadId="t" />);
      expect(html).toMatch(/<div class="composer-actions"><button class="send stop"/);
    });
  });

  it("keeps Send inside composer-actions when idle", () => {
    withRunning({}, () => {
      const html = renderToStaticMarkup(<Composer threadId="t" />);
      expect(html).toMatch(/<div class="composer-actions"><button class="send"/);
    });
  });

  it("keeps composer-actions a direct child of composer-bar, outside composer-left", () => {
    withRunning({ t: true }, () => {
      const html = renderToStaticMarkup(<Composer threadId="t" />);
      // The wrapping lives in composer-left; the actions row is its sibling in the bar.
      expect(html).toMatch(/<div class="composer-bar"><div class="composer-left">/);
      expect(html).toMatch(/<\/div><div class="composer-actions">/);
      const left = /<div class="composer-left">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "";
      expect(left).not.toContain("composer-actions");
    });
  });
});
