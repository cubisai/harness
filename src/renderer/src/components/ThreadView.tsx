import { useEffect, useMemo, useRef } from "react";
import type { StoredEvent, ThreadEvent } from "../../../shared/types";
import { prettyTool, type RunResult } from "../../../shared/tools";
import { type FileRef, parseFileRef } from "../fileref";
import { emptyLive, liveReasoningMode, visibleItems } from "../live";
import { Markdown } from "../markdown";
import { useStore } from "../store";
import { DiffView, diffsOf } from "./DiffView";
import { PermissionCard } from "./PermissionCard";
import { ReasoningBlock } from "./ReasoningBlock";
import { WaitingLine } from "./WaitingLine";
import { useSmoothText } from "../hooks/useSmoothText";

type ToolEvent = Extract<ThreadEvent, { kind: "tool-use" }>;
type ResultEvent = Extract<ThreadEvent, { kind: "tool-result" }>;

const EMPTY_LIVE = emptyLive();

/** A reply still streaming, shown at a steady pace (see smooth.ts). */
function LiveText({ text }: { text: string }) {
  const shown = useSmoothText(text, true);
  return (
    <div className="msg-assistant">
      <Markdown text={shown} streaming />
    </div>
  );
}

/** Reasoning still streaming, at the same pace. */
function LiveReasoning({ text, newest }: { text: string; newest: boolean }) {
  const shown = useSmoothText(text, true);
  return <ReasoningBlock text={shown} opaque={false} live newest={newest} tokens={null} />;
}
const NO_QUEUE: { text: string; skill?: string }[] = [];

