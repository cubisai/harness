import { useEffect, useState } from "react";
import type { AgentInfo, StoredEvent, SwitchMode } from "../../../shared/types";
import { bindingKey } from "../../../shared/bindings";
import { useStore } from "../store";

/** How much of the thread's history the dialog says carries over. */
export function switchCounts(events: StoredEvent[]): { messages: number; commands: number } {
  let messages = 0;
  let commands = 0;
  for (const { event } of events) {
    if (event.kind === "user" || event.kind === "assistant-text") messages++;
    else if (event.kind === "tool-use") commands++;
  }
  return { messages, commands };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What a switch keeps and what it leaves behind, before the user picks a mode. */
export function SwitchDialog(props: {
  from: AgentInfo;
  to: AgentInfo;
  counts: { messages: number; commands: number };
  canGoBack: boolean;
  busy: boolean;
  error: string | null;
  onHandoff(): void;
  onFresh(): void;
  onBack(): void;
  onCancel(): void;
}) {
  const { from, to, counts, canGoBack, busy, error, onHandoff, onFresh, onBack, onCancel } = props;
  const canHandoff = to.capabilities.seeding !== "none";
  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="sheet switch-sheet" role="dialog" aria-modal="true" aria-label={`Switch to ${to.label}`}>
        <div className="sheet-head">
          <h2>Switch to {to.label}</h2>
        </div>
        <p className="note">{from.label} keeps its session in this thread, so you can come back to it.</p>

        <section>
          <h3>Carries over</h3>
          <ul className="switch-list">
            <li>{plural(counts.messages, "message", "messages")} and the decisions in them</li>
            <li>Changed files and the workspace state (a git checkpoint)</li>
            <li>{plural(counts.commands, "command result", "command results")}, as recorded — nothing is run again</li>
          </ul>
        </section>

        <section>
          <h3>Does not carry over</h3>
          <ul className="switch-list muted">
            <li>Reasoning — {to.label} can't read {from.label}'s</li>
            <li>The prompt cache — the first reply rebuilds it</li>
            <li>Approvals — always-allow rules stay with {from.label}</li>
            <li>Folder trust — permissions go back to your default</li>
          </ul>
        </section>

        {error !== null && <p className="switch-error">{error}</p>}

        <div className="switch-actions">
          {canGoBack && (
            <button className="button ghost" disabled={busy} onClick={onBack}>
              Switch back to {to.label}
            </button>
          )}
          <span className="spacer" />
          <button className="button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button className="button" disabled={busy} onClick={onFresh}>
            Start fresh
          </button>
          <button
            className="button primary"
            disabled={busy || !canHandoff}
            title={canHandoff ? `Send ${to.label} a summary of this thread` : `${to.label} has no way to receive a handoff here.`}
            onClick={onHandoff}
          >
            Hand off
          </button>
        </div>
      </div>
    </div>
  );
}

/** The connected switch dialog: open while `pendingSwitch` names an agent. */
export function SwitchDialogHost() {
  const pendingSwitch = useStore((s) => s.pendingSwitch);
  const selectedThreadId = useStore((s) => s.selectedThreadId);
  const threads = useStore((s) => s.threads);
  const events = useStore((s) => s.events);
  const agents = useStore((s) => s.agents);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setBusy(false);
    setError(null);
  }, [pendingSwitch]);

  useEffect(() => {
    if (pendingSwitch === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") useStore.getState().openSwitch(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pendingSwitch]);

  if (pendingSwitch === null) return null;
  const thread = Object.values(threads)
    .flat()
    .find((t) => t.id === selectedThreadId);
  if (!thread) return null;
  const from = agents.find((a) => a.id === thread.agent);
  const to = agents.find((a) => a.id === pendingSwitch);
  if (!from || !to) return null;

  const run = async (mode: SwitchMode) => {
    setBusy(true);
    const err = await useStore.getState().switchAgent(to.id, mode);
    setBusy(false);
    if (err === null) useStore.getState().openSwitch(null);
    else setError(err);
  };

  return (
    <SwitchDialog
      from={from}
      to={to}
      counts={switchCounts(events[thread.id] ?? [])}
      canGoBack={Boolean(thread.bindings?.[bindingKey(to.id)]?.resumeCursor)}
      busy={busy}
      error={error}
      onHandoff={() => void run("handoff")}
      onFresh={() => void run("fresh")}
      onBack={() => void run("back")}
      onCancel={() => useStore.getState().openSwitch(null)}
    />
  );
}
