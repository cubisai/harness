import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Copy, Pencil, RotateCcw, X } from "lucide-react";
import { artifactKind, isPreviewable, PLAN_ARTIFACT } from "../../../shared/artifact-kind";
import { skillsOf } from "../../../shared/skill-list";
import type { ArtifactKind, StoredEvent, ThreadEvent } from "../../../shared/types";
import { prettyTool, type RunResult } from "../../../shared/tools";
import { displayOrder } from "../event-order";
import { type FileRef, parseFileRef } from "../fileref";
import { emptyLive, liveReasoningMode, visibleItems } from "../live";
import { Markdown } from "../markdown";
import { relativeToThread, useStore } from "../store";
import { DiffView, diffsOf } from "./DiffView";
import { ReasoningBlock } from "./ReasoningBlock";
import { activityOf, WaitingLine } from "./WaitingLine";
import { useSmoothText } from "../hooks/useSmoothText";
import { segmentEvents, type Segment, type TurnChanges, workDuration, workSummary } from "../turns";

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
const NO_QUEUE: { text: string; skills?: string[] }[] = [];

/** The skills a message ran with, as chips before its text. */
function SkillChips({ names }: { names: string[] }) {
  return (
    <>
      {names.map((n) => (
        <span key={n} className="skill-chip">
          ${n}
        </span>
      ))}
    </>
  );
}

