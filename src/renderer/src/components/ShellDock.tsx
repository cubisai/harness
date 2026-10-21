import { useEffect, useMemo, useRef, useState } from "react";
import type { BackgroundShell } from "../../../shared/types";
import { api } from "../api";
import { IconClose, IconStop, IconTerminal } from "../icons";
import { useStore } from "../store";

/** "42s", "3m 05s", "1h 02m": how long a shell has run (or ran). */
export function uptime(shell: Pick<BackgroundShell, "startedAt" | "endedAt">, now: number): string {
  const s = Math.max(0, Math.floor(((shell.endedAt ?? now) - shell.startedAt) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** The status word a chip shows. */
export function shellState(shell: Pick<BackgroundShell, "status" | "exitCode">): string {
  if (shell.status === "running") return "running";
  if (shell.status === "stopped") return "stopped";
  return shell.exitCode === null ? "exited" : `exited ${shell.exitCode}`;
}

/** The output panel of one shell: read-only, polled while it runs. */
function ShellOutput({ shell }: { shell: BackgroundShell }) {
  const [text, setText] = useState("");
  const next = useRef<number | undefined>(undefined);
  const box = useRef<HTMLPreElement>(null);

  useEffect(() => {
    next.current = undefined;
    setText("");
    let stopped = false;
    const read = async () => {
      const out = await api().shellOutput(shell.id, next.current);
      if (stopped || !out) return;
      next.current = out.next;
      if (out.text) setText((t) => ((out.dropped ? "" : t) + out.text).slice(-200_000));
    };
    void read();
    const timer = shell.status === "running" ? setInterval(() => void read(), 1000) : null;
    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
    };
  }, [shell.id, shell.status]);

  // Follow the tail unless the user scrolled up to read.
  useEffect(() => {
    const el = box.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 40) el.scrollTop = el.scrollHeight;
  }, [text]);

  return (
    <pre ref={box} className="shell-output" aria-label={`Output of ${shell.name}`}>
      {text || "(no output yet)"}
    </pre>
  );
}

/** Shells hidden with the dock's ×, per thread, for this window session; a shell started later shows again. */
const hiddenByThread = new Map<string, Set<string>>();

/**
 * The thread's background shells, docked above the message box: one chip per
 * shell (name, state, uptime); a chip opens its live output with Stop.
 */
export function ShellDock({ threadId }: { threadId: string }) {
  const all = useStore((s) => s.shells);
  const [hidden, setHidden] = useState<Set<string>>(() => hiddenByThread.get(threadId) ?? new Set());
  const shells = useMemo(
    () => Object.values(all).filter((s) => s.threadId === threadId && !hidden.has(s.id)).sort((a, b) => b.startedAt - a.startedAt),
    [all, threadId, hidden],
  );
  const [open, setOpen] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const running = shells.filter((s) => s.status === "running").length;

  // Shells started before this window loaded (or before a reload) come from main once.
  useEffect(() => {
    void api()
      .listShells(threadId)
      .then((list) => useStore.setState((s) => ({ shells: { ...s.shells, ...Object.fromEntries(list.map((x) => [x.id, x])) } })));
    setOpen(null);
    setHidden(hiddenByThread.get(threadId) ?? new Set());
  }, [threadId]);

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  if (!shells.length) return null;
  const selected = shells.find((s) => s.id === open) ?? null;
  // Hides what's listed now; running shells keep running, and a new one brings the dock back.
  const close = () => {
    const next = new Set([...hidden, ...shells.map((s) => s.id)]);
    hiddenByThread.set(threadId, next);
    setHidden(next);
    setOpen(null);
  };
  return (
    <div className="shell-dock">
      <section className="shell-card" aria-label="Background shells">
        <div className="shell-head">
          <span className="shell-icon" aria-hidden>
            <IconTerminal />
          </span>
          <span className="shell-count">{running ? `${running} running` : "Background shells"}</span>
          <div className="shell-chips" role="tablist" aria-label="Shells">
            {shells.map((s) => (
              <button
                key={s.id}
                type="button"
                role="tab"
                aria-selected={s.id === open}
                className={`shell-chip ${s.status}${s.id === open ? " on" : ""}`}
                title={s.command}
                onClick={() => setOpen(s.id === open ? null : s.id)}
              >
                <span className="shell-dot" aria-hidden />
                <span className="shell-name">{s.name}</span>
                <span className="shell-meta">{`${shellState(s)} · ${uptime(s, now)}`}</span>
              </button>
            ))}
          </div>
          <button
            type="button"
            className="icon-button shell-close"
            aria-label="Hide background shells"
            title={running ? "Hide (the shells keep running; Stop ends one)" : "Hide"}
            onClick={close}
          >
            <IconClose />
          </button>
        </div>
        {selected && (
          <div className="shell-body">
            <div className="shell-bar">
              <code className="shell-command">{selected.command}</code>
              {selected.status === "running" && (
                <button type="button" className="button shell-stop" onClick={() => void api().stopShell(selected.id)}>
                  <IconStop />
                  Stop
                </button>
              )}
            </div>
            <ShellOutput shell={selected} />
          </div>
        )}
      </section>
    </div>
  );
}
