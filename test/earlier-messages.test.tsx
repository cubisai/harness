import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { UsageMeter } from "../src/renderer/src/components/Meters";
import { EarlierMessages, ThreadView } from "../src/renderer/src/components/ThreadView";
import { useStore } from "../src/renderer/src/store";
import type { StoredEvent, ThreadTotals } from "../src/shared/types";

type History = Record<string, { firstSeq: number; hasMore: boolean; loadingOlder: boolean; totals: ThreadTotals | null }>;

const end = (seq: number, inputTokens: number, outputTokens: number, cacheReadTokens: number, costUsd: number | null): StoredEvent => ({
  seq,
  createdAt: 0,
  event: {
    kind: "turn-end",
    costUsd,
    inputTokens,
    outputTokens,
    durationMs: 1,
    usage: {
      inputTokens,
      outputTokens,
      reasoningTokens: null,
      cacheReadTokens,
      cacheWriteTokens: null,
      cacheTtl: null,
      hitRate: null,
      miss: false,
      provenance: "reported",
    },
  },
});

const ALL = [end(2, 100, 50, 10, 0.1), end(4, 200, 60, 20, 0.2), end(6, 300, 70, 30, null), end(8, 400, 80, 40, 0.4)];
const SUFFIX = [end(6, 300, 70, 30, null), end(8, 400, 80, 40, 0.4)];
const TOTALS: ThreadTotals = { events: 40, turns: 4, inputTokens: 1000, cacheReadTokens: 100, outputTokens: 260, costUsd: 0.7, lastSeq: 8 };

/** Seed zustand's initial-state snapshot (what server rendering reads) and restore it after. */
function withState(events: Record<string, StoredEvent[]>, history: History, fn: () => void): void {
  const state = useStore.getInitialState();
  const saved = { events: state.events, history: state.history };
  state.events = events;
  state.history = history;
  try {
    fn();
  } finally {
    state.events = saved.events;
    state.history = saved.history;
  }
}

const usageLine = (html: string): string => html.replace(/<!-- -->/g, "");

describe("UsageMeter with whole-thread totals", () => {
  it("shows the same line for a suffix-only load as for the full history", () => {
    let full = "";
    withState({ t1: ALL }, { t1: { firstSeq: 2, hasMore: false, loadingOlder: false, totals: TOTALS } }, () => {
      full = usageLine(renderToStaticMarkup(<UsageMeter threadId="t1" />));
    });
    let suffix = "";
    withState({ t1: SUFFIX }, { t1: { firstSeq: 6, hasMore: true, loadingOlder: false, totals: TOTALS } }, () => {
      suffix = usageLine(renderToStaticMarkup(<UsageMeter threadId="t1" />));
    });
    expect(suffix).toBe(full);
    expect(full).toContain("4 turns");
    expect(full).toContain("Cost: $0.70");
  });

  it("matches today's summed loop for a fully loaded thread with no totals", () => {
    let withTotals = "";
    withState({ t1: ALL }, { t1: { firstSeq: 2, hasMore: false, loadingOlder: false, totals: TOTALS } }, () => {
      withTotals = usageLine(renderToStaticMarkup(<UsageMeter threadId="t1" />));
    });
    let without = "";
    withState({ t1: ALL }, {}, () => {
      without = usageLine(renderToStaticMarkup(<UsageMeter threadId="t1" />));
    });
    expect(without).toBe(withTotals);
  });

  it("adds turn-ends newer than the totals snapshot", () => {
    let html = "";
    withState({ t1: [...ALL, end(10, 500, 90, 50, 0.5)] }, { t1: { firstSeq: 2, hasMore: false, loadingOlder: false, totals: TOTALS } }, () => {
      html = usageLine(renderToStaticMarkup(<UsageMeter threadId="t1" />));
    });
    expect(html).toContain("5 turns");
    expect(html).toContain("Cost: $1.20");
  });
});

describe("ThreadView earlier messages", () => {
  const one: StoredEvent = { seq: 10, createdAt: 0, event: { kind: "user", text: "hi" } };

  it("shows the control only while older events remain", () => {
    withState({ t1: [one] }, { t1: { firstSeq: 10, hasMore: true, loadingOlder: false, totals: null } }, () => {
      expect(renderToStaticMarkup(<ThreadView threadId="t1" />)).toContain("Show earlier messages");
    });
    withState({ t1: [one] }, { t1: { firstSeq: 10, hasMore: false, loadingOlder: false, totals: null } }, () => {
      expect(renderToStaticMarkup(<ThreadView threadId="t1" />)).not.toContain("Show earlier messages");
    });
    withState({ t1: [one] }, {}, () => {
      expect(renderToStaticMarkup(<ThreadView threadId="t1" />)).not.toContain("Show earlier messages");
    });
  });

  it("shows the loading label while a page is in flight", () => {
    withState({ t1: [one] }, { t1: { firstSeq: 10, hasMore: true, loadingOlder: true, totals: null } }, () => {
      const html = renderToStaticMarkup(<ThreadView threadId="t1" />);
      expect(html).toContain("Loading earlier messages…");
      expect(html).toMatch(/<button[^>]*disabled/);
    });
  });
});

type El = { type?: unknown; props?: Record<string, unknown> };

/** Every element in a directly-called component's tree that matches. */
const findAll = (root: unknown, match: (el: El) => boolean): El[] => {
  const found: El[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== "object") return;
    const el = node as El;
    if (!el.props) return;
    if (match(el)) found.push(el);
    visit(el.props.children);
  };
  visit(root);
  return found;
};

describe("EarlierMessages", () => {
  it("calls onLoad from its quiet button", () => {
    const onLoad = vi.fn();
    const tree = EarlierMessages({ loading: false, onLoad });
    const button = findAll(tree, (el) => el.props?.className === "button ghost")[0]!;
    expect(button.props!.disabled).toBe(false);
    (button.props!.onClick as () => void)();
    expect(onLoad).toHaveBeenCalledOnce();
  });
});
