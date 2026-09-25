import { useEffect } from "react";
import type { AgentInfo, PermissionMode } from "../../shared/types";
import { CommandPalette } from "./components/CommandPalette";
import { Library } from "./components/Library";
import { Composer } from "./components/Composer";
import { Inspector } from "./components/Inspector";
import { SettingsSheet } from "./components/SettingsSheet";
import { Sidebar } from "./components/Sidebar";
import { ThreadView } from "./components/ThreadView";
import { IconDiff, IconFolder, IconGlobe, IconSparkle, IconTerminal } from "./icons";
import { useSelectedThread, useStore } from "./store";

const MODES: { id: PermissionMode; label: string; title: string }[] = [
  { id: "ask", label: "Ask", title: "Ask before edits and commands" },
  { id: "auto-edit", label: "Auto-edit", title: "Edit files freely, ask before commands" },
  { id: "full", label: "Full", title: "Run everything without asking" },
];

export function App() {
  const projects = useStore((s) => s.projects);
  const selectedProjectId = useStore((s) => s.selectedProjectId);
  const inspectorOpen = useStore((s) => s.inspectorOpen);
  const inspectorTab = useStore((s) => s.inspectorTab);
  const agents = useStore((s) => s.agents);
  const thread = useSelectedThread();
  const running = useStore((s) => (thread ? Boolean(s.running[thread.id]) : false));
  const { init, newThread, showInspector, updateThread, interrupt, addProject } = useStore.getState();
  const project = projects.find((p) => p.id === selectedProjectId) ?? null;

  useEffect(() => {
    void init();
  }, [init]);

  // ⌘K: command palette. ⌘N / Ctrl+N: new thread. ⌘⇧D: changes. Esc: stop the running turn.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        const s = useStore.getState();
        s.setPaletteOpen(!s.paletteOpen);
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "l") {
        e.preventDefault();
        const s = useStore.getState();
        useStore.setState({ libraryTab: s.libraryTab ? null : "skills" });
      } else if (mod && e.key === ",") {
        e.preventDefault();
        useStore.getState().setSettingsOpen(true);
      } else if (mod && e.key.toLowerCase() === "n") {
        e.preventDefault();
        void newThread();
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "d") {
        e.preventDefault();
        showInspector("changes");
      } else if (e.ctrlKey && e.key === "`") {
        e.preventDefault();
        showInspector("terminal");
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        showInspector("browser");
      } else if (e.key === "Escape" && running && !document.querySelector(".skill-menu, .palette, .sheet, .library")) {
        void interrupt();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newThread, showInspector, interrupt, running]);

  // The browser works without a project; Changes needs one.
  const inspectorVisible = inspectorOpen && (project || inspectorTab !== "changes");

  return (
    <div className={`app${inspectorVisible ? " with-inspector" : ""}`}>
      <Sidebar />
      <main className="main">
        <header className="main-header drag">
          <div className="main-title">
            {thread ? thread.title : project ? project.name : "UnSkilled"}
            {thread && project && <span className="sub">{project.name}</span>}
          </div>
          {thread && <LimitMeter agent={thread.agent} />}
          {thread && <UsageMeter threadId={thread.id} />}
          {thread && (
            <>
              {agents.length > 1 && (
                <select
                  className="select"
                  value={thread.agent}
                  title="Agent"
                  disabled={running}
                  onChange={(e) => void updateThread({ agent: e.target.value })}
                >
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label}
                    </option>
                  ))}
                </select>
              )}
              <select
                className="select"
                value={thread.model}
                title="Model"
                disabled={running}
                onChange={(e) => void updateThread({ model: e.target.value })}
              >
                {modelOptions(agents, thread.agent, thread.model).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
              <div className="segmented" role="radiogroup" aria-label="Permissions">
                {MODES.map((m) => (
                  <button
                    key={m.id}
                    role="radio"
                    aria-checked={thread.permissionMode === m.id}
                    className={thread.permissionMode === m.id ? "on" : ""}
                    title={m.title}
                    disabled={running}
                    onClick={() => void updateThread({ permissionMode: m.id })}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </>
          )}
          {project && (
            <>
              <button
                className={`icon-button${inspectorOpen && inspectorTab === "changes" ? " active" : ""}`}
                title="Changes (⌘⇧D)"
                onClick={() => showInspector("changes")}
              >
                <IconDiff />
              </button>
              <button
                className={`icon-button${inspectorOpen && inspectorTab === "browser" ? " active" : ""}`}
                title="Browser (⌘⇧B)"
                onClick={() => showInspector("browser")}
              >
                <IconGlobe />
              </button>
              <button
                className={`icon-button${inspectorOpen && inspectorTab === "terminal" ? " active" : ""}`}
                title="Terminal (⌃`)"
                onClick={() => showInspector("terminal")}
              >
                <IconTerminal />
              </button>
            </>
          )}
        </header>

        {!project ? (
          <div className="empty">
            <div>
              <h1>Welcome to UnSkilled</h1>
              <p>Open a project folder to start. Claude works inside it, with the skilled workflow built in.</p>
              <button className="button primary" onClick={() => void addProject()}>
                <IconFolder /> Open Project…
              </button>
            </div>
          </div>
        ) : !thread ? (
          <div className="empty">
            <div>
              <h1>{project.name}</h1>
              <p>Start a thread to work in this project.</p>
              <button className="button primary" onClick={() => void newThread()}>
                <IconSparkle /> New Thread
              </button>
              <div className="hints">
                <Hint skill="skilled-setup" d="Set up the project docs and tracker, once per repo." />
                <Hint skill="domain-interview" d="Get interviewed on an idea before any code." />
                <Hint skill="implement" d="Build a ticket or a small change, test-first." />
              </div>
            </div>
          </div>
        ) : (
          <>
            <ThreadView threadId={thread.id} />
            <Composer threadId={thread.id} />
          </>
        )}
      </main>
      {inspectorVisible && <Inspector projectId={project?.id ?? null} />}
      <SettingsSheet />
      <Notice />
      <Library />
      <CommandPalette />
    </div>
  );
}