export function ThreadView({ threadId }: { threadId: string }) {
  const events = useStore((s) => s.events[threadId]) ?? EMPTY;
  const live = useStore((s) => s.live[threadId]) ?? EMPTY_LIVE;
  const running = useStore((s) => Boolean(s.running[threadId]));
  const outbox = useStore((s) => s.outbox[threadId]) ?? NO_QUEUE;
  const startedAt = useStore((s) => s.turnStartedAt[threadId]);
  const inner = useRef<HTMLDivElement>(null);
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
  // Smoothed text keeps growing after the store stops changing: follow the content's size.
  useEffect(() => {
    const el = scroller.current;
    const body = inner.current;
    if (!el || !body || typeof ResizeObserver === "undefined") return;
    const follow = new ResizeObserver(() => {
      if (pinned.current) el.scrollTop = el.scrollHeight;
    });
    follow.observe(body);
    return () => follow.disconnect();
  }, []);

  return (
    <div
      className="thread-scroll"
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      <div className="thread-inner" ref={inner}>
        {events.map((e) => (
          <EventRow key={e.seq} stored={e} results={results} running={running} threadId={threadId} />
        ))}
        {reasoningMode === "text" &&
          reasoningItems.map((item, i) => (
            <LiveReasoning key={item.key} text={item.text} newest={i === reasoningItems.length - 1 && textItems.length === 0} />
          ))}
        {reasoningMode === "tokens" && <ReasoningBlock text="" opaque live newest tokens={live.thinkingTokens} />}
        {textItems.map((item) => (
          <LiveText key={item.key} text={item.text} />
        ))}
        {running && permissions.length === 0 && (
          <WaitingLine startedAt={startedAt ?? Date.now()} outputTokens={live.usage?.outputTokens ?? live.thinkingTokens ?? null} />
        )}
        {permissions.map((p) => (
          <PermissionCard key={p.requestId} request={p} />
        ))}
        {outbox.map((m, i) => (
          <div className="msg-user" key={`queued-${i}`}>
            <div className="bubble queued" title="Queued: sends when this turn ends">
              {m.skill && <span className="skill-chip">/{m.skill}</span>}
              {m.text}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const EMPTY: StoredEvent[] = [];

export function EventRow({ stored, results, running, threadId }: { stored: StoredEvent; results: Map<string, ResultEvent>; running: boolean; threadId?: string }) {
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
      return <ToolEventRow tool={e} result={results.get(e.toolUseId)} running={running} threadId={threadId} />;
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
    case "handoff":
      return (
        <div className="compaction-divider">
          <span>{e.text}</span>
        </div>
      );
    case "turn-start":
      return null;
  }
}

function ToolEventRow({ tool, result, running, threadId }: { tool: ToolEvent; result?: ResultEvent; running: boolean; threadId?: string }) {
  const open = useStore((s) => (threadId ? Boolean(s.disclosures[threadId]?.[tool.toolUseId]) : false));
  return <ToolRow tool={tool} result={result} running={running} open={open} onToggle={(o) => threadId && useStore.getState().setDisclosure(threadId, tool.toolUseId, o)} />;
}

export function ToolRow({ tool, result, running, open, onToggle }: { tool: ToolEvent; result?: ResultEvent; running: boolean; open: boolean; onToggle(open: boolean): void }) {
  const state = result ? (result.isError ? "error" : "done") : running ? "pending" : "";
  // File tools name the file they touched; open it from the row.
  const fileRef = FILE_TOOLS.has(tool.name) ? parseFileRef(tool.summary.split(", ")[0] ?? "") : null;
  // One diff renderer for every agent's edits; the result payload wins.
  const diffs = diffsOf(result?.payload) ?? diffsOf(tool.payload);
  const run = runResultOf(result?.payload);
  const hasInput = tool.payload !== undefined && diffs === null;
  const hasOutput = result?.payload !== undefined && diffs === null && run === null;
  return (
    <details className="tool" open={open} onToggle={(e) => onToggle(e.currentTarget.open)}>
      <summary className="tool-row" title={result?.summary ?? tool.summary}>
        <span className={`dot ${state}`} />
        <span className="name">{prettyTool(tool.name)}</span>
        {fileRef ? (
          <button
            className="summary file-link"
            title="Open in the editor"
            onClick={(e) => {
              e.preventDefault();
              openRef(fileRef);
            }}
          >
            {tool.summary}
          </button>
        ) : (
          <span className="summary">{tool.summary}</span>
        )}
        {result?.summary && <span className="result">{result.summary}</span>}
      </summary>
      {open && (
        <div className="tool-body">
          {diffs && (
            <div className="tool-section">
              <div className="tool-label">Changes</div>
              <DiffView diffs={diffs} />
            </div>
          )}
          {run && (
            <div className="tool-section">
              <div className="tool-label">{typeof run.exitCode === "number" ? `Output (exit ${run.exitCode})` : "Output"}</div>
              <pre className="tool-pre">{run.output}</pre>
            </div>
          )}
          {hasInput && (
            <div className="tool-section">
              <div className="tool-label">Input</div>
              <pre className="tool-pre">{payloadText(tool.payload)}</pre>
            </div>
          )}
          {hasOutput && (
            <div className="tool-section">
              <div className="tool-label">{result!.isError ? "Error" : "Output"}</div>
              <pre className="tool-pre">{payloadText(result!.payload)}</pre>
            </div>
          )}
          {!diffs && !run && !hasInput && !hasOutput && <div className="tool-empty">No details recorded.</div>}
        </div>
      )}
    </details>
  );
}

/** A Run tool result's `{ exitCode, output }`, or null for any other payload. */
function runResultOf(v: unknown): RunResult | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const p = v as { exitCode?: unknown; output?: unknown };
  return (typeof p.exitCode === "number" || p.exitCode === null) && typeof p.output === "string" ? { exitCode: p.exitCode, output: p.output } : null;
}

function isBlobStub(v: unknown): v is { blobRef: string; preview: string; bytes?: number } {
  if (!v || typeof v !== "object") return false;
  const p = v as Record<string, unknown>;
  return typeof p.blobRef === "string" && typeof p.preview === "string";
}

/** A tool payload as display text: stubs show their preview, everything else its JSON. */
export function payloadText(v: unknown): string {
  let text: string;
  if (typeof v === "string") text = v;
  else if (isBlobStub(v)) text = `${v.preview}\n... (${v.bytes ?? 0} bytes, truncated)`;
  else text = JSON.stringify(v, null, 2) ?? "";
  if (text.length > 4000) return `${text.slice(0, 4000)}\n... (cut)`;
  return text;
}

const FILE_TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"]);

function openRef(ref: FileRef): void {
  void useStore.getState().openInEditor(ref);
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}
