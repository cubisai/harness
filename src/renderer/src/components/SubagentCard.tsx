import { type ReactNode } from "react";
import { prettyTool } from "../../../shared/tools";
import type { StoredEvent, ThreadEvent } from "../../../shared/types";
import { useSmoothText } from "../hooks/useSmoothText";
import { type LiveThread, visibleItems } from "../live";
import { Markdown } from "../markdown";
import { useStore } from "../store";
import { ReasoningBlock } from "./ReasoningBlock";
import { agentPromptOf, openRef, payloadText, ToolEventRow, useRunningTimer } from "./ThreadView";

type ToolEvent = Extract<ThreadEvent, { kind: "tool-use" }>;
type ResultEvent = Extract<ThreadEvent, { kind: "tool-result" }>;

/**
 * A subagent (the Agent tool) as its own card: the steps it took, its prompt
 * and its output, with its newest step marked while it runs (DESIGN.md §7.4).
 */
export function SubagentCard({
  tool,
  result,
  children,
  results,
  running,
  open,
  startedAt,
  threadId,
  onToggle,
  live: liveOverride,
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
  /** The thread's live stream; read from the store when omitted (tests pass it). */
  live?: LiveThread;
}) {
  const state = result ? (result.isError ? "error" : "done") : running ? "pending" : "";
  const agent = agentPromptOf(tool.payload);
  const steps = children ?? [];
  // Count tool calls only: each step's result and the subagent's text are children too.
  const toolSteps = steps.filter((c) => c.event.kind === "tool-use");
  const stepNote = toolSteps.length ? `${toolSteps.length} ${toolSteps.length === 1 ? "step" : "steps"}` : "";
  // While it runs, its step count and elapsed time stand in for a result summary; before it ever
  // ran, name its last step instead (as the plain tool row did).
  const lastStep = !result ? toolSteps[toolSteps.length - 1]?.event : undefined;
  const lastNote = lastStep && lastStep.kind === "tool-use" ? `${stepNote} · ${prettyTool(lastStep.name)} ${lastStep.summary}` : "";
  const elapsed = useRunningTimer(startedAt, !result && running);
  const runningNote = [stepNote, elapsed !== null ? `${elapsed}s` : ""].filter(Boolean).join(" · ");
  const resultNote = result ? result.summary : running ? runningNote : lastNote;
  const hasOutput = result?.payload !== undefined;
  // What the subagent is writing or thinking right now (live deltas tagged with this call), until it lands as a step.
  const stored = useStore((s) => (threadId && !result ? s.live[threadId] : undefined));
  const live = result ? undefined : (liveOverride ?? stored);
  const liveReasoning = live ? visibleItems(live, "reasoning", tool.toolUseId).filter((it) => !it.opaque) : [];
  const liveText = live ? visibleItems(live, "text", tool.toolUseId) : [];
  // Steps that draw something: tool results show on their tool's row, so they are skipped here.
  const rendered: { seq: number; key?: string; node: ReactNode }[] = [];
  if (open) {
    for (const child of steps) {
      const ce = child.event;
      if (ce.kind === "tool-use") {
        rendered.push({
          seq: child.seq,
          node: <ToolEventRow tool={ce} result={results?.get(ce.toolUseId)} results={results} running={running} threadId={threadId} startedAt={child.createdAt} />,
        });
      } else if (ce.kind === "assistant-text" && ce.text.trim() !== (typeof result?.payload === "string" ? result.payload.trim() : null)) {
        // The subagent's closing text is usually its result: the Output section already shows it.
        rendered.push({
          seq: child.seq,
          node: (
            <div className="tool-step-text">
              <Markdown text={ce.text} onFile={openRef} />
            </div>
          ),
        });
      } else if (ce.kind === "thinking" && ce.text.trim()) {
        rendered.push({ seq: child.seq, node: <ReasoningBlock text={ce.text} opaque={Boolean(ce.opaque)} live={false} newest={false} tokens={null} /> });
      }
    }
    for (const it of liveReasoning) rendered.push({ seq: -1, key: it.key, node: <LiveChildReasoning text={it.text} /> });
    for (const it of liveText) rendered.push({ seq: -1, key: it.key, node: <LiveChildText text={it.text} /> });
  }
  return (
    <details className="tool subagent-card" open={open} onToggle={(e) => onToggle(e.currentTarget.open)}>
      <summary className="tool-row" title={result?.summary ?? tool.summary}>
        <span className={`dot ${state}`} />
        <span className="name">Agent</span>
        <span className="summary">
          {tool.summary}
          {agent?.subagent ? <span className="subagent-type"> · {agent.subagent}</span> : null}
        </span>
        {resultNote && <span className="result">{resultNote}</span>}
      </summary>
      {open && (
        <div className="tool-body">
          {rendered.length > 0 && (
            <div className="tool-section">
              <div className="tool-label">Steps</div>
              <div className="tool-steps">
                {rendered.map(({ seq, key, node }, i) => (
                  // The newest step is marked while the subagent runs and has no result yet.
                  <div className={`tool-step${!result && running && i === rendered.length - 1 ? " newest" : ""}`} key={key ?? seq}>
                    {node}
                  </div>
                ))}
              </div>
            </div>
          )}
          {agent && (
            <div className="tool-section">
              <div className="tool-label">Prompt</div>
              <pre className="tool-pre">{agent.subagent ? `subagent: ${agent.subagent}\n${agent.prompt}` : agent.prompt}</pre>
            </div>
          )}
          {hasOutput && (
            <div className="tool-section">
              <div className="tool-label">{result!.isError ? "Error" : "Output"}</div>
              <pre className="tool-pre">{payloadText(result!.payload)}</pre>
            </div>
          )}
        </div>
      )}
    </details>
  );
}

/** A subagent's reply still streaming, at the same steady pace as the top level's. */
function LiveChildText({ text }: { text: string }) {
  const shown = useSmoothText(text, true);
  return (
    <div className="tool-step-text">
      <Markdown text={shown} streaming />
    </div>
  );
}

/** A subagent's reasoning still streaming. */
function LiveChildReasoning({ text }: { text: string }) {
  const shown = useSmoothText(text, true);
  return <ReasoningBlock text={shown} opaque={false} live newest tokens={null} />;
}