/** The thread's agent's models, keeping the current one listed even if the agent no longer reports it. */
function modelOptions(agents: AgentInfo[], agent: string, current: string): { id: string; label: string }[] {
  const list = agents.find((a) => a.id === agent)?.models ?? [];
  return list.some((m) => m.id === current) ? list : [{ id: current, label: current }, ...list];
}

/** What this thread has cost so far, summed over its turns. Quiet until there's something to show. */
function UsageMeter({ threadId }: { threadId: string }) {
  const events = useStore((s) => s.events[threadId]);
  let input = 0;
  let output = 0;
  let cost = 0;
  let turns = 0;
  for (const e of events ?? []) {
    if (e.event.kind !== "turn-end") continue;
    turns++;
    input += e.event.inputTokens;
    output += e.event.outputTokens;
    cost += e.event.costUsd ?? 0;
  }
  if (!turns) return null;
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n));
  return (
    <span className="usage" title={`${turns} turn${turns === 1 ? "" : "s"} · ${input.toLocaleString()} input and ${output.toLocaleString()} output tokens`}>
      {k(input + output)} tokens{cost > 0 ? ` · $${cost.toFixed(2)}` : ""}
    </span>
  );
}

/**
 * How close the thread's agent is to its plan's rate limits: the fullest
 * window, as the agent last reported it. Hidden until the agent reports
 * any (API-key logins never do), and quiet below half.
 */
function LimitMeter({ agent }: { agent: string }) {
  const limits = useStore((s) => s.limits[agent]);
  if (!limits) return null;
  const known = limits.windows.filter((w) => w.usedPercent !== null);
  const top = known.reduce<(typeof known)[number] | null>((a, w) => (!a || w.usedPercent! > a.usedPercent! ? w : a), null);
  if (!top && limits.state === "ok") return null;
  const pct = top?.usedPercent ?? 0;
  if (limits.state === "ok" && pct < 50) return null;
  const when = (ms: number | null) =>
    ms ? new Date(ms).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }) : "unknown";
  const title = [
    ...limits.windows.map((w) => `${w.label} limit: ${w.usedPercent === null ? "in use" : `${w.usedPercent}% used`}, resets ${when(w.resetsAt)}`),
    `As of ${new Date(limits.updatedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`,
  ].join("\n");
  const text =
    limits.state === "limited"
      ? `Limit reached${top?.resetsAt ? ` · resets ${when(top.resetsAt)}` : ""}`
      : `${top!.label} limit ${pct}%`;
  return (
    <span className={`limit-meter ${limits.state}`} title={title}>
      <span className="bar">
        <i style={{ width: `${limits.state === "limited" ? 100 : pct}%` }} />
      </span>
      {text}
    </span>
  );
}

function Notice() {
  const text = useStore((s) => s.notice);
  return text ? (
    <div className="notice" role="status">
      {text}
    </div>
  ) : null;
}

function Hint({ skill, d }: { skill: string; d: string }) {
  return (
    <button className="hint-card" onClick={() => void useStore.getState().newThread(skill)}>
      <div className="t">/{skill}</div>
      <div className="d">{d}</div>
    </button>
  );
}
