import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import type { SearchHit, SearchResults } from "../../../shared/types";
import { api } from "../api";
import "../styles/search.css";

/** The active filter chip: everything, the selected project, running threads, one agent, or files. */
export type SearchFilter =
  | { id: "all" }
  | { id: "project" }
  | { id: "running" }
  | { id: "files" }
  | { id: "agent"; agent: string };

/** The hits the dialog renders, already filtered: hits split by kind plus matching file paths. */
export interface SearchGroups {
  threads: SearchHit[];
  messages: SearchHit[];
  files: string[];
}

/** One navigable row. Files come last so the keyboard walks Threads → Messages → Files. */
export type SearchRow =
  | { kind: "thread"; hit: SearchHit }
  | { kind: "message"; hit: SearchHit }
  | { kind: "file"; path: string };

export interface SearchDialogProps {
  /** The selected project (enables "This project" and "Files"). */
  projectId: string | null;
  /** For the project name shown on hits. */
  projects: { id: string; name: string }[];
  /** One chip per agent. */
  agents: { id: string; label: string }[];
  /** For the "Running" chip. */
  runningThreadIds: string[];
  onOpenThread(threadId: string, seq: number | null): void;
  onOpenFile(path: string): void;
  /** Hand off to the command palette; the query starts with ">". */
  onActions(query: string): void;
  onClose(): void;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A compact, locale-independent age: now, 5m, 3h, 2d, then "Sep 4". */
export function relativeTime(ms: number, now: number): string {
  const diff = now - ms;
  if (diff < 60_000) return "now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d`;
  const d = new Date(ms);
  return `${MONTHS[d.getMonth()] ?? ""} ${d.getDate()}`;
}

/**
 * Splits a snippet on its \u0001 (start) / \u0002 (end) match markers. The
 * markers are plain text, never HTML. An unterminated start marks to the end of
 * the string; a stray end marker is dropped.
 */
export function snippetParts(snippet: string): { text: string; mark: boolean }[] {
  const parts: { text: string; mark: boolean }[] = [];
  let buf = "";
  let mark = false;
  const flush = () => {
    if (buf) parts.push({ text: buf, mark });
    buf = "";
  };
  for (const ch of snippet) {
    if (ch === "\u0001") {
      flush();
      mark = true;
    } else if (ch === "\u0002") {
      if (mark) {
        flush();
        mark = false;
      }
    } else {
      buf += ch;
    }
  }
  flush();
  return parts;
}

/** True when `needle` appears in `hay` in order (case is the caller's problem). */
function subsequence(hay: string, needle: string): boolean {
  let i = 0;
  for (const ch of hay) {
    if (ch === needle[i]) i += 1;
    if (i >= needle.length) return true;
  }
  return i >= needle.length;
}

/**
 * Ranks file paths against the query: a substring of the basename beats a
 * substring anywhere, which beats a subsequence of the whole path. Ties keep
 * the input order. Empty text matches nothing.
 */
export function rankFiles(files: string[], text: string, limit: number): string[] {
  const q = text.trim().toLowerCase();
  if (!q) return [];
  const scored: { path: string; score: number; i: number }[] = [];
  files.forEach((path, i) => {
    const lower = path.toLowerCase();
    const base = lower.slice(lower.lastIndexOf("/") + 1);
    let score = -1;
    if (base.includes(q)) score = 3;
    else if (lower.includes(q)) score = 2;
    else if (subsequence(lower, q)) score = 1;
    if (score < 0) return;
    scored.push({ path, score, i });
  });
  return scored
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, limit)
    .map((s) => s.path);
}

/** Grouped results as one ordered list for keyboard navigation. */
export function flattenRows(groups: SearchGroups): SearchRow[] {
  return [
    ...groups.threads.map((hit): SearchRow => ({ kind: "thread", hit })),
    ...groups.messages.map((hit): SearchRow => ({ kind: "message", hit })),
    ...groups.files.map((path): SearchRow => ({ kind: "file", path })),
  ];
}

