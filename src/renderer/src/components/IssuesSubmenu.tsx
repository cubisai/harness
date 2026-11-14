import { ArrowUpRight, Check } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { IssueResult, IssueState, IssueSummary } from "../../../shared/types";
import { api } from "../api";
import { useSelectedThread, useStore } from "../store";

const GROUPS: { state: IssueState | null; label: string }[] = [
  { state: "ready-for-agent", label: "Ready for agent" },
  { state: "ready-for-human", label: "Ready for human" },
  { state: "needs-triage", label: "Needs triage" },
  { state: "needs-info", label: "Needs info" },
  { state: null, label: "Other" },
];

/** Up to `max` issues matching the query (number or title), grouped by state in the picker's order; empty groups go. */
export function groupIssues(issues: IssueSummary[], query: string, max = 8): { label: string; issues: IssueSummary[] }[] {
  const q = query.trim().toLowerCase().replace(/^#/, "");
  const hits = issues.filter((i) => !q || String(i.number).startsWith(q) || i.title.toLowerCase().includes(q));
  const groups = GROUPS.map((g) => ({ label: g.label, issues: hits.filter((i) => (i.state ?? null) === g.state) }));
  let left = max;
  return groups
    .map((g) => {
      const take = g.issues.slice(0, Math.max(0, left));
      left -= take.length;
      return { label: g.label, issues: take };
    })
    .filter((g) => g.issues.length);
}

/** A row's meta: the type, then the comment count when there are any (the title gets the room otherwise). */
export function issueMeta(i: IssueSummary): string {
  const comments = i.commentCount === 0 ? "" : i.commentCount === 1 ? "1 comment" : `${i.commentCount} comments`;
  return [i.type, comments].filter(Boolean).join(" · ");
}

/** The + menu's Issues flyout: a search box, then up to eight open issues grouped by state. Picking one sets the thread's issue. */
export function IssuesSubmenu({ close }: { close: () => void }) {
  const projectId = useStore((s) => s.selectedProjectId);
  const thread = useSelectedThread();
  const draftIssue = useStore((s) => (s.draft.issue?.projectId === s.selectedProjectId ? s.draft.issue.issue : null));
  const current = thread ? (thread.issue ?? null) : draftIssue;
  const [result, setResult] = useState<IssueResult<IssueSummary[]> | null>(null);
  const [query, setQuery] = useState("");
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!projectId) return;
    let live = true;
    api()
      .listIssues(projectId)
      .then((r) => live && setResult(r))
      .catch((err: unknown) => live && setResult({ ok: false, error: "failed", message: err instanceof Error ? err.message : String(err) }));
    return () => {
      live = false;
    };
  }, [projectId]);

  const groups = useMemo(() => (result?.ok ? groupIssues(result.value, query) : []), [result, query]);

  // Arrows move between the rows; Enter follows the focused row's button, or picks the top match from the search box.
  const onKey = (e: React.KeyboardEvent) => {
    const rows = [...(list.current?.querySelectorAll<HTMLButtonElement>(".xs-row:not(:disabled)") ?? [])];
    if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") {
      e.preventDefault();
      rows[0]?.click();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    if (!rows.length) return;
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    rows[(at + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length]?.focus();
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div className="xs issues-menu" onKeyDown={onKey}>
      <input
        className="text-input xs-search"
        placeholder="Search issues"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        spellCheck={false}
        autoFocus
        aria-label="Search issues"
      />
      <div className="xs-list" ref={list} role="listbox" aria-label="Issues">
        {!result && <p className="xs-empty">Loading issues…</p>}
        {result && !result.ok && <p className="xs-empty issues-error">{result.message}</p>}
        {result?.ok && !groups.length && <p className="xs-empty">{query.trim() ? "No issues match" : "No open issues"}</p>}
        {groups.map((g) => (
          <Fragment key={g.label}>
            {/* Without state labels everything is "Other": a lone header says nothing. */}
            {(groups.length > 1 || g.label !== "Other") && <div className="issues-group">{g.label}</div>}
            {g.issues.map((i) => {
              const picked = current?.number === i.number;
              return (
                <button
                  key={i.number}
                  className="xs-row"
                  role="option"
                  aria-selected={picked}
                  title={[`#${i.number} ${i.title}`, i.labels.join(", ")].filter(Boolean).join("\n")}
                  onClick={() => {
                    close();
                    // Picking the thread's issue again takes it off, as picking a skill twice does.
                    void useStore.getState().setIssue(picked ? null : i);
                  }}
                >
                  <span className="issues-num">#{i.number}</span>
                  <span className="xs-name">{i.title}</span>
                  {picked ? <Check size={13} className="skill-picked" aria-label="Picked" /> : issueMeta(i) && <span className="issues-meta">{issueMeta(i)}</span>}
                </button>
              );
            })}
          </Fragment>
        ))}
      </div>
      {/* No tracker yet, or one to switch: /issue-setup runs the setup skill in this thread. */}
      {result && (result.ok || result.error === "no-config") && (
        <>
          <div className="xs-divider" role="separator" />
          <button
            className="xs-browse"
            onClick={() => {
              close();
              void useStore.getState().runIssueCommand("issue-setup", "");
            }}
          >
            {result.ok ? "Change issue tracker" : "Set up issue tracker"}
            <ArrowUpRight size={14} strokeWidth={1.75} aria-hidden />
          </button>
        </>
      )}
    </div>
  );
}
