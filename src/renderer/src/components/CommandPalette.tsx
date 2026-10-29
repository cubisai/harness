import { useEffect, useMemo, useRef, useState } from "react";
import type { PermissionMode, Theme } from "../../../shared/types";
import { api } from "../api";
import { newThreadCommands, rankCommands, type Command } from "../palette";
import { fileManagerName } from "./OpenIn";
import { useSelectedThread, useStore } from "../store";

const MODES: { id: PermissionMode; label: string }[] = [
  { id: "ask", label: "Ask" },
  { id: "auto-edit", label: "Auto-edit" },
  { id: "plan", label: "Plan" },
  { id: "full", label: "Full" },
];
const THEMES: { id: Theme; label: string }[] = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

/** ⌘K / Ctrl+K: every action, skill, thread, and project, one search away. */
export function CommandPalette() {
  const open = useStore((s) => s.paletteOpen);
  if (!open) return null;
  return <Palette />;
}

function Palette() {
  const projects = useStore((s) => s.projects);
  const threads = useStore((s) => s.threads);
  const skills = useStore((s) => s.skills);
  const agents = useStore((s) => s.agents);
  const settings = useStore((s) => s.settings);
  const editors = useStore((s) => s.editors);
  const selectedProjectId = useStore((s) => s.selectedProjectId);
  const inspectorOpen = useStore((s) => s.inspectorOpen);
  const thread = useSelectedThread();
  const running = useStore((s) => (thread ? Boolean(s.running[thread.id]) : false));
  const runningThreads = useStore((s) => s.running);
  const [query, setQuery] = useState(() => useStore.getState().paletteQuery);
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const close = () => useStore.getState().setPaletteOpen(false);

  const commands = useMemo(() => {
    const s = useStore.getState();
    const mac = api().platform === "darwin";
    const key = (k: string) => (mac ? `⌘${k}` : `Ctrl+${k}`);
    const out: Command[] = [];
    const action = (id: string, title: string, run: () => void, extra: Partial<Command> = {}) =>
      out.push({ id: `action:${id}`, section: "Actions", title, run, ...extra });

    out.push(...newThreadCommands({ enabled: Boolean(selectedProjectId), shortcut: key("N"), newThread: (skills, o) => void s.newThread(skills, o) }));
    action("add-project", "Add Project…", () => void s.addProject(), { keywords: "open folder" });
    action("library-skills", "Library: Skills", () => useStore.setState({ libraryTab: "skills" }), { shortcut: mac ? "⌘⇧L" : "Ctrl+Shift+L", keywords: "plugins browse skills" });
    action("library-mcp", "Library: MCP Servers", () => useStore.setState({ libraryTab: "mcp" }), { keywords: "mcp tools add server" });
    action("library-agents", "Library: Agents", () => useStore.setState({ libraryTab: "agents" }), { keywords: "install antigravity agy opencode codex" });
    action("settings", "Settings…", () => s.setSettingsOpen(true), { shortcut: key(","), keywords: "preferences api keys" });
    if (thread) action("export-thread", "Export Thread…", () => void s.exportThread(), { keywords: "save json backup" });
    if (selectedProjectId) action("import-thread", "Import Thread…", () => void s.importThread(), { keywords: "open json restore" });
    if (selectedProjectId) action("changes", "Show Changes", () => s.showInspector("changes"), { shortcut: mac ? "⌘⇧D" : "Ctrl+Shift+D", keywords: "diff git" });
    if (selectedProjectId) action("files", "Show Files", () => s.showInspector("files"), { keywords: "tree explorer open file" });
    action("browser", "Show Browser", () => s.showInspector("browser"), { shortcut: mac ? "⌘⇧B" : "Ctrl+Shift+B", keywords: "web page preview" });
    action("terminal", "Toggle Terminal", () => s.toggleTerminal(), { shortcut: "⌃`", keywords: "shell console" });
    action("doctor", "Run Doctor", () => s.openDoctor(), { keywords: "check install version conflict agents codex claude opencode fix" });
    if (selectedProjectId) {
      const preferred = settings?.editor ?? null;
      const ordered = [...editors].sort((a, b) => Number(b.id === preferred) - Number(a.id === preferred));
      for (const e of ordered) action(`open-in:${e.id}`, `Open Project in ${e.label}`, () => void s.openInEditor({}, e.id), { keywords: "editor ide" });
      const project = projects.find((p) => p.id === selectedProjectId);
      if (project) action("reveal-project", `Show Project in ${fileManagerName()}`, () => void api().revealPath(project.path), { keywords: "finder explorer folder reveal" });
    }
    if (inspectorOpen) action("hide-inspector", "Hide Side Panel", () => s.toggleInspector(), { keywords: "inspector close" });
    if (thread && running) action("stop", "Stop the Running Turn", () => void s.interrupt(), { shortcut: "Esc", keywords: "interrupt cancel" });
    if (Object.values(runningThreads).filter(Boolean).length > 1) action("stop-all", "Stop All Running Threads", () => void s.stopAllRunning(), { keywords: "interrupt cancel background" });
    if (thread && !running) {
      for (const m of MODES) {
        if (m.id !== thread.permissionMode) action(`mode:${m.id}`, `Permissions: ${m.label}`, () => void s.updateThread({ permissionMode: m.id }), { keywords: "mode" });
      }
      for (const a of agents) {
        if (a.id !== thread.agent) action(`agent:${a.id}`, `Switch Agent to ${a.label}`, () => s.openSwitch(a.id), { detail: "Hand off or start fresh" });
      }
      for (const m of agents.find((a) => a.id === thread.agent)?.models ?? []) {
        if (m.id !== thread.model) action(`model:${m.id}`, `Model: ${m.label}`, () => void s.updateThread({ model: m.id }));
      }
    }
    for (const t of THEMES) {
      if (settings && t.id !== settings.theme) {
        action(`theme:${t.id}`, `Theme: ${t.label}`, () => void api().updateSettings({ theme: t.id }).then((v) => useStore.setState({ settings: v })), { keywords: "appearance" });
      }
    }

    if (selectedProjectId) {
      for (const sk of skills) {
        out.push({
          id: `skill:${sk.name}`,
          section: "Skills",
          title: `$${sk.name}`,
          detail: sk.description,
          // The old "/name" trigger still finds the skill; the menu now uses "$".
          keywords: `/${sk.name}`,
          // Into this thread's message box, or a new thread when none is open.
          run: () => (thread ? s.addPendingSkills([sk.name]) : void s.newThread([sk.name])),
        });
      }
    }

    const byProject = new Map(projects.map((p) => [p.id, p.name]));
    const allThreads = Object.values(threads)
      .flat()
      .sort((a, b) => b.updatedAt - a.updatedAt);
    for (const t of allThreads) {
      if (t.id === thread?.id) continue;
      out.push({
        id: `thread:${t.id}`,
        section: "Threads",
        title: t.title,
        detail: byProject.get(t.projectId),
        run: () => {
          void s.selectProject(t.projectId).then(() => s.selectThread(t.id));
        },
      });
    }
    for (const p of projects) {
      if (p.id === selectedProjectId) continue;
      out.push({ id: `project:${p.id}`, section: "Projects", title: p.name, detail: p.path, run: () => void s.selectProject(p.id) });
    }
    return out;
  }, [projects, threads, skills, agents, settings, editors, selectedProjectId, inspectorOpen, thread, running, runningThreads]);

  const results = useMemo(() => rankCommands(commands, query), [commands, query]);
  useEffect(() => setIndex(0), [query]);
  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    list.current?.querySelector(".palette-item.active")?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const run = (c: Command | undefined) => {
    if (!c) return;
    close();
    c.run();
  };

  return (
    <div className="sheet-backdrop palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          ref={input}
          className="palette-input"
          placeholder="Search actions, skills, and threads (> for actions only)"
          spellCheck={false}
          value={query}
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={results[index] ? `palette-${results[index]!.id}` : undefined}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // Handled here, so the window's own shortcuts (Esc stops a turn) don't also fire.
            if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) setIndex((i) => Math.min(i + 1, results.length - 1));
            else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) setIndex((i) => Math.max(i - 1, 0));
            else if (e.key === "Enter") run(results[index]);
            else if (e.key === "Escape") close();
            else return;
            e.preventDefault();
            e.stopPropagation();
          }}
        />
        <div className="palette-list" id="palette-list" role="listbox" ref={list}>
          {results.length === 0 && <div className="palette-empty">No matches</div>}
          {results.map((c, i) => (
            <div key={c.id}>
              {(i === 0 || results[i - 1]!.section !== c.section) && <div className="palette-section">{c.section}</div>}
              <div
                id={`palette-${c.id}`}
                role="option"
                aria-selected={i === index}
                className={`palette-item${i === index ? " active" : ""}`}
                onMouseMove={() => i !== index && setIndex(i)}
                onMouseDown={(e) => {
                  e.preventDefault(); // keep focus in the input
                  run(c);
                }}
              >
                <span className={`t${c.section === "Skills" ? " mono" : ""}`}>{c.title}</span>
                {c.detail && <span className="d">{c.detail}</span>}
                {c.shortcut && <kbd>{c.shortcut}</kbd>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
