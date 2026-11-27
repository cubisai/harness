import { useEffect, useRef } from "react";
import type { AgentInfo } from "../../../shared/types";
import { IconBell } from "../icons";
import { automationText, formatDuration, inboxRows, type InboxRow } from "../inbox";
import { useStore } from "../store";

function useInbox() {
  const permissions = useStore((s) => s.permissions);
  const questions = useStore((s) => s.questions);
  const plans = useStore((s) => s.plans);
  const finished = useStore((s) => s.finished);
  const automations = useStore((s) => s.automationNotices);
  const threads = useStore((s) => s.threads);
  const selectedThreadId = useStore((s) => s.selectedThreadId);
  return inboxRows({ permissions, questions, plans, finished, automations, threads, selectedThreadId });
}

/** The sidebar-footer bell; its badge counts what's waiting. */
export function InboxBell() {
  const rows = useInbox();
  const count = rows.needsYou.length + rows.finished.length;
  const setOpen = useStore((s) => s.setInboxOpen);
  return (
    <button
      className={`icon-button inbox-bell${rows.needsYou.length ? " urgent" : ""}`}
      title={count ? `Message Center: ${count} ${count === 1 ? "item" : "items"}` : "Message Center"}
      aria-label={count ? `Message Center, ${count} ${count === 1 ? "item" : "items"}` : "Message Center"}
      onClick={() => setOpen(true)}
    >
      <IconBell />
      {count > 0 && <span className="badge">{count}</span>}
    </button>
  );
}

/** Permissions waiting on other threads and turns that finished out of sight, as a sheet over the window. */
export function MessageCenter() {
  const open = useStore((s) => s.inboxOpen);
  const setOpen = useStore((s) => s.setInboxOpen);
  const agents = useStore((s) => s.agents);
  const rows = useInbox();
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    panel.current?.focus();
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, setOpen]);

  if (!open) return null;
  const openRow = async (row: InboxRow) => {
    const s = useStore.getState();
    // A run that never delivered into a thread has nothing to open.
    if (row.kind === "automation" && row.threadId === null) {
      setOpen(false);
      return;
    }
    setOpen(false);
    if (row.thread) await s.selectProject(row.thread.projectId);
    if ("requestId" in row) useStore.setState({ inboxTarget: { threadId: row.threadId, requestId: row.requestId, kind: row.kind } });
    await s.selectThread(row.threadId);
    if ("requestId" in row) {
      const state = useStore.getState();
      const requests = row.kind === "permission" ? state.permissions : row.kind === "plan" ? state.plans : state.questions;
      if (!requests.some((r) => r.threadId === row.threadId && r.requestId === row.requestId)) state.showNotice("That request has already been resolved.");
    }
  };
  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="sheet message-center" role="dialog" aria-modal="true" aria-label="Message Center" tabIndex={-1} ref={panel}>
        <MessageCenterView needsYou={rows.needsYou} finished={rows.finished} agents={agents} onOpen={openRow} onClose={() => setOpen(false)} />
      </div>
    </div>
  );
}

export function MessageCenterView({
  needsYou,
  finished,
  agents,
  onOpen,
  onClose,
}: {
  needsYou: InboxRow[];
  finished: InboxRow[];
  agents: AgentInfo[];
  onOpen(row: InboxRow): void;
  onClose(): void;
}) {
  const agentLabel = (row: InboxRow) => (row.thread ? (agents.find((a) => a.id === row.thread!.agent)?.label ?? row.thread.agent) : "");
  const item = (row: InboxRow) => (
    <li key={"requestId" in row ? `${row.kind}:${row.threadId}:${row.requestId}` : row.kind === "automation" ? `${row.notice.automationId}:${row.notice.runId}` : row.threadId}>
      <button className="inbox-row" onClick={() => onOpen(row)}>
        <span className="inbox-title">{row.thread?.title ?? (row.kind === "automation" ? row.notice.name : "A thread")}</span>
        <span className="inbox-meta">
          {row.kind === "automation" ? (
            <>Automation · {automationText(row.notice)}</>
          ) : (
            <>
              {row.kind === "finished" && row.automation ? "Automation · " : ""}
              {agentLabel(row)}
              {row.kind === "finished" ? <> · finished in {formatDuration(row.durationMs)}</> : <> · {row.kind === "permission" ? "wants to run" : row.kind === "question" ? "asks" : "plan approval:"} {row.summary}</>}
            </>
          )}
        </span>
      </button>
    </li>
  );
  return (
    <>
      <div className="sheet-head">
        <h2>Message Center</h2>
        <button className="button ghost" onClick={onClose}>
          Done
        </button>
      </div>
      {needsYou.length === 0 && finished.length === 0 && <p className="note">Nothing waiting. Permissions on other threads and turns that finish while you're elsewhere show up here.</p>}
      {needsYou.length > 0 && (
        <section>
          <h3>Needs you</h3>
          <ul className="inbox-list">{needsYou.map(item)}</ul>
        </section>
      )}
      {finished.length > 0 && (
        <section>
          <h3>Finished</h3>
          <ul className="inbox-list">{finished.map(item)}</ul>
        </section>
      )}
    </>
  );
}
