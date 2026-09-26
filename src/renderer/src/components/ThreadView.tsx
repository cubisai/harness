import { useEffect, useMemo, useRef } from "react";
import type { StoredEvent, ThreadEvent } from "../../../shared/types";
import { type FileRef, parseFileRef } from "../fileref";
import { emptyLive, liveReasoningMode, visibleItems } from "../live";
import { Markdown } from "../markdown";
import { useStore } from "../store";
import { PermissionCard } from "./PermissionCard";
import { ReasoningBlock } from "./ReasoningBlock";

type ToolEvent = Extract<ThreadEvent, { kind: "tool-use" }>;
type ResultEvent = Extract<ThreadEvent, { kind: "tool-result" }>;

const EMPTY_LIVE = emptyLive();

export function ThreadView({ threadId }: { threadId: string }) {
  const events = useStore((s) => s.events[threadId]) ?? EMPTY;
  const live = useStore((s) => s.live[threadId]) ?? EMPTY_LIVE;
  const running = useStore((s) => Boolean(s.running[threadId]));
  const allPermissions = useStore((s) => s.permissions);
  const permissions = useMemo(() => allPermissions.filter((p) => p.threadId === threadId), [allPermissions, threadId]);
  const scroller = useRef<HTMLDivElement>(null);
  // Tool-output items are not rendered yet; reasoning uses ReasoningBlock below.
  const textItems = visibleItems(live, "text");
  const reasoningItems = visibleItems(live, "reasoning").filter((it) => !it.opaque);
  const reasoningMode = liveReasoningMode(live);
  const textLength = textItems.reduce((n, it) => n + it.text.length, 0);

  const results = useMemo(() => {
    const map = new Map<string, ResultEvent>();
    for (const e of events) if (e.event.kind === "tool-result") map.set(e.event.toolUseId, e.event);
    return map;
  }, [events]);

  // Stay pinned to the bottom while the user hasn't scrolled away.
  const pinned = useRef(true);
  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [events.length, textLength, permissions.length]);

  return (
    <div
      className="thread-scroll"
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      <div className="thread-inner">
        {events.map((e) => (
          <EventRow key={e.seq} stored={e} results={results} running={running} />
        ))}
        {reasoningMode === "text" &&
          reasoningItems.map((item, i) => (
            <ReasoningBlock key={item.key} text={item.text} opaque={false} live newest={i === reasoningItems.length - 1 && textItems.length === 0} tokens={null} />
          ))}
        {reasoningMode === "tokens" && <ReasoningBlock text="" opaque live newest tokens={live.thinkingTokens} />}
        {textItems.map((item) => (
          <div className="msg-assistant" key={item.key}>
            <Markdown text={item.text} streaming />
          </div>
        ))}
        {running && textItems.length === 0 && reasoningMode === "none" && permissions.length === 0 && <div className="notice"><span className="spinner" style={{ display: "inline-block", verticalAlign: -2, marginRight: 8 }} />Working…</div>}
        {permissions.map((p) => (
          <PermissionCard key={p.requestId} request={p} />
        ))}
      </div>
    </div>
  );
}

const EMPTY: StoredEvent[] = [];

export function EventRow({ stored, results, running }: { stored: StoredEvent; results: Map<string, ResultEvent>; running: boolean }) {
  const e = stored.event;
  switch (e.kind) {
    case "user":
      return (
        <div className="msg-user">
          <div className="bubble">
            {e.skill && <span className="skill-chip">/{e.skill}</span>}
            {e.text}
          </div>
        </div>
      );
    case "assistant-text":
      return (
        <div className="msg-assistant">
          <Markdown text={e.text} onFile={openRef} />
        </div>
      );
    case "thinking":
      if (!e.text && !e.opaque) return null;
      return <ReasoningBlock text={e.text} opaque={Boolean(e.opaque)} live={false} newest={false} tokens={null} />;
    case "tool-use":
      return <ToolRow tool={e} result={results.get(e.toolUseId)} running={running} />;
    case "tool-result":
      return null; // shown on its tool row
    case "turn-end":
      return (
        <div className="turn-meta">
          <span>{formatTokens(e.inputTokens)} in</span>
          <span>{formatTokens(e.outputTokens)} out</span>
          {e.costUsd !== null && <span>${e.costUsd.toFixed(e.costUsd < 1 ? 3 : 2)}</span>}
          <span>{(e.durationMs / 1000).toFixed(1)}s</span>
        </div>
      );
    case "error":
      return <div className="error-card">{e.message}</div>;
    case "notice":
      return <div className="notice">{e.text}</div>;
    case "plan":
      return (
        <div className="plan-row">
          <div className="plan-title">Plan</div>
          <ul>
            {e.entries.map((p, i) => (
              <li key={i} className={`plan-item ${p.status}`}>
                <span className="plan-mark">{p.status === "completed" ? "✓" : p.status === "in_progress" ? "▸" : "○"}</span>
                {p.content}
              </li>
            ))}
          </ul>
        </div>
      );
    case "compaction":
      return (
        <div className="compaction-divider">
          <span>Context compacted{e.preTokens !== null && e.postTokens !== null ? ` · ${formatTokens(e.preTokens)} → ${formatTokens(e.postTokens)} tokens` : ""}</span>
        </div>
      );
    case "turn-start":
      return null;
  }
}

function ToolRow({ tool, result, running }: { tool: ToolEvent; result?: ResultEvent; running: boolean }) {
  const state = result ? (result.isError ? "error" : "done") : running ? "pending" : "";
  // File tools name the file they touched; open it from the row.
  const fileRef = FILE_TOOLS.has(tool.name) ? parseFileRef(tool.summary.split(", ")[0] ?? "") : null;
  return (
    <div className="tool-row" title={result?.summary ?? tool.summary}>
      <span className={`dot ${state}`} />
      <span className="name">{prettyTool(tool.name)}</span>
      {fileRef ? (
        <button className="summary file-link" title="Open in the editor" onClick={() => openRef(fileRef)}>
          {tool.summary}
        </button>
      ) : (
        <span className="summary">{tool.summary}</span>
      )}
      {result?.summary && <span className="result">{result.summary}</span>}
    </div>
  );
}

const FILE_TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"]);

function openRef(ref: FileRef): void {
  void useStore.getState().openInEditor(ref);
}

function prettyTool(name: string): string {
  if (name.startsWith("mcp__unskilled__")) return name.slice("mcp__unskilled__".length);
  if (name.startsWith("mcp__")) return name.split("__").slice(1).join(" · ");
  return name;
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}
