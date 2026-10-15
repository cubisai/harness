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
 * An expert that was summoned from the + menu: count it, close the menu and
 * start the thread. Split out so the row's click and Enter share one path.
 */
export function chooseExpert(id: string, close: () => void): void {
  bumpUsage(id);
  close();
  void useStore.getState().summonExpert(id);
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
            onClick={() => chooseExpert(e.id, close)}
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
