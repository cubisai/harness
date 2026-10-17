import { type ReactNode, useMemo } from "react";
import { prettyTool } from "../../../shared/tools";
import type { ExpertDef } from "../../../shared/experts";
import type { StoredEvent, ThreadEvent } from "../../../shared/types";
import { useSmoothText } from "../hooks/useSmoothText";
import { type LiveThread, visibleItems } from "../live";
import { Markdown } from "../markdown";
import { useStore } from "../store";
import { agentPromptOf, openRef, payloadText, ToolEventRow, useRunningTimer } from "./ThreadView";
import { ExpertAvatar, initials, memberAvatarId } from "./experts/ExpertAvatar";

type ToolEvent = Extract<ThreadEvent, { kind: "tool-use" }>;
type ResultEvent = Extract<ThreadEvent, { kind: "tool-result" }>;

/** Tool calls shown under a running subagent before the rest fold into "+N more". */
const PEEK_STEPS = 3;

/**
 * A subagent (the Agent tool), the way Claude Code shows one: a single line
 * that, while it runs, peeks at its last few tool calls and what it is thinking
 * or writing now, and when done reads "Done · N tool uses · 12s". Opening it
 * shows the whole transcript, with its prompt and report folded away.
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
  team: teamOverride,
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
  /** The thread's expert team; read from the store when omitted (tests pass it). */
  team?: ExpertDef;
}) {
  const active = !result && running;
  const state = result ? (result.isError ? "error" : "done") : running ? "pending" : "";
  const agent = agentPromptOf(tool.payload);
  const steps = children ?? [];
  // Count tool calls only: each step's result and the subagent's text are children too.
  const toolSteps = steps.filter((c): c is StoredEvent & { event: ToolEvent } => c.event.kind === "tool-use");
  const uses = `${toolSteps.length} tool ${toolSteps.length === 1 ? "use" : "uses"}`;
  const elapsed = useRunningTimer(startedAt, active);
  // Once finished, its last step's time stands in for when it ended.
  const lastAt = steps.at(-1)?.createdAt;
  const took = startedAt !== undefined && lastAt !== undefined && lastAt > startedAt ? Math.round((lastAt - startedAt) / 1000) : null;
  const status = result
    ? [result.isError ? "Failed" : "Done", toolSteps.length ? uses : "", took ? `${took}s` : ""]
    : active
      ? [toolSteps.length ? uses : "", elapsed !== null ? `${elapsed}s` : ""]
      : ["Stopped", toolSteps.length ? uses : ""];
  const report = typeof result?.payload === "string" ? handBack(result.payload) : null;

  // What the subagent is writing or thinking right now (live deltas tagged with this call), until it lands as a step.
  const fromStore = useStore((s) => (threadId && active ? s.live[threadId] : undefined));
  const live = active ? (liveOverride ?? fromStore) : undefined;
  const liveReasoning = live ? visibleItems(live, "reasoning", tool.toolUseId).filter((it) => !it.opaque) : [];
  const liveText = live ? visibleItems(live, "text", tool.toolUseId) : [];
  // The peek names files relative to the thread's folder, like Claude Code does.
  const root = useStore((s) => {
    if (!threadId || !active) return null;
    const thread = Object.values(s.threads).flat().find((t) => t.id === threadId);
    return thread?.worktreePath ?? s.projects.find((p) => p.id === thread?.projectId)?.path ?? null;
  });

  // On a team thread a member's row reads as the member: its portrait, name and profession.
  const expertId = useStore((s) => (threadId ? Object.values(s.threads).flat().find((t) => t.id === threadId)?.expertId : undefined));
  const teamFromStore = useStore((s) => (expertId ? s.experts?.find((e) => e.id === expertId && e.kind === "team") : undefined));
  const team = teamOverride ?? teamFromStore;
  const member = useMemo(() => {
    const cut = tool.summary.lastIndexOf(" · ");
    const id = cut >= 0 ? tool.summary.slice(cut + 3) : "";
    const m = team?.members?.find((x) => x.id === id);
    return team && m ? { teamId: team.id, ...m, task: tool.summary.slice(0, cut) } : null;
  }, [team, tool.summary]);

  return (
    <div className={`subagent-card ${state}`}>
      <details className="tool" open={open} onToggle={(e) => onToggle(e.currentTarget.open)}>
        <summary className="tool-row" title={member ? `${member.name} · ${member.profession} (${member.id}) — ${member.task}` : tool.summary}>
          <span className={`dot ${state}`} />
          {member ? (
            <>
              <ExpertAvatar id={memberAvatarId(member.teamId, member.id)} text={initials(member.name)} className="subagent-avatar" />
              <span className="name">{member.name}</span>
              <span className="summary">
                {member.task && member.task !== member.id ? `${member.task} · ` : ""}
                <span className="subagent-type">{member.profession || member.id}</span>
              </span>
            </>
          ) : (
            <>
              <span className="name">Agent</span>
              <span className="summary">
                {tool.summary}
                {/* Claude's summary already ends with the type ("Find the bug · Explore"). */}
                {agent?.subagent && !tool.summary.endsWith(agent.subagent) ? <span className="subagent-type"> · {agent.subagent}</span> : null}
              </span>
            </>
          )}
          <span className="result">{status.filter(Boolean).join(" · ")}</span>
        </summary>
        {open && (
          <div className="tool-body">
            <Transcript steps={steps} results={results} running={running} threadId={threadId} report={report} />
            {liveReasoning.map((it) => (
              <LiveThought key={it.key} text={it.text} />
            ))}
            {liveText.map((it) => (
              <LiveChildText key={it.key} text={it.text} />
            ))}
            {/* Codex reports some subagents without their prompt: no empty fold then. */}
            {agent?.prompt.trim() && (
              <details className="subagent-fold">
                <summary>Prompt</summary>
                <pre className="tool-pre">{agent.prompt}</pre>
              </details>
            )}
            {result?.payload !== undefined && (
              <details className="subagent-fold" open={result.isError}>
                <summary>{result.isError ? "Error" : "Report"}</summary>
                <pre className="tool-pre">{report ?? payloadText(result.payload)}</pre>
              </details>
            )}
          </div>
        )}
      </details>
      {!open && active && <Peek steps={toolSteps} results={results} root={root} now={lastLine(liveText.at(-1)?.text ?? liveReasoning.at(-1)?.text ?? latestNote(steps))} />}
    </div>
  );
}