/** A snippet with its matched spans wrapped in `<mark>`. Renders text, never HTML. */
export function SearchSnippet({ snippet }: { snippet: string }): JSX.Element {
  return (
    <>
      {snippetParts(snippet).map((part, i) =>
        part.mark ? (
          <mark key={i} className="search-mark">
            {part.text}
          </mark>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}

function sameFilter(a: SearchFilter, b: SearchFilter): boolean {
  if (a.id !== b.id) return false;
  if (a.id === "agent" && b.id === "agent") return a.agent === b.agent;
  return true;
}

/** ⌘K search over thread titles, messages and project files (DESIGN §7.2). */
export function SearchDialog({
  projectId,
  projects,
  agents,
  runningThreadIds,
  onOpenThread,
  onOpenFile,
  onActions,
  onClose,
}: SearchDialogProps): JSX.Element {
  const [text, setText] = useState("");
  const [filter, setFilter] = useState<SearchFilter>({ id: "all" });
  const [results, setResults] = useState<SearchResults | null>(null);
  const [files, setFiles] = useState<string[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const seqRef = useRef(0);
  const loadedFor = useRef<string | null>(null);

  const now = Date.now();

  useEffect(() => inputRef.current?.focus(), []);

  // The project's files load once per open / project, then are ranked in render.
  useEffect(() => {
    if (!projectId || loadedFor.current === projectId) return;
    loadedFor.current = projectId;
    void api()
      .listFiles(projectId)
      .then((r) => setFiles(r.files))
      .catch(() => {
        loadedFor.current = null;
      });
  }, [projectId]);

  // ">" hands the whole line to the command palette; the parent closes this.
  useEffect(() => {
    if (text.startsWith(">")) onActions(text);
  }, [text, onActions]);

  // Debounced full-text search. An empty query, the Files filter and ">" mode
  // clear the results instead of searching.
  useEffect(() => {
    if (text.startsWith(">") || filter.id === "files") {
      seqRef.current += 1;
      setResults(null);
      return;
    }
    const q = text.trim();
    if (!q) {
      seqRef.current += 1;
      setResults(null);
      return;
    }
    const seq = ++seqRef.current;
    const handle = setTimeout(() => {
      void api()
        .search({
          text: q,
          projectId: filter.id === "project" ? projectId : null,
          agent: filter.id === "agent" ? filter.agent : null,
          limit: 20,
        })
        .then((r) => {
          if (seq === seqRef.current) setResults(r);
        });
    }, 120);
    return () => clearTimeout(handle);
  }, [text, filter, projectId]);

  const groups = useMemo<SearchGroups>(() => {
    if (filter.id === "files") {
      return { threads: [], messages: [], files: projectId ? rankFiles(files, text, 30) : [] };
    }
    let threads = results?.threads ?? [];
    let messages = results?.messages ?? [];
    if (filter.id === "running") {
      const running = new Set(runningThreadIds);
      threads = threads.filter((h) => running.has(h.threadId));
      messages = messages.filter((h) => running.has(h.threadId));
    }
    const showFiles = (filter.id === "all" || filter.id === "project") && Boolean(projectId);
    return { threads, messages, files: showFiles ? rankFiles(files, text, 5) : [] };
  }, [filter, results, runningThreadIds, projectId, files, text]);

  const rows = useMemo(() => flattenRows(groups), [groups]);
  const active = rows.length > 0 ? Math.min(activeIndex, rows.length - 1) : 0;

  useEffect(() => setActiveIndex(0), [text, filter]);

  useEffect(() => {
    listRef.current?.querySelector(".search-item.active")?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const projectNames = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects]);
  const agentLabels = useMemo(() => new Map(agents.map((a) => [a.id, a.label])), [agents]);

  const subFor = (hit: SearchHit) =>
    [projectNames.get(hit.projectId), agentLabels.get(hit.agent)].filter(Boolean).join(" · ");

  const openRow = (row: SearchRow | undefined) => {
    if (!row) return;
    if (row.kind === "file") onOpenFile(row.path);
    else onOpenThread(row.hit.threadId, row.hit.seq);
    onClose();
  };

  const chips: { filter: SearchFilter; label: string; disabled: boolean }[] = [
    { filter: { id: "all" }, label: "All", disabled: false },
    { filter: { id: "project" }, label: "This project", disabled: !projectId },
    { filter: { id: "running" }, label: "Running", disabled: false },
    ...agents.map((a) => ({ filter: { id: "agent", agent: a.id } as SearchFilter, label: a.label, disabled: false })),
    { filter: { id: "files" }, label: "Files", disabled: !projectId },
  ];
  const chipFilters = chips.filter((c) => !c.disabled).map((c) => c.filter);

  const showHint = text.trim().length === 0;

  const renderHit = (kind: "thread" | "message", hit: SearchHit, index: number) => {
    const isActive = index === active;
    return (
      <div
        key={`${kind}:${hit.threadId}:${hit.seq ?? "t"}`}
        id={`search-row-${index}`}
        role="option"
        aria-selected={isActive}
        className={`search-item${isActive ? " active" : ""}`}
        onMouseMove={() => index !== active && setActiveIndex(index)}
        onMouseDown={(e) => {
          e.preventDefault(); // keep focus in the input
          openRow(rows[index]);
        }}
      >
        {kind === "message" ? (
          <>
            <span className="search-item-snippet">
              <SearchSnippet snippet={hit.snippet} />
            </span>
            <span className="search-item-sub">
              {hit.title} · {hit.kind === "user" ? "You" : "Agent"}
            </span>
          </>
        ) : (
          <>
            <span className="search-item-title">{hit.title}</span>
            <span className="search-item-sub">{subFor(hit)}</span>
          </>
        )}
        <span className="search-time">{relativeTime(hit.updatedAt, now)}</span>
      </div>
    );
  };

  const renderFile = (path: string, index: number) => {
    const isActive = index === active;
    const slash = path.lastIndexOf("/");
    const name = slash >= 0 ? path.slice(slash + 1) : path;
    const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
    return (
      <div
        key={`file:${path}`}
        id={`search-row-${index}`}
        role="option"
        aria-selected={isActive}
        className={`search-item${isActive ? " active" : ""}`}
        onMouseMove={() => index !== active && setActiveIndex(index)}
        onMouseDown={(e) => {
          e.preventDefault();
          openRow(rows[index]);
        }}
      >
        <span className="search-item-title search-file-name">{name}</span>
        <span className="search-item-sub search-file-dir">{dir}</span>
      </div>
    );
  };

  const messageBase = groups.threads.length;
  const fileBase = messageBase + groups.messages.length;

  return (
    <div
      className="sheet-backdrop palette-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="search-dialog" role="dialog" aria-modal="true" aria-label="Search">
        <input
          ref={inputRef}
          className="search-input"
          placeholder="Search threads, messages and files  ·  > for actions"
          spellCheck={false}
          value={text}
          role="combobox"
          aria-expanded="true"
          aria-controls="search-list"
          aria-activedescendant={rows[active] ? `search-row-${active}` : undefined}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Handled here, so the window's own shortcuts (Esc stops a turn) don't also fire.
            if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
              setActiveIndex(Math.min(active + 1, Math.max(0, rows.length - 1)));
            } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
              setActiveIndex(Math.max(active - 1, 0));
            } else if (e.key === "Enter") {
              openRow(rows[active]);
            } else if (e.key === "Escape") {
              onClose();
            } else if (e.key === "Tab") {
              if (chipFilters.length === 0) return;
              const dir = e.shiftKey ? -1 : 1;
              const found = chipFilters.findIndex((f) => sameFilter(f, filter));
              const i = found >= 0 ? found : dir > 0 ? -1 : 0;
              setFilter(chipFilters[(i + dir + chipFilters.length) % chipFilters.length]!);
            } else {
              return;
            }
            e.preventDefault();
            e.stopPropagation();
          }}
        />

        <div className="search-filters" role="radiogroup" aria-label="Search filter">
          {chips.map(({ filter: f, label, disabled }) => (
            <button
              key={f.id === "agent" ? `agent:${f.agent}` : f.id}
              type="button"
              className="search-chip"
              role="radio"
              aria-checked={sameFilter(filter, f)}
              disabled={disabled}
              onClick={() => setFilter(f)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="search-list" id="search-list" role="listbox" ref={listRef}>
          {showHint && <div className="search-hint">Type to search threads, messages and files.</div>}
          {!showHint && rows.length === 0 && <div className="search-empty">No matches</div>}

          {groups.threads.length > 0 && <div className="search-section">Threads</div>}
          {groups.threads.map((hit, i) => renderHit("thread", hit, i))}

          {groups.messages.length > 0 && <div className="search-section">Messages</div>}
          {groups.messages.map((hit, j) => renderHit("message", hit, messageBase + j))}

          {groups.files.length > 0 && <div className="search-section">Files</div>}
          {groups.files.map((path, k) => renderFile(path, fileBase + k))}
        </div>

        <div className="search-foot">↑↓ move · ↵ open · Tab filter · {">"} actions · esc close</div>
      </div>
    </div>
  );
}
