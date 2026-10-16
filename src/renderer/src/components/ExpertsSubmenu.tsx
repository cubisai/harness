import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import type { ExpertDef } from "../../../shared/experts";
import { useStore } from "../store";
import { ExpertAvatar } from "./experts/ExpertAvatar";
import { bumpUsage, readUsage } from "./experts/ExpertCenter";

/** The experts a query matches by name, profession or tag (case-insensitive). */
export function filterExperts(experts: ExpertDef[], query: string): ExpertDef[] {
  const q = query.trim().toLowerCase();
  if (!q) return experts;
  return experts.filter((e) => e.name.toLowerCase().includes(q) || e.profession.toLowerCase().includes(q) || e.tags.some((t) => t.toLowerCase().includes(q)));
}

/** Up to five experts, most summoned first; ties and unsummoned experts keep catalogue order. */
export function recentExperts(experts: ExpertDef[], usage: Record<string, number>): ExpertDef[] {
  return [...experts].sort((a, b) => (usage[b.id] ?? 0) - (usage[a.id] ?? 0)).slice(0, 5);
}

/**
 * Where an expert picked from the + menu should go: on the open thread when it
 * is empty and the right kind, on a new thread from the start, or on a confirm
 * step when the open thread already has messages.
 */
export function pickMode(input: { thread: { kind: string; expertId?: string } | null; messages: number; running: boolean; def: { id: string; threadKind?: "design" } }): "here" | "same" | "confirm" | "new" {
  const { thread, messages, running, def } = input;
  if (!thread) return "new";
  if (thread.expertId === def.id && messages === 0) return "same";
  const wanted = def.threadKind === "design" ? "design" : "chat";
  if (wanted !== thread.kind) return "new";
  if (messages === 0 && !running) return "here";
  return "confirm";
}

/**
 * An expert picked from the + menu: set it on the open thread when it is empty,
 * confirm a new thread when that one already has messages, or start the thread
 * as before. Split out so the row's click and Enter share one path.
 */
export function chooseExpert(id: string, close: () => void): "here" | "same" | "confirm" | "new" {
  const s = useStore.getState();
  const threadId = s.selectedThreadId;
  const thread = threadId ? Object.values(s.threads).flat().find((t) => t.id === threadId) : undefined;
  const messages = (threadId ? s.events[threadId]?.length : 0) ?? 0;
  const running = Boolean(threadId ? s.running[threadId] : false);
  const def: { id: string; threadKind?: "design" } = s.experts?.find((e) => e.id === id) ?? { id };
  const mode = pickMode({ thread: thread ? { kind: thread.kind ?? "chat", expertId: thread.expertId } : null, messages, running, def });
  if (mode === "confirm") return "confirm";
  if (mode === "same") {
    close();
    return "same";
  }
  bumpUsage(id);
  close();
  // The thread may have gained messages the store hasn't loaded yet: then the expert gets a new thread, as before.
  if (mode === "here" && threadId) void s.setThreadExpert(threadId, id).catch(() => s.summonExpert(id));
  else void s.summonExpert(id);
  return mode;
}

/** Close the + menu and open the Library on its Experts tab. */
export function browseAllExperts(close: () => void): void {
  close();
  useStore.setState({ libraryTab: "experts" });
}

/** The + menu's Experts flyout: a search box, recent experts, then Browse all experts. */
export function ExpertsSubmenu({ close }: { close: () => void }): ReactNode {
  const experts = useStore((s) => s.experts);
  const loadExperts = useStore((s) => s.loadExperts);
  const hasProject = useStore((s) => Boolean(s.selectedProjectId));
  const [query, setQuery] = useState("");
  // An expert picked on a thread that already has messages: confirm a new thread before starting it.
  const [confirming, setConfirming] = useState<ExpertDef | null>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (experts === null) void loadExperts();
  }, [experts, loadExperts]);

  const shown = useMemo(() => {
    const all = experts ?? [];
    return (query.trim() ? filterExperts(all, query) : recentExperts(all, readUsage())).slice(0, 8);
  }, [experts, query]);

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

  // The picked expert can't join a thread that already has messages: offer a new thread instead.
  if (confirming) {
    return (
      <div
        className="xs"
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          // Stay in the menu: Escape only steps back from the confirm to the list.
          e.stopPropagation();
          setConfirming(null);
        }}
      >
        <div className="xs-confirm">
          <ExpertAvatar id={confirming.id} text={confirming.avatarText} className="xs-avatar" />
          <p>Start a new thread with {confirming.name}?</p>
          <p>This thread already has messages. An expert joins a thread from its start.</p>
          <div className="xs-confirm-actions">
            <button
              className="button primary"
              autoFocus
              onClick={() => {
                bumpUsage(confirming.id);
                close();
                void useStore.getState().summonExpert(confirming.id);
              }}
            >
              Start new thread
            </button>
            <button className="button ghost" onClick={() => setConfirming(null)}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="xs" onKeyDown={onKey}>
      <input
        className="text-input xs-search"
        placeholder="Search experts"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        spellCheck={false}
        autoFocus
        aria-label="Search experts"
      />
      <div className="xs-list" ref={list} role="listbox" aria-label="Experts">
        {shown.map((e) => (
          <button
            key={e.id}
            className="xs-row"
            role="option"
            aria-selected={false}
            title={hasProject ? e.description : "Open a project first"}
            disabled={!hasProject}
            onClick={() => {
              if (chooseExpert(e.id, close) === "confirm") setConfirming(e);
            }}
          >
            <ExpertAvatar id={e.id} text={e.avatarText} className="xs-avatar" />
            <span className="xs-name">{e.name}</span>
            {e.kind === "team" && <span className="xs-tag">Team</span>}
          </button>
        ))}
        {!shown.length && <p className="xs-empty">No experts found</p>}
      </div>
      <div className="xs-divider" role="separator" />
      <button className="xs-browse" onClick={() => browseAllExperts(close)}>
        Browse all experts
        <ArrowUpRight size={14} strokeWidth={1.75} aria-hidden />
      </button>
    </div>
  );
}