export function ThreadView({ threadId }: { threadId: string }) {
  const events = useStore((s) => s.events[threadId]) ?? EMPTY;
  const live = useStore((s) => s.live[threadId]) ?? EMPTY_LIVE;
  const running = useStore((s) => Boolean(s.running[threadId]));
  const outbox = useStore((s) => s.outbox[threadId]) ?? NO_QUEUE;
  const startedAt = useStore((s) => s.turnStartedAt[threadId]);
  const inner = useRef<HTMLDivElement>(null);
  const allPermissions = useStore((s) => s.permissions);
  const permissions = useMemo(() => allPermissions.filter((p) => p.threadId === threadId), [allPermissions, threadId]);
  const allPlans = useStore((s) => s.plans);
  const plans = useMemo(() => allPlans.filter((p) => p.threadId === threadId), [allPlans, threadId]);
  // The cards themselves are docked above the composer (RequestDock); here they only pause the waiting line.
  const asking = useStore((s) => s.questions.some((q) => q.threadId === threadId));
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
  // A subagent's steps belong to the Agent call that spawned them, not the top level.
  const children = useMemo(() => {
    const map = new Map<string, StoredEvent[]>();
    for (const e of events) {
      const parentId = e.event.parentId;
      if (!parentId) continue;
      const list = map.get(parentId);
      if (list) list.push(e);
      else map.set(parentId, [e]);
    }
    return map;
  }, [events]);
  // Agents resend the whole todo list on every update: show only a turn's latest plan.
  const stalePlans = useMemo(() => {
    const stale = new Set<number>();
    let last: number | null = null;
    for (const e of events) {
      if (e.event.kind === "user" || e.event.kind === "turn-end") last = null;
      else if (e.event.kind === "plan") {
        if (last !== null) stale.add(last);
        last = e.seq;
      }
    }
    return stale;
  }, [events]);
  // The current turn: everything after the last top-level user message.
  const turnEvents = useMemo(() => {
    let start = 0;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.event.kind === "user" && !e.event.parentId) {
        start = i + 1;
        break;
      }
    }
    return events.slice(start);
  }, [events]);
  // A running check row is replaced by a later final row for the same round.
  const hiddenChecks = useMemo(() => {
    const finals = events.filter((e) => e.event.kind === "check" && e.event.ok !== null);
    const hidden = new Set<number>();
    for (const e of events) {
      const c = e.event;
      if (c.kind !== "check" || c.ok !== null) continue;
      const replaced = finals.some((f) => f.seq > e.seq && f.event.kind === "check" && f.event.round === c.round && f.event.command === c.command);
      if (replaced) hidden.add(e.seq);
    }
    return hidden;
  }, [events]);
  // What the thread actually renders: notices written for a message show above it,
  // tool runs fold into "Worked for" groups, and each turn ends with its footer.
  const displayEvents = useMemo(() => displayOrder(events), [events]);
  const segments = useMemo(
    () => segmentEvents(displayEvents.filter((e) => !stalePlans.has(e.seq) && !hiddenChecks.has(e.seq) && !e.event.parentId), running),
    [displayEvents, stalePlans, hiddenChecks, running],
  );
  const lastTurnEnd = useMemo(() => {
    for (let i = segments.length - 1; i >= 0; i--) if (segments[i]!.kind === "turn-end") return i;
    return -1;
  }, [segments]);

  // Stay pinned to the bottom while the user hasn't scrolled away.
  const pinned = useRef(true);
  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [events.length, textLength, permissions.length, plans.length]);
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
        {segments.map((seg, i) => (
          <SegmentRow key={segmentKey(seg)} seg={seg} results={results} children={children} running={running} threadId={threadId} last={i === lastTurnEnd} />
        ))}
        {reasoningMode === "text" &&
          reasoningItems.map((item, i) => (
            <LiveReasoning key={item.key} text={item.text} newest={i === reasoningItems.length - 1 && textItems.length === 0} />
          ))}
        {reasoningMode === "tokens" && <ReasoningBlock text="" opaque live newest tokens={live.thinkingTokens} />}
        {textItems.map((item) => (
          <LiveText key={item.key} text={item.text} />
        ))}
        {running && permissions.length === 0 && plans.length === 0 && !asking && (
          <WaitingLine
            startedAt={startedAt ?? Date.now()}
            outputTokens={live.usage?.outputTokens ?? live.thinkingTokens ?? null}
            activity={activityOf(turnEvents, { textStreaming: textItems.length > 0, reasoningStreaming: reasoningItems.length > 0 || live.thinkingTokens !== null })}
          />
        )}
        {outbox.map((m, i) => (
          <div className="msg-user" key={`queued-${i}`}>
            <div className="bubble queued" title="Queued: sends when this turn ends">
              <SkillChips names={m.skills ?? []} />
              {m.text}
            </div>
            <button
              className="icon-button queued-remove"
              aria-label="Remove queued message"
              title="Remove"
              onClick={() => useStore.getState().dequeue(threadId, i)}
            >
              <X size={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

const EMPTY: StoredEvent[] = [];

function segmentKey(seg: Segment): string {
  return seg.kind === "work" ? `w${seg.key}` : `e${seg.stored.seq}`;
}

/** One display segment: an event, a folded run of work, or a turn's changes card and footer. */
function SegmentRow({ seg, results, children, running, threadId, last }: { seg: Segment; results: Map<string, ResultEvent>; children: Map<string, StoredEvent[]>; running: boolean; threadId: string; last: boolean }) {
  if (seg.kind === "work") return <WorkGroup seg={seg} results={results} children={children} running={running} threadId={threadId} />;
  if (seg.kind === "turn-end") {
    return (
      <>
        <FileCards files={seg.changes?.files ?? []} turnSeq={seg.stored.seq} />
        {seg.changes && <ChangesCard changes={seg.changes} />}
        <TurnFooter seg={seg} threadId={threadId} running={running} last={last} />
      </>
    );
  }
  return <EventRow stored={seg.stored} results={results} children={children} running={running} threadId={threadId} />;
}

/**
 * A finished run of tool calls as one line, "Worked for 41s · read 2 files ·
 * ran 1 command", opening to its steps (DESIGN.md §7.4). A run still in
 * progress shows its rows as they come.
 */
function WorkGroup({ seg, results, children, running, threadId }: { seg: Extract<Segment, { kind: "work" }>; results: Map<string, ResultEvent>; children: Map<string, StoredEvent[]>; running: boolean; threadId: string }) {
  const id = `work-${seg.key}`;
  const open = useStore((s) => Boolean(s.disclosures[threadId]?.[id]));
  const rows = seg.items.map((e) =>
    e.event.kind === "assistant-text" ? (
      <div className="work-note" key={e.seq}>
        <Markdown text={e.event.text} onFile={openRef} />
      </div>
    ) : (
      <EventRow key={e.seq} stored={e} results={results} children={children} running={running} threadId={threadId} />
    ),
  );
  if (!seg.done) return <div className="work-live">{rows}</div>;
  return (
    <details className="work" open={open} onToggle={(e) => useStore.getState().setDisclosure(threadId, id, e.currentTarget.open)}>
      <summary>
        <ChevronRight size={13} className="chev" />
        {seg.endedAt - seg.startedAt >= 1000 ? `Worked for ${workDuration(seg.endedAt - seg.startedAt)}` : "Worked"}
        <span className="work-sum">{workSummary(seg.items) ? ` · ${workSummary(seg.items)}` : ""}</span>
      </summary>
      {open && <div className="work-body">{rows}</div>}
    </details>
  );
}

const KIND_LABEL: Record<ArtifactKind, string> = {
  md: "Document", html: "Web page", svg: "Image", pdf: "PDF", image: "Image", csv: "Table",
  docx: "Word document", sheet: "Spreadsheet", pptx: "Presentation", code: "Code", text: "Text",
};

/**
 * A card for each previewable file the turn wrote (the last three); Preview shows it in the panel.
 * `files` are the turn's Edit paths; files it wrote by command come from the artifacts recorded at its turn-end.
 */
function FileCards({ files, turnSeq }: { files: string[]; turnSeq: number }) {
  const open = useStore((s) => s.artifact?.path ?? null);
  const threadId = useStore((s) => s.selectedThreadId);
  const threads = useStore((s) => s.threads);
  const projects = useStore((s) => s.projects);
  const recorded = useStore((s) => (threadId ? s.artifactFiles[threadId] : undefined));
  const toRel = (path: string) => (threadId ? relativeToThread({ threads, projects }, threadId, path) : path);
  const written = (recorded ?? []).filter((f) => f.versions.some((v) => v.turnSeq === turnSeq)).map((f) => f.path);
  const unique = [...new Map([...files, ...written].map((f) => [toRel(f), f])).values()];
  const shown = unique.filter(isPreviewable).slice(-3);
  if (!shown.length) return null;
  return (
    <div className="file-cards">
      {shown.map((file) => {
        const rel = toRel(file);
        const name = rel.split("/").pop() ?? rel;
        const ext = (/\.([^.]+)$/.exec(name)?.[1] ?? "").slice(0, 4).toUpperCase();
        const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/") + 1) : "";
        return (
          <button key={file} className={`file-card${open === rel ? " open" : ""}`} title={file} onClick={() => useStore.getState().openArtifact(file)}>
            <span className="file-card-ext">{ext}</span>
            <span className="file-card-text">
              <span className="file-card-name">{name}</span>
              <span className="file-card-sub">
                {KIND_LABEL[artifactKind(name)]}
                {dir && ` · ${dir}`}
              </span>
            </span>
            <span className="file-card-action">Preview</span>
          </button>
        );
      })}
    </div>
  );
}

/** What a turn changed: "2 files changed +38 −0", with Review opening the Changes tab. */
function ChangesCard({ changes }: { changes: TurnChanges }) {
  const n = changes.files.length;
  return (
    <div className="changes-card" title={changes.files.join("\n")}>
      <span className="changes-count">
        {n} {n === 1 ? "file" : "files"} changed
      </span>
      {changes.additions !== null && <span className="add">+{changes.additions}</span>}
      {changes.deletions !== null && <span className="del">−{changes.deletions}</span>}
      <span className="grow" />
      <button className="button" onClick={() => useStore.getState().showInspector("changes")}>
        Review
      </button>
    </div>
  );
}

/** A turn's footer: Copy and Retry, then the model's usage. Shown on hover, always on the last turn. */
function TurnFooter({ seg, threadId, running, last }: { seg: Extract<Segment, { kind: "turn-end" }>; threadId: string; running: boolean; last: boolean }) {
  const e = seg.stored.event as Extract<ThreadEvent, { kind: "turn-end" }>;
  const [copied, setCopied] = useState(false);
  return (
    <div className={`turn-foot${last ? " last" : ""}`}>
      {seg.answer && (
        <button
          className="foot-button"
          title={copied ? "Copied" : "Copy the reply"}
          onClick={() => {
            void navigator.clipboard?.writeText(seg.answer).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            });
          }}
        >
          <Copy size={13} />
        </button>
      )}
      {seg.prompt && (
        <button
          className="foot-button"
          title="Send the same message again"
          disabled={running}
          onClick={() => void useStore.getState().send(seg.prompt!.text, seg.prompt!.skills, threadId)}
        >
          <RotateCcw size={13} />
        </button>
      )}
      <span className="turn-meta">
        <span>{formatTokens(e.inputTokens)} in</span>
        <span>{formatTokens(e.outputTokens)} out</span>
        {e.costUsd !== null && <span>${e.costUsd.toFixed(e.costUsd < 1 ? 3 : 2)}</span>}
        <span>{(e.durationMs / 1000).toFixed(1)}s</span>
      </span>
    </div>
  );
}

/** Your message: a compact bubble, with Copy, Edit (back into the message box) and the time on hover. */
function UserMessage({ stored }: { stored: StoredEvent }) {
  const e = stored.event as Extract<ThreadEvent, { kind: "user" }>;
  const time = new Date(stored.createdAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return (
    <div className="msg-user">
      <div className="bubble">
        <SkillChips names={skillsOf(e)} />
        {e.text}
      </div>
      <div className="msg-actions">
        <span className="msg-time">{time}</span>
        <button className="foot-button" title="Copy" onClick={() => void navigator.clipboard?.writeText(e.text)}>
          <Copy size={13} />
        </button>
        <button className="foot-button" title="Edit: put it back in the message box" onClick={() => useStore.getState().setComposerDraft(e.text)}>
          <Pencil size={13} />
        </button>
      </div>
    </div>
  );
}

export function EventRow({ stored, results, children, running, threadId }: { stored: StoredEvent; results: Map<string, ResultEvent>; children?: Map<string, StoredEvent[]>; running: boolean; threadId?: string }) {
  const e = stored.event;
  switch (e.kind) {
    case "user":
      return <UserMessage stored={stored} />;
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
      return (
        <ToolEventRow
          tool={e}
          result={results.get(e.toolUseId)}
          children={children?.get(e.toolUseId)}
          results={results}
          running={running}
          threadId={threadId}
          startedAt={stored.createdAt}
        />
      );
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
    case "plan-proposal":
      return (
        <details className="tool plan-proposal">
          <summary className="tool-row">
            <span className="name">Plan</span>
            <button
              className="plan-open"
              onClick={(ev) => {
                ev.preventDefault();
                useStore.getState().openArtifact(PLAN_ARTIFACT);
              }}
            >
              Open in panel
            </button>
          </summary>
          <div className="tool-body">
            <Markdown text={e.text} onFile={openRef} />
          </div>
        </details>
      );
    case "plan-decision":
      return (
        <div className="notice">
          {e.choice === "auto" ? "Plan approved — auto-accept edits" : e.choice === "manual" ? "Plan approved — manual approval" : "Kept planning"}
        </div>
      );
    case "questions":
      return <QuestionsRow items={e.items} skipped={e.skipped} />;
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
    case "check":
      // Short on purpose: the command itself is in the tooltip, and in a failure's output.
      return (
        <div className="notice check-row" title={e.command}>
          {e.ok === null ? (
            "Checking…"
          ) : e.ok ? (
            <>✓ Check passed · {(e.durationMs / 1000).toFixed(1)}s</>
          ) : (
            <>✗ Check failed{e.timedOut ? " (timed out)" : e.exitCode !== null ? ` (exit ${e.exitCode})` : ""}</>
          )}
          {e.ok === false && (
            <details>
              <summary>Output</summary>
              <pre className="tool-pre">{`$ ${e.command}${e.tail ? `\n${e.tail}` : ""}`}</pre>
            </details>
          )}
        </div>
      );
    case "context-breakdown":
      return null; // a tooltip detail on the first turn, not a conversation row
    case "turn-start":
      return null;
  }
}

function ToolEventRow({
  tool,
  result,
  children,
  results,
  running,
  threadId,
  startedAt,
}: {
  tool: ToolEvent;
  result?: ResultEvent;
  children?: StoredEvent[];
  results?: Map<string, ResultEvent>;
  running: boolean;
  threadId?: string;
  startedAt?: number;
}) {
  const open = useStore((s) => (threadId ? Boolean(s.disclosures[threadId]?.[tool.toolUseId]) : false));
  return (
    <ToolRow
      tool={tool}
      result={result}
      children={children}
      results={results}
      running={running}
      open={open}
      startedAt={startedAt}
      threadId={threadId}
      onToggle={(o) => threadId && useStore.getState().setDisclosure(threadId, tool.toolUseId, o)}
    />
  );
}

/** Seconds since `startedAt`, ticking once a second while `active`; null when inactive. */
function useRunningTimer(startedAt: number | undefined, active: boolean): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || startedAt === undefined) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active, startedAt]);
  return active && startedAt !== undefined ? Math.max(0, Math.floor((now - startedAt) / 1000)) : null;
}

