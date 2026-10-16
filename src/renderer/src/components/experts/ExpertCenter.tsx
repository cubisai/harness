import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { ChevronRight, Plus } from "lucide-react";
import type { ExpertDef } from "../../../../shared/experts";
import { api } from "../../api";
import { useStore } from "../../store";
import { Select, type SelectOption } from "../Select";
import { AddExpertDialog } from "./AddExpertDialog";
import { ExpertAvatar } from "./ExpertAvatar";
import { ExpertDetail } from "./ExpertDetail";

/** Where the summon counts live; a JSON map of expert id → times summoned. */
const USAGE_KEY = "cubiq.expertUsage";

export type SortKey = "recommended" | "used" | "newest";
export type KindFilter = "agent" | "team";

const SORT_OPTIONS: SelectOption<SortKey>[] = [
  { value: "recommended", label: "Recommended" },
  { value: "used", label: "Most used" },
  { value: "newest", label: "Newest" },
];

/** Summon counts off localStorage; a missing or malformed map reads as empty. */
export function readUsage(): Record<string, number> {
  try {
    const raw = localStorage.getItem(USAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const usage: Record<string, number> = {};
    for (const [id, n] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof n === "number" && Number.isFinite(n) && n >= 0) usage[id] = n;
    }
    return usage;
  } catch {
    return {};
  }
}

/** Add one to an expert's summon count; storage failure just skips the write. */
export function bumpUsage(id: string): Record<string, number> {
  const usage = readUsage();
  usage[id] = (usage[id] ?? 0) + 1;
  try {
    localStorage.setItem(USAGE_KEY, JSON.stringify(usage));
  } catch {
    // Storage is unavailable or full; the count is lost, which is harmless here.
  }
  return usage;
}

/** Summon from the catalogue: count the use, then open the thread with the expert. */
export function summon(def: ExpertDef, prompt?: string): void {
  bumpUsage(def.id);
  void useStore.getState().summonExpert(def.id, prompt);
}

/** The catalogue filtered by the toolbar, then ordered. */
export function filterDefs(
  defs: ExpertDef[],
  opts: { query: string; kind: KindFilter; category: string; sort: SortKey; myExperts: boolean; usage: Record<string, number> },
): ExpertDef[] {
  const q = opts.query.trim().toLowerCase();
  const list = defs.filter((d) => {
    if (d.kind !== opts.kind) return false;
    if (opts.category !== "All" && d.category !== opts.category) return false;
    if (opts.myExperts && d.source !== "imported" && !(opts.usage[d.id] ?? 0)) return false;
    if (!q) return true;
    return (
      d.name.toLowerCase().includes(q) ||
      d.profession.toLowerCase().includes(q) ||
      d.persona.toLowerCase().includes(q) ||
      d.description.toLowerCase().includes(q) ||
      d.tags.some((t) => t.toLowerCase().includes(q))
    );
  });
  if (opts.sort === "used") {
    return list
      .map((d, i) => ({ d, i }))
      .sort((a, b) => (opts.usage[b.d.id] ?? 0) - (opts.usage[a.d.id] ?? 0) || a.i - b.i)
      .map((x) => x.d);
  }
  if (opts.sort === "newest") {
    return list
      .map((d, i) => ({ d, i }))
      .sort((a, b) => Number(b.d.source === "imported") - Number(a.d.source === "imported") || b.i - a.i)
      .map((x) => x.d);
  }
  return list;
}

/** The categories in catalogue order, for the filter chips. */
export function categoriesOf(defs: ExpertDef[]): string[] {
  const seen = new Set<string>();
  const list: string[] = [];
  for (const d of defs) {
    if (!seen.has(d.category)) {
      seen.add(d.category);
      list.push(d.category);
    }
  }
  return list;
}

/** Up to six scenarios: the fullest categories, teams first, three rows each. */
export function expertScenarios(defs: ExpertDef[]): { category: string; items: ExpertDef[] }[] {
  const byCategory = new Map<string, ExpertDef[]>();
  for (const d of defs) {
    const list = byCategory.get(d.category) ?? [];
    list.push(d);
    byCategory.set(d.category, list);
  }
  return [...byCategory.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 6)
    .map(([category, list]) => ({
      category,
      items: [...list].sort((a, b) => Number(b.kind === "team") - Number(a.kind === "team")).slice(0, 3),
    }));
}

interface ExpertCardProps {
  def: ExpertDef;
  canSummon: boolean;
  onOpen(): void;
  onSummon(): void;
}

/** One catalogue card: the whole card opens the detail, Summon starts the thread. */
export function ExpertCard({ def, canSummon, onOpen, onSummon }: ExpertCardProps) {
  return (
    <div
      className="wb-card xc-card"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="wb-card-header">
        <ExpertAvatar id={def.id} text={def.avatarText} className="wb-avatar" />
        <div className="wb-card-meta">
          <h4 className="wb-card-title">{def.name}</h4>
          <div className="wb-card-sub">
            {def.persona} · {def.profession}
          </div>
        </div>
      </div>
      <p className="wb-card-desc">{def.description}</p>
      <div className="wb-card-footer">
        <div className="wb-tags">
          {def.tags.slice(0, 3).map((t) => (
            <span key={t} className="wb-tag">
              {t}
            </span>
          ))}
          {def.kind === "team" && <span className="wb-tag">Team · {(def.members?.length ?? 0) + 1}</span>}
        </div>
        <button
          className="button ghost wb-action-btn"
          disabled={!canSummon}
          title={canSummon ? undefined : "Open a project first"}
          onClick={(e) => {
            e.stopPropagation();
            onSummon();
          }}
        >
          Summon
        </button>
      </div>
    </div>
  );
}