/** The last few tool calls of a running subagent, one line each, and what it is doing now. */
function Peek({ steps, results, root, now }: { steps: (StoredEvent & { event: ToolEvent })[]; results?: Map<string, ResultEvent>; root: string | null; now: string }) {
  const shown = steps.slice(-PEEK_STEPS);
  const hidden = steps.length - shown.length;
  if (!shown.length && !now) return null;
  return (
    <div className="subagent-peek">
      {hidden > 0 && <div className="peek-more">+{hidden} more tool {hidden === 1 ? "use" : "uses"}</div>}
      {shown.map(({ seq, event }) => {
        const r = results?.get(event.toolUseId);
        return (
          <div className="peek-step" key={seq}>
            <span className={`dot ${r ? (r.isError ? "error" : "done") : "pending"}`} />
            <span className="name">{prettyTool(event.name)}</span>
            <span className="summary">{root ? relative(event.summary, root) : event.summary}</span>
          </div>
        );
      })}
      {now && <div className="peek-now">{now}</div>}
    </div>
  );
}

/** Every step of an opened subagent: tool rows, its thinking and its notes, in order. */
function Transcript({ steps, results, running, threadId, report }: { steps: StoredEvent[]; results?: Map<string, ResultEvent>; running: boolean; threadId?: string; report: string | null }) {
  const rows: ReactNode[] = [];
  for (const child of steps) {
    const ce = child.event;
    if (ce.kind === "tool-use") {
      rows.push(<ToolEventRow key={child.seq} tool={ce} result={results?.get(ce.toolUseId)} results={results} running={running} threadId={threadId} startedAt={child.createdAt} />);
    } else if (ce.kind === "thinking" && ce.text.trim()) {
      rows.push(
        <div className="subagent-thought" key={child.seq}>
          {plain(ce.text)}
        </div>,
      );
    } else if (ce.kind === "assistant-text" && ce.text.trim() && ce.text.trim() !== report?.trim()) {
      // The closing text is usually the report itself: the Report fold already has it.
      rows.push(
        <div className="tool-step-text" key={child.seq}>
          <Markdown text={ce.text} onFile={openRef} />
        </div>,
      );
    }
  }
  if (!rows.length) return null;
  return (
    <div className="tool-section">
      <div className="tool-label">Steps</div>
      <div className="tool-steps">{rows}</div>
    </div>
  );
}

/** A subagent's thinking still streaming, as a muted note. */
function LiveThought({ text }: { text: string }) {
  const shown = useSmoothText(text, true);
  return <div className="subagent-thought">{plain(shown)}</div>;
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

/** The newest stored note (thinking or text) when it came after the last tool call, else "". */
function latestNote(steps: StoredEvent[]): string {
  for (let i = steps.length - 1; i >= 0; i--) {
    const e = steps[i]!.event;
    if (e.kind === "tool-use" || e.kind === "tool-result") return "";
    if ((e.kind === "thinking" || e.kind === "assistant-text") && e.text.trim()) return e.text;
  }
  return "";
}

/** `text` with the folder `root` (and its separator) removed wherever it appears, "/" or "\\" style. */
export function relative(text: string, root: string): string {
  const r = root.replace(/[\\/]+$/, "");
  return text.split(`${r}/`).join("").split(`${r}\\`).join("").split(`${r.replace(/\//g, "\\")}\\`).join("");
}

/** The last non-empty line of `text`, without markdown emphasis. */
function lastLine(text: string): string {
  const lines = plain(text).split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.at(-1) ?? "";
}

/** Text with markdown bold/italic markers removed (thinking summaries arrive as "**Listing files**"). */
function plain(text: string): string {
  return text.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/__([^_]+)__/g, "$1");
}

/**
 * The subagent's own report: Claude Code wraps it in a "[Subagent hand-back]"
 * notice for the model and indents every line; the user only needs the report.
 */
export function handBack(payload: string): string {
  if (!payload.startsWith("[Subagent hand-back]")) return payload;
  const at = payload.indexOf("The report follows:");
  if (at < 0) return payload;
  const body = payload.slice(at + "The report follows:".length).replace(/^\n/, "");
  return body
    .split("\n")
    .map((l) => l.replace(/^ {2}/, ""))
    .join("\n")
    .trim();
}