export function ToolRow({
  tool,
  result,
  children,
  results,
  running,
  open,
  startedAt,
  threadId,
  onToggle,
}: {
  tool: ToolEvent;
  result?: ResultEvent;
  children?: StoredEvent[];
  results?: Map<string, ResultEvent>;
  running: boolean;
  open: boolean;
  startedAt?: number;
  threadId?: string;
  onToggle(open: boolean): void;
}) {
  const state = result ? (result.isError ? "error" : "done") : running ? "pending" : "";
  // File tools name the file they touched; open it from the row.
  const fileRef = FILE_TOOLS.has(tool.name) ? parseFileRef(tool.summary.split(", ")[0] ?? "") : null;
  // One diff renderer for every agent's edits; the result payload wins.
  const diffs = diffsOf(result?.payload) ?? diffsOf(tool.payload);
  const run = runResultOf(result?.payload);
  const hasInput = tool.payload !== undefined && diffs === null;
  const hasOutput = result?.payload !== undefined && diffs === null && run === null;
  // A Run's input is its command, an Agent's is its prompt: show those as text, not JSON.
  const command = runPayloadOf(tool.payload);
  const agent = command === null ? agentPromptOf(tool.payload) : null;
  // While an Agent runs, its newest child step stands in for a result summary.
  // Count tool calls only: each step's result and the subagent's text are children too.
  const toolSteps = children?.filter((c) => c.event.kind === "tool-use") ?? [];
  const lastStep = !result ? toolSteps[toolSteps.length - 1]?.event : undefined;
  const steps =
    lastStep && lastStep.kind === "tool-use"
      ? `${toolSteps.length} ${toolSteps.length === 1 ? "step" : "steps"} · ${prettyTool(lastStep.name)} ${lastStep.summary}`
      : "";
  const elapsed = useRunningTimer(startedAt, prettyTool(tool.name) === "Agent" && !result && running);
  const resultNote = result?.summary ?? [steps, elapsed !== null ? `running ${elapsed}s` : ""].filter(Boolean).join(" · ");
  return (
    <details className="tool" open={open} onToggle={(e) => onToggle(e.currentTarget.open)}>
      <summary className="tool-row" title={result?.summary ?? tool.summary}>
        <span className={`dot ${state}`} />
        <span className="name">{prettyTool(tool.name)}</span>
        {fileRef ? (
          <button
            className="summary file-link"
            title="Open in the panel"
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
        {resultNote && <span className="result">{resultNote}</span>}
      </summary>
      {open && (
        <div className="tool-body">
          {children && children.length > 0 && (
            <div className="tool-section">
              <div className="tool-label">Steps</div>
              <div className="tool-steps">
                {children.map((child) => {
                  const ce = child.event;
                  if (ce.kind === "tool-use") {
                    return (
                      <ToolEventRow
                        key={child.seq}
                        tool={ce}
                        result={results?.get(ce.toolUseId)}
                        results={results}
                        running={running}
                        threadId={threadId}
                        startedAt={child.createdAt}
                      />
                    );
                  }
                  // The subagent's closing text is usually its result: the Output section already shows it.
                  if (ce.kind === "assistant-text" && ce.text.trim() !== (typeof result?.payload === "string" ? result.payload.trim() : null)) {
                    return (
                      <div className="tool-step-text" key={child.seq}>
                        <Markdown text={ce.text} onFile={openRef} />
                      </div>
                    );
                  }
                  return null;
                })}
              </div>
            </div>
          )}
          {diffs && (
            <div className="tool-section">
              <div className="tool-label">Changes</div>
              <DiffView diffs={diffs} />
            </div>
          )}
          {hasInput && (
            <div className="tool-section">
              <div className="tool-label">{command !== null ? "Command" : agent !== null ? "Prompt" : "Input"}</div>
              <pre className="tool-pre">
                {command !== null ? `$ ${command}` : agent !== null ? (agent.subagent ? `subagent: ${agent.subagent}\n${agent.prompt}` : agent.prompt) : payloadText(tool.payload)}
              </pre>
            </div>
          )}
          {run && (
            <div className="tool-section">
              <div className="tool-label">{typeof run.exitCode === "number" ? `Output (exit ${run.exitCode})` : "Output"}</div>
              <pre className="tool-pre">{run.output}</pre>
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

/** A Run tool input's command, or null for any other payload. */
function runPayloadOf(v: unknown): string | null {
  // Every adapter's Run payload is exactly `{ command }`; other tools with a command argument keep their JSON.
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).length !== 1) return null;
  const command = (v as { command?: unknown }).command;
  return typeof command === "string" ? command : null;
}

/** An Agent tool input's prompt (and subagent kind), or null for any other payload. */
function agentPromptOf(v: unknown): { prompt: string; subagent?: string } | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const p = v as { prompt?: unknown; subagent_type?: unknown };
  if (typeof p.prompt !== "string") return null;
  return { prompt: p.prompt, ...(typeof p.subagent_type === "string" ? { subagent: p.subagent_type } : {}) };
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

/** A file named in a reply or a tool row opens in the panel; with no thread open, in the editor. */
function openRef(ref: FileRef): void {
  const s = useStore.getState();
  if (s.selectedThreadId) s.openArtifact(ref.path);
  else void s.openInEditor(ref);
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

/** An answered (or skipped) set of agent questions, one line; the full questions and answers on open. */
function QuestionsRow({ items, skipped }: { items: { header: string; question: string; answer: string[]; note?: string }[]; skipped: boolean }) {
  const n = items.length;
  const line = skipped
    ? `Skipped ${n === 1 ? "a question" : `${n} questions`}`
    : `Answered ${n === 1 ? "a question" : `${n} questions`} · ${items.map((i) => `${i.header || i.question}: ${i.answer.join(", ") || "default"}`).join(" · ")}`;
  return (
    <details className="tool questions-row">
      <summary className="tool-row">
        <span className="name">{line}</span>
      </summary>
      <div className="tool-body">
        {items.map((i, k) => (
          <div key={k} className="qa">
            <div className="q">{i.question}</div>
            <div className="a">{skipped ? "Skipped: the agent uses its default" : i.answer.join(", ") || "No answer: the agent uses its default"}</div>
            {i.note && <div className="note">Note: {i.note}</div>}
          </div>
        ))}
      </div>
    </details>
  );
}