/**
 * The Experts tab's catalogue: search, categories, sort and a grid of expert
 * cards, each opening a detail modal that can Summon it. The base engines are
 * the Library's own concern and arrive through the `engines` render prop,
 * shown when the "Engines" category is picked.
 */
export function ExpertCenter({ engines }: { engines?: (query: string) => ReactNode } = {}) {
  const experts = useStore((s) => s.experts);
  const canSummon = useStore((s) => Boolean(s.selectedProjectId));
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<KindFilter>("agent");
  const [category, setCategory] = useState("All");
  const [sort, setSort] = useState<SortKey>("recommended");
  const [myExperts, setMyExperts] = useState(false);
  const [usage, setUsage] = useState<Record<string, number>>(() => readUsage());
  const [detail, setDetail] = useState<ExpertDef | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (experts === null) void useStore.getState().loadExperts();
  }, [experts]);

  const defs = experts ?? [];
  const counts = useMemo(() => {
    let agents = 0;
    let teams = 0;
    for (const d of defs) {
      if (d.kind === "team") teams += 1;
      else agents += 1;
    }
    return { agents, teams };
  }, [defs]);
  const categories = useMemo(() => ["All", ...categoriesOf(defs), "Engines"], [defs]);
  const scenarios = useMemo(() => expertScenarios(defs), [defs]);
  const shown = useMemo(
    () => filterDefs(defs, { query, kind, category, sort, myExperts, usage }),
    [defs, query, kind, category, sort, myExperts, usage],
  );

  const summonDef = (def: ExpertDef, prompt?: string) => {
    summon(def, prompt);
    setUsage(readUsage());
  };

  return (
    <div className="xc-root">
      <div className="library-toolbar">
        <input
          className="text-input library-search-input"
          placeholder="Search experts, roles or tags…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
        />
        <div className="segmented" role="group" aria-label="Expert kind">
          <button aria-pressed={kind === "agent"} className={kind === "agent" ? "on" : ""} onClick={() => setKind("agent")}>
            Experts {counts.agents}
          </button>
          <button aria-pressed={kind === "team"} className={kind === "team" ? "on" : ""} onClick={() => setKind("team")}>
            Teams {counts.teams}
          </button>
        </div>
        <span className="xc-sort-label">Sort</span>
        <Select value={sort} options={SORT_OPTIONS} onChange={(v) => setSort(v)} ariaLabel="Sort" className="xc-sort" />
        <button className={`button ghost xc-my${myExperts ? " on" : ""}`} aria-pressed={myExperts} onClick={() => setMyExperts((v) => !v)}>
          My experts
        </button>
        <button className="button ghost" onClick={() => setAdding(true)}>
          <Plus size={14} strokeWidth={1.75} aria-hidden />
          Add expert
        </button>
      </div>

      {scenarios.length > 0 && (
        <div className="xc-scenarios">
          {scenarios.map((s) => (
            <div key={s.category} className="xc-scenario">
              <h4>{s.category}</h4>
              {s.items.map((d) => (
                <button key={d.id} className="xc-scenario-row" onClick={() => setDetail(d)}>
                  <span className="xc-scenario-name">{d.name}</span>
                  <ChevronRight size={14} strokeWidth={1.75} aria-hidden />
                </button>
              ))}
            </div>
          ))}
        </div>
      )}

      <div className="category-pills">
        {categories.map((c) => (
          <button key={c} className={`category-pill${category === c ? " on" : ""}`} onClick={() => setCategory(c)}>
            {c}
          </button>
        ))}
      </div>

      <div className="wb-content-pad">
        {category === "Engines" ? (
          engines?.(query)
        ) : experts === null ? (
          <p className="xc-quiet">Loading experts…</p>
        ) : shown.length === 0 ? (
          <p className="xc-empty">No experts match. Try another search or category.</p>
        ) : (
          <div className="wb-grid">
            {shown.map((d) => (
              <ExpertCard key={d.id} def={d} canSummon={canSummon} onOpen={() => setDetail(d)} onSummon={() => summonDef(d)} />
            ))}
          </div>
        )}
      </div>

      {detail && (
        <ExpertDetail
          def={detail}
          used={usage[detail.id] ?? 0}
          canSummon={canSummon}
          onClose={() => setDetail(null)}
          onSummon={() => summonDef(detail)}
          onSummonPrompt={(prompt) => summonDef(detail, prompt)}
          onRemove={
            detail.source === "imported"
              ? async () => {
                  await api().removeExpert(detail.id);
                  await useStore.getState().loadExperts();
                  setDetail(null);
                }
              : undefined
          }
          onUpdate={
            detail.source === "imported" && detail.sourceUrl
              ? async () => {
                  await api().importExperts(detail.sourceUrl!, [detail.id]);
                  await useStore.getState().loadExperts();
                  const fresh = useStore.getState().experts?.find((e) => e.id === detail.id);
                  setDetail(fresh ?? null);
                }
              : undefined
          }
        />
      )}

      {adding && <AddExpertDialog onClose={() => setAdding(false)} onInstalled={() => void useStore.getState().loadExperts()} />}
    </div>
  );
}
