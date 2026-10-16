import { useMemo, useRef, useState } from "react";
import type { SkillEntry } from "../../../shared/types";
import { useStore } from "../store";

/**
 * The skills a query matches: user-invocable ones, design-only skills only in a
 * design thread, filtered on name or description, name-prefix matches first.
 */
export function filterSkills(skills: SkillEntry[], query: string, design: boolean): SkillEntry[] {
  const q = query.trim().toLowerCase();
  return skills
    .filter((s) => s.userInvocable !== false)
    .filter((s) => design || s.mode !== "design")
    .filter((s) => !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))
    .sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)));
}

/** The + menu's Skills flyout: a search box, then up to eight matching skills. */
export function SkillsSubmenu({ close }: { close: () => void }) {
  const skills = useStore((s) => s.skills);
  const design = useStore((s) => s.threadKind) === "design";
  const [query, setQuery] = useState("");
  const list = useRef<HTMLDivElement>(null);

  const shown = useMemo(() => filterSkills(skills, query, design).slice(0, 8), [skills, query, design]);

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
        placeholder="Search skills"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        spellCheck={false}
        autoFocus
        aria-label="Search skills"
      />
      <div className="xs-list" ref={list} role="listbox" aria-label="Skills">
        {shown.map((s) => (
          <button
            key={s.name}
            className="xs-row"
            role="option"
            aria-selected={false}
            title={s.description}
            onClick={() => {
              close();
              useStore.getState().addPendingSkills([s.name]);
            }}
          >
            <span className="xs-name">{s.name}</span>
            <span className="xs-skill-desc">{s.description}</span>
          </button>
        ))}
        {!shown.length && <p className="xs-empty">No skills found</p>}
      </div>
    </div>
  );
}
