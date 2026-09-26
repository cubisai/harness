import type { LiveDelta, StoredEvent } from "../../shared/types";

/** One streaming item: flushed `text`, plus the `pending` tail batched since the last flush. */
export interface LiveItem {
  key: string;
  channel: "text" | "reasoning" | "tool-output";
  text: string;
  pending: string;
  opaque: boolean;
}

/** A thread's live-only stream; `done` holds keys whose terminal event already landed. */
export interface LiveThread {
  items: LiveItem[];
  done: string[];
  thinkingTokens: number | null;
  /** The running turn's latest usage numbers, merged from usage-update deltas. */
  usage: Omit<Extract<LiveDelta, { kind: "usage-update" }>, "kind"> | null;
}

export function emptyLive(): LiveThread {
  return { items: [], done: [], thinkingTokens: null, usage: null };
}

/** Most characters kept per item; a longer item keeps its tail. */
export const LIVE_ITEM_CAP = 64_000;

/**
 * Fold one live delta into the stream. Text lands in `pending`; `flushPending`
 * moves it onto `text`, so a burst of tokens costs one store write.
 */
export function appendDelta(state: LiveThread, delta: LiveDelta): LiveThread {
  if (delta.kind === "text-delta") return appendItem(state, `text:${delta.itemId}`, "text", delta.text, false);
  if (delta.kind === "reasoning-delta") return appendItem(state, `reasoning:${delta.itemId}`, "reasoning", delta.text, delta.opaque ?? false);
  if (delta.kind === "tool-output-delta") return appendItem(state, `tool:${delta.toolUseId}`, "tool-output", delta.text, false);
  if (delta.kind === "thinking-progress") return { ...state, thinkingTokens: delta.estimatedTokens };
  if (delta.kind === "usage-update") {
    const { kind: _kind, ...fields } = delta;
    return { ...state, usage: { ...(state.usage ?? {}), ...fields } };
  }
  return state;
}

export function flushPending(state: LiveThread): LiveThread {
  if (!state.items.some((it) => it.pending)) return state;
  return {
    ...state,
    items: state.items.map((it) => {
      if (!it.pending) return it;
      const text = it.text + it.pending;
      return { ...it, text: text.length > LIVE_ITEM_CAP ? text.slice(-LIVE_ITEM_CAP) : text, pending: "" };
    }),
  };
}

/**
 * Apply a stored terminal event: the matching item is done and a late delta for
 * it is dropped. Mid-turn events (tool-use, thinking, …) leave text alone.
 */
export function applyLiveEvent(state: LiveThread, stored: StoredEvent): LiveThread {
  const e = stored.event;
  switch (e.kind) {
    // Some agents have no item ids; a missing id ends every item in the channel.
    case "assistant-text":
      return e.itemId ? removeKey(state, `text:${e.itemId}`) : removeChannel(state, "text");
    case "thinking": {
      const next = e.itemId ? removeKey(state, `reasoning:${e.itemId}`) : removeChannel(state, "reasoning");
      return { ...next, thinkingTokens: null };
    }
    case "tool-result":
      return removeKey(state, `tool:${e.toolUseId}`);
    default:
      return state;
  }
}

/** Items of one channel with flushed, non-empty text, in arrival order. */
export function visibleItems(state: LiveThread, channel: LiveItem["channel"]): LiveItem[] {
  return state.items.filter((it) => it.channel === channel && it.text.length > 0);
}

/** Which half of a reasoning block to show: its text, or only a token count. */
export function reasoningChannel(input: { opaque: boolean }): "text" | "tokens" {
  return input.opaque ? "tokens" : "text";
}

/**
 * How a turn's live reasoning is shown: streaming text once any non-opaque item
 * has flushed, else the opaque token counter, else nothing. Text wins, so a turn
 * that starts opaque and later produces text tears the counter down.
 */
export function liveReasoningMode(state: LiveThread): "text" | "tokens" | "none" {
  if (visibleItems(state, "reasoning").some((it) => !it.opaque)) return "text";
  if (state.thinkingTokens !== null) return "tokens";
  return "none";
}

function appendItem(state: LiveThread, key: string, channel: LiveItem["channel"], text: string, opaque: boolean): LiveThread {
  if (state.done.includes(key)) return state;
  const items = state.items.slice();
  const i = items.findIndex((it) => it.key === key);
  if (i >= 0) {
    const item = items[i]!;
    items[i] = { ...item, pending: item.pending + text, opaque: item.opaque || opaque };
  } else {
    items.push({ key, channel, text: "", pending: text, opaque });
  }
  return { ...state, items };
}

function removeKey(state: LiveThread, key: string): LiveThread {
  if (state.done.includes(key)) return state;
  return { ...state, items: state.items.filter((it) => it.key !== key), done: [...state.done, key] };
}

function removeChannel(state: LiveThread, channel: LiveItem["channel"]): LiveThread {
  const keys = state.items.filter((it) => it.channel === channel).map((it) => it.key);
  if (!keys.length) return state;
  const drop = new Set(keys);
  return { ...state, items: state.items.filter((it) => !drop.has(it.key)), done: [...state.done, ...keys] };
}
