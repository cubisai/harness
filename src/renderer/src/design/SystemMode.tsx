import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Activity, Component, Layers, MonitorSmartphone, Palette, Ruler, Search, Square, Type } from "lucide-react";
import type { DesignKitDoc, DesignKitGroup, DesignKitPart, DesignReach, DesignSystemDoc, DesignToken } from "../../../shared/types";
import { BRAND_TOKENS } from "../../../shared/design";
import { api } from "../api";
import { Select } from "../components/Select";
import { useStore } from "../store";
import { ColorSwatch } from "./ColorSwatch";
import { contrastRatio, paintedHexColor, type Rgb } from "./contrast";
import { SystemPanel } from "./SystemPanel";
import { typeScale } from "./text-styles";
import { FOUNDATIONS, RAMP_STEPS, colorRoles, foundationGroups, ramp, resolveVars, schemeValues, siblingUrl, tokenMatches, MOD_KEY, type ColorRole, type Foundation, type RoleSwatch } from "./system-mode";

type Page = { kind: "foundation"; id: Foundation } | { kind: "part"; ui: string };
type PartTab = "variants" | "playground" | "usage";
type Scheme = "light" | "dark";

const FOUNDATION_ICONS: Record<Foundation, ReactNode> = {
  colors: <Palette size={14} strokeWidth={1.75} aria-hidden />,
  typography: <Type size={14} strokeWidth={1.75} aria-hidden />,
  spacing: <Ruler size={14} strokeWidth={1.75} aria-hidden />,
  shape: <Square size={14} strokeWidth={1.75} aria-hidden />,
  elevation: <Layers size={14} strokeWidth={1.75} aria-hidden />,
  breakpoints: <MonitorSmartphone size={14} strokeWidth={1.75} aria-hidden />,
  motion: <Activity size={14} strokeWidth={1.75} aria-hidden />,
};

const HEX = /^#[0-9a-f]{6}$/i;

/** The IPC error message, without Electron's wrapper. */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err);
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * System mode: the kit behind the thread, as a library. The rail lists Foundations (token pages) and Components (with
 * their usage); the page shows one of them; the right panel edits it. Every applied edit is one undo step (⌘Z here, or
 * the toast's Undo), and anything that reaches other pages shows its reach before it's applied.
 */
export function SystemMode({ threadId, pageUrl, pageRel, reloadKey }: { threadId: string; pageUrl: string; pageRel: string; reloadKey: string }) {
  const thread = useStore((s) => {
    for (const list of Object.values(s.threads)) {
      const t = list.find((x) => x.id === threadId);
      if (t) return t;
    }
    return null;
  });
  const setSystemStep = useStore((s) => s.setSystemStep);
  const [rev, setRev] = useState(0);
  const refresh = useCallback(() => setRev((n) => n + 1), []);
  const [sys, setSys] = useState<DesignSystemDoc | null>(null);
  const [kit, setKit] = useState<DesignKitDoc | null>(null);
  const [groups, setGroups] = useState<DesignKitGroup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [page, setPage] = useState<Page>({ kind: "foundation", id: "colors" });
  const [query, setQuery] = useState("");
  const [scheme, setScheme] = useState<Scheme>(() => (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    void Promise.all([api().designSystemDoc(threadId), api().designKitDoc(threadId)])
      .then(([s, k]) => {
        if (!live) return;
        setSys(s);
        setKit(k);
      })
      .catch((err) => live && setError(errorText(err)));
    return () => {
      live = false;
    };
  }, [threadId, reloadKey, rev, thread?.designSystem]);
  useEffect(() => {
    let live = true;
    void api()
      .designKitGroups(thread?.projectId ?? null)
      .then((list) => live && setGroups(list))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [thread?.projectId, thread?.designSystem]);

  // One undo step per applied edit: the toast's Undo and ⌘Z both step back through System mode's history.
  const history = useCallback(
    async (action: "undo" | "redo") => {
      const res = await api().designSystemHistory(threadId, action);
      if (res) {
        useStore.getState().apply({ type: "thread", thread: res.thread });
        setStatus(`${action === "undo" ? "Undone" : "Redone"}: ${res.label}`);
      } else setStatus(action === "undo" ? "Nothing to undo" : "Nothing to redo");
      refresh();
      return res;
    },
    [threadId, refresh],
  );
  const step = useCallback(
    (text: string) => {
      setError(null);
      setSystemStep(threadId, { text, undo: () => history("undo") });
    },
    [threadId, setSystemStep, history],
  );
  const historyRef = useRef(history);
  historyRef.current = history;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !(e.metaKey || e.ctrlKey)) return;
      const t = e.target as HTMLElement | null;
      const k = e.key.toLowerCase();
      if (k === "k" && !e.shiftKey) {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName))) return;
      if (k !== "z" && k !== "y") return;
      e.preventDefault();
      setSystemStep(threadId, null);
      void historyRef.current(k === "y" || e.shiftKey ? "redo" : "undo").catch((err) => setError(errorText(err)));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [threadId, setSystemStep]);

  const tokens = useMemo(() => sys?.groups.flatMap((g) => g.tokens) ?? [], [sys]);
  const foundations = useMemo(() => foundationGroups(tokens.filter((t) => tokenMatches(t, query))), [tokens, query]);
  const parts = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (kit?.parts ?? []).filter((p) => !q || p.name.toLowerCase().includes(q) || p.ui.includes(q) || p.category.toLowerCase().includes(q));
  }, [kit, query]);
  const categories = useMemo(() => {
    const out = new Map<string, DesignKitPart[]>();
    for (const p of parts) out.set(p.category || "Other", [...(out.get(p.category || "Other") ?? []), p]);
    return [...out.entries()];
  }, [parts]);
  const part = page.kind === "part" ? kit?.parts.find((p) => p.ui === page.ui) ?? null : null;
  useEffect(() => {
    if (page.kind === "part" && kit && !part) setPage({ kind: "foundation", id: "colors" });
  }, [page, kit, part]);

  // The theme menu: the kit's own themes, swapped the way the style picker does.
  const group = groups.find((g) => g.themes.some((t) => t.id === thread?.designSystem)) ?? groups.find((g) => g.id === kit?.kit?.id) ?? null;
  const themeId = group?.themes.find((t) => t.id === thread?.designSystem)?.id ?? group?.themes[0]?.id ?? "";
  const pickTheme = (id: string): void => {
    const card = group?.themes.find((t) => t.id === id);
    if (!card || id === thread?.designSystem) return;
    void api()
      .designApplyTheme(threadId, id)
      .then((res) => {
        useStore.getState().apply({ type: "thread", thread: res.thread });
        const previous = res.previous;
        setSystemStep(threadId, { text: `Theme → ${card.name}`, undo: () => (previous ? api().designApplyTheme(threadId, previous) : api().setDesignSystem(threadId, null)) });
        refresh();
      })
      .catch((err) => setError(errorText(err)));
  };

  const kitName = kit?.kit?.name ?? sys?.name ?? "System";
  const where = page.kind === "foundation" ? ["Foundations", FOUNDATIONS.find((f) => f.id === page.id)!.label] : ["Components", part?.name ?? page.ui];
  const editable = sys?.editable ?? false;
  const sub = !sys ? "" : sys.copyOnWrite ? "Your first edit saves a copy in the project" : !editable ? "Read-only: open a project folder to edit it" : "Project copy · edits reach every page on this kit";

  if (error && !sys) return <p className="design-inspector-empty">{error}</p>;
  if (!sys) return <p className="design-inspector-empty">Loading…</p>;

  return (
    <div className="lib">
      <aside className="lib-rail" aria-label="Library">
        <div className="lib-search">
          <Search size={14} strokeWidth={1.75} aria-hidden />
          <input ref={searchRef} className="lib-search-input" placeholder="Search names, tokens…" aria-label="Search the system" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setQuery("")} spellCheck={false} />
          <kbd className="lib-kbd">{MOD_KEY}K</kbd>
        </div>
        <div className="lib-rail-scroll">
          <h2 className="lib-rail-head">
            <span>Foundations</span>
            <span className="lib-count">{FOUNDATIONS.filter((f) => foundations[f.id].length).length}</span>
          </h2>
          {FOUNDATIONS.map((f) => (
            <button key={f.id} className={"lib-row" + (page.kind === "foundation" && page.id === f.id ? " on" : "")} aria-current={page.kind === "foundation" && page.id === f.id ? "page" : undefined} onClick={() => setPage({ kind: "foundation", id: f.id })}>
              {FOUNDATION_ICONS[f.id]}
              <span className="lib-row-label">{f.label}</span>
              <span className="lib-count">{foundations[f.id].length}</span>
            </button>
          ))}
          <h2 className="lib-rail-head">
            <span>Components</span>
            <span className="lib-count">{parts.length}</span>
          </h2>
          {!kit?.kit && !parts.length && <p className="lib-empty">This style has tokens but no components.</p>}
          {kit?.kit && !parts.length && query && <p className="lib-empty">No component matches.</p>}
          {categories.map(([cat, list]) => (
            <div key={cat}>
              <div className="lib-rail-group">{cat}</div>
              {list.map((p) => (
                <button key={p.ui} className={"lib-row" + (page.kind === "part" && page.ui === p.ui ? " on" : "")} aria-current={page.kind === "part" && page.ui === p.ui ? "page" : undefined} onClick={() => setPage({ kind: "part", ui: p.ui })}>
                  <Component size={14} strokeWidth={1.75} aria-hidden />
                  <span className="lib-row-label">{p.name}</span>
                  {p.draft ? <span className="lib-tag">draft</span> : p.isNew ? <span className="lib-tag">new</span> : null}
                  <span className="lib-count" title={p.usage.count ? `Used ${p.usage.count}× in ${plural(p.usage.files, "file")}` : "Not used yet"}>
                    {p.usage.count || ""}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      </aside>
      <div className="lib-main">
        <div className="lib-bar">
          {group && group.themes.length > 0 && (
            <Select<string> value={themeId} options={group.themes.map((t) => ({ value: t.id, label: t.name, lead: <span className="lib-dot" style={{ background: t.card.accent }} aria-hidden /> }))} onChange={pickTheme} ariaLabel="Theme" className="ghost-select" />
          )}
          <div className="segmented compact" role="group" aria-label="Mode">
            {(["light", "dark"] as const).map((m) => (
              <button key={m} className={scheme === m ? "on" : ""} aria-pressed={scheme === m} onClick={() => setScheme(m)}>
                {m === "light" ? "Light" : "Dark"}
              </button>
            ))}
          </div>
          <span className="lib-crumbs" title={sub}>
            {[kitName, ...where].join(" / ")}
          </span>
          {status && <span className="lib-status">{status}</span>}
        </div>
        {error && (
          <p className="sys-error lib-error" role="alert">
            {error}
          </p>
        )}
        {kit?.draft && <DraftBar threadId={threadId} draft={kit.draft} onDone={(label) => { if (label) step(label); refresh(); }} onError={setError} />}
        {page.kind === "foundation" ? (
          <FoundationPage
            key={page.id}
            id={page.id}
            threadId={threadId}
            tokens={foundations[page.id]}
            allTokens={tokens}
            scheme={scheme}
            query={query}
            editable={editable}
            reloadKey={`${reloadKey}-${rev}`}
            onStep={(label) => {
              step(label);
              refresh();
            }}
            onError={setError}
          />
        ) : part ? (
          <PartPage key={part.ui} threadId={threadId} part={part} pageUrl={pageUrl} pageRel={pageRel} scheme={scheme} rev={`${reloadKey}-${rev}`} editable={kit?.editable ?? false} onStep={(label) => { step(label); refresh(); }} onError={setError} onDoc={setKit} />
        ) : null}
      </div>
    </div>
  );
}

function DraftBar({ threadId, draft, onDone, onError }: { threadId: string; draft: NonNullable<DesignKitDoc["draft"]>; onDone: (label: string | null) => void; onError: (e: string) => void }) {
  const [busy, setBusy] = useState(false);
  const bits = [draft.added.length ? `${draft.added.length} added` : "", draft.changed.length ? `${draft.changed.length} changed` : "", draft.removed.length ? `${draft.removed.length} removed` : ""].filter(Boolean);
  const run = (save: boolean): void => {
    setBusy(true);
    const work = save ? api().designKitDraftSave(threadId).then(({ thread }) => useStore.getState().apply({ type: "thread", thread })) : api().designKitDraftDiscard(threadId);
    void work
      .then(() => onDone(save ? "Saved the draft to the kit" : null))
      .catch((err) => onError(errorText(err)))
      .finally(() => setBusy(false));
  };
  return (
    <div className="lib-draft" role="status">
      <span className="lib-draft-text">Draft · {bits.join(" · ") || "changes"}</span>
      {draft.errors.length > 0 && <span className="lib-draft-errors" title={draft.errors.join("\n")}>{plural(draft.errors.length, "check")} failing</span>}
      <button className="button ghost" disabled={busy} onClick={() => run(false)}>
        Discard
      </button>
      <button className="button primary" disabled={busy || draft.errors.length > 0} title={draft.errors.length ? "Fix the failing checks first" : undefined} onClick={() => run(true)}>
        Save to kit
      </button>
    </div>
  );
}

/** A Foundations page: Colors and Typography draw their own view above the token rows; the rest are the rows. */
function FoundationPage({
  id,
  threadId,
  tokens,
  allTokens,
  scheme,
  query,
  editable,
  reloadKey,
  onStep,
  onError,
}: {
  id: Foundation;
  threadId: string;
  tokens: DesignToken[];
  allTokens: DesignToken[];
  scheme: Scheme;
  query: string;
  editable: boolean;
  reloadKey: string;
  onStep: (label: string) => void;
  onError: (e: string) => void;
}) {
  const label = FOUNDATIONS.find((f) => f.id === id)!.label;
  const names = useMemo(() => new Set(tokens.map((t) => t.name)), [tokens]);
  const filter = useCallback((t: DesignToken) => names.has(t.name), [names]);
  const [brandDraft, setBrandDraft] = useState<string | null>(null);
  const values = useMemo(() => {
    const v = schemeValues(allTokens, scheme);
    if (!brandDraft) return v;
    // While a brand colour is being reviewed, the cards show it; its tints are worked out again from it.
    for (const name of BRAND_TOKENS) if (name in v) delete v[name];
    v["--color-primary"] = brandDraft;
    return v;
  }, [allTokens, scheme, brandDraft]);
  const roles = useMemo(() => (id === "colors" ? colorRoles(values) : []), [id, values]);
  return (
    <div className="lib-page-wrap">
      <div className="lib-page">
        <h1 className="lib-title">
          {label} <span className="lib-title-meta">{tokens.length}</span>
        </h1>
        {id === "colors" && roles.length > 0 && <ColorsView roles={roles} bg={resolveVars(values["--color-bg"] ?? "transparent", values)} />}
        {id === "typography" && <TypeView values={values} />}
        {tokens.length === 0 ? (
          <p className="lib-empty">{query ? "No token here matches the search." : `This kit has no ${label.toLowerCase()} tokens.`}</p>
        ) : (
          <div className="lib-tokens">
            <SystemPanel threadId={threadId} reloadKey={reloadKey} bare filter={filter} onChanged={onStep} />
          </div>
        )}
      </div>
      {id === "colors" && roles[0] && (
        <aside className="lib-panel" aria-label="Colors">
          <h2 className="lib-panel-title">Colors</h2>
          <BrandCard threadId={threadId} role={roles[0]} editable={editable} ramps={roles} onDraft={setBrandDraft} onStep={onStep} onError={onError} />
        </aside>
      )}
    </div>
  );
}

/** A colour as painted, or null when the browser can't paint it alone or it's see-through. */
function paint(value: string): Rgb | null {
  if (/var\(/i.test(value) || !CSS.supports("color", value)) return null;
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = value;
  ctx.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0, a = 0] = ctx.getImageData(0, 0, 1, 1).data;
  return a === 255 ? { r, g, b } : null;
}

/** The kit's ink for a swatch, unless it's under 3:1 there: then the more readable of white and black. */
function readableInk(value: string, ink: string): string {
  const ground = paint(value);
  const own = paint(ink);
  if (!ground || !own || contrastRatio(ground, own) >= 3) return ink;
  return contrastRatio(ground, { r: 255, g: 255, b: 255 }) >= contrastRatio(ground, { r: 0, g: 0, b: 0 }) ? "white" : "black";
}

function Swatch({ s, bg }: { s: RoleSwatch; bg: string }) {
  return (
    <div className="lib-swatch">
      <span className="lib-swatch-chip" style={{ background: `linear-gradient(${s.value}, ${s.value}), ${bg}`, color: readableInk(s.value, s.ink) }} title={s.token ?? "Worked out from the role colour"}>
        Aa
      </span>
      <span className="lib-swatch-label">{s.label}</span>
      <span className="lib-swatch-token">{s.token ? s.token.replace(/^--color-/, "") : "derived"}</span>
    </div>
  );
}

function ColorsView({ roles, bg }: { roles: ColorRole[]; bg: string }) {
  return (
    <>
      <div className="lib-roles">
        {roles.map((r) => (
          <section className="lib-role" key={r.id} aria-label={r.label}>
            <header className="lib-role-head">
              <span>{r.label}</span>
              <span className="lib-role-hex">{paintedHexColor(r.base) ?? r.token.replace(/^--color-/, "")}</span>
            </header>
            <div className="lib-role-row">
              <span className="lib-role-kind">Fill</span>
              {r.fill.map((s) => (
                <Swatch key={s.label} s={s} bg={bg} />
              ))}
            </div>
            <div className="lib-role-row">
              <span className="lib-role-kind">Container</span>
              {r.container.map((s) => (
                <Swatch key={s.label} s={s} bg={bg} />
              ))}
            </div>
          </section>
        ))}
      </div>
      <h2 className="lib-sub">Palettes</h2>
      <div className="lib-ramps" role="table" aria-label="Palettes">
        <div className="lib-ramp" role="row">
          <span role="columnheader" />
          {RAMP_STEPS.map((n) => (
            <span key={n} className="lib-ramp-step" role="columnheader">
              {n}
            </span>
          ))}
        </div>
        {roles.map((r) => (
          <div className="lib-ramp" role="row" key={r.id}>
            <span className="lib-ramp-name" role="rowheader">
              {r.label}
            </span>
            {ramp(r.base).map((c, i) => (
              <span key={i} role="cell" className={"lib-ramp-cell" + (i === 5 ? " base" : "")} style={{ background: c }} title={`${r.label} ${RAMP_STEPS[i]}${i === 5 ? " · the role colour" : ""}`} />
            ))}
          </div>
        ))}
      </div>
      <p className="lib-note">Palettes are worked out from each role's colour; the tokens below are what pages use.</p>
    </>
  );
}

function TypeView({ values }: { values: Record<string, string> }) {
  const steps = typeScale(values).slice().reverse();
  const families = (["--font-display", "--font-sans", "--font-mono"] as const).filter((n) => values[n]);
  return (
    <>
      {families.length > 0 && (
        <div className="lib-families">
          {families.map((n) => (
            <div className="lib-family" key={n}>
              <span className="lib-family-sample" style={{ fontFamily: resolveVars(values[n]!, values) }}>
                Aa
              </span>
              <span className="lib-family-name">{n.replace(/^--font-/, "")}</span>
              <span className="lib-family-value" title={values[n]}>
                {values[n]!.split(",")[0]!.replace(/["']/g, "")}
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="lib-scale">
        {steps.map((s) => (
          <div className="lib-scale-row" key={s.id}>
            <span className="lib-scale-meta">
              <span>{s.label}</span>
              <span className="lib-scale-px">{s.meta}</span>
            </span>
            <span className="lib-scale-sample" style={{ fontSize: Math.min(s.px, 48), lineHeight: s.px > 48 ? 1.15 : values[`--leading-${s.id}`] ?? "normal", fontFamily: resolveVars(values[s.px >= 24 ? "--font-display" : "--font-sans"] ?? "inherit", values) }}>
              The quick brown fox
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

/** Brand colour: pick, then Review shows its reach, then Apply rewrites the brand tokens in both modes. */
function BrandCard({ threadId, role, editable, ramps, onDraft, onStep, onError }: { threadId: string; role: ColorRole; editable: boolean; ramps: ColorRole[]; onDraft: (hex: string | null) => void; onStep: (label: string) => void; onError: (e: string) => void }) {
  const core = paintedHexColor(role.base) ?? "";
  const [open, setOpen] = useState(false);
  const [hex, setHex] = useState(core);
  const [reach, setReach] = useState<DesignReach | null>(null);
  const [busy, setBusy] = useState(false);
  const sys = useRef<string[]>([]);
  const valid = HEX.test(hex);
  const palette = useMemo(() => ramps.slice(0, 4).map((r) => ramp(r.base).slice(1, 9).map((c) => paintedHexColor(c) ?? "")), [ramps]);
  const close = (): void => {
    setOpen(false);
    setReach(null);
    onDraft(null);
  };
  const review = (): void => {
    if (!valid) return;
    setBusy(true);
    void api()
      .designSystemDoc(threadId)
      .then((doc) => {
        const have = new Set(doc?.groups.flatMap((g) => g.tokens.map((t) => t.name)) ?? []);
        sys.current = BRAND_TOKENS.filter((t) => have.has(t));
        return api().designReach(threadId, sys.current);
      })
      .then((r) => {
        setReach(r);
        onDraft(hex.toLowerCase());
      })
      .catch((err) => onError(errorText(err)))
      .finally(() => setBusy(false));
  };
  const applyBrand = (): void => {
    setBusy(true);
    const value = hex.toLowerCase();
    void api()
      .designSystemEdit(threadId, { brand: value })
      .then(({ thread }) => {
        useStore.getState().apply({ type: "thread", thread });
        close();
        onStep(`Changes applied · Brand colour → ${value}`);
      })
      .catch((err) => onError(errorText(err)))
      .finally(() => setBusy(false));
  };
  return (
    <div className="lib-card">
      <div className="lib-card-label">Brand colour</div>
      <button
        className="lib-brand"
        disabled={!editable}
        title={editable ? "Change the brand colour" : "Open a project folder to edit the kit"}
        aria-expanded={open}
        onClick={() => {
          setHex(core);
          setReach(null);
          setOpen(!open);
        }}
      >
        <span className="lib-brand-chip" style={{ background: role.base }} aria-hidden />
        <span className="lib-brand-hex">{core}</span>
        <span className="lib-tag">Core</span>
      </button>
      <p className="lib-note">Regenerates the primary palette in both modes; every role and component follows.</p>
      {open && !reach && (
        <div className="lib-picker" role="dialog" aria-label="Brand colour">
          <div className="lib-picker-row">
            <ColorSwatch value={valid ? hex : core} label="Brand colour" onInput={(v) => setHex(v)} />
            <input className="text-input lib-hex" value={hex} aria-label="Hex" spellCheck={false} onChange={(e) => setHex(e.target.value.trim())} onKeyDown={(e) => e.key === "Enter" && review()} />
          </div>
          <div className="lib-card-label">Kit palette</div>
          <div className="lib-palette">
            {palette.flat().map((c, i) =>
              c ? <button key={i} className={"lib-palette-cell" + (c === hex.toLowerCase() ? " on" : "")} style={{ background: c }} aria-label={c} title={c} onClick={() => setHex(c)} /> : <span key={i} />,
            )}
          </div>
          {!valid && <p className="sys-error">Use a 6-digit hex, like #0f968a.</p>}
          <div className="lib-picker-actions">
            <button className="button ghost" onClick={close}>
              Cancel
            </button>
            <button className="button primary" disabled={!valid || busy || hex.toLowerCase() === core} onClick={review}>
              Review
            </button>
          </div>
        </div>
      )}
      {open && reach && (
        <div className="lib-reach" role="alert">
          <p>
            Brand colour → <span className="lib-mono">{hex.toLowerCase()}</span>. This rewrites {plural(reach.tokens, "colour token")} and {plural(reach.instances, "use")} in {plural(reach.files, "page")}. Every page on this kit follows; this page shows it now.
          </p>
          <div className="lib-picker-actions">
            <button className="button ghost" onClick={close} disabled={busy}>
              Cancel
            </button>
            <button className="button primary" onClick={applyBrand} disabled={busy}>
              Apply
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** A component's page: the variant × state matrix, a playground, and where it's used. */
function PartPage({ threadId, part, pageUrl, pageRel, scheme, rev, editable, onStep, onError, onDoc }: { threadId: string; part: DesignKitPart; pageUrl: string; pageRel: string; scheme: Scheme; rev: string; editable: boolean; onStep: (label: string) => void; onError: (e: string) => void; onDoc: (doc: DesignKitDoc) => void }) {
  const [tab, setTab] = useState<PartTab>("variants");
  const variantProp = part.props.find((p) => p.name === "variant");
  const sizeProp = part.props.find((p) => p.name === "size");
  const variants = variantProp?.options ?? [];
  const sizes = sizeProp?.options ?? [];
  const [shown, setShown] = useState<string[]>(() => variants.slice(0, 4));
  const [size, setSize] = useState<string>(() => (typeof sizeProp?.default === "string" ? sizeProp.default : sizes[0] ?? ""));
  const [props, setProps] = useState<Record<string, string>>(() => Object.fromEntries(part.props.map((p) => [p.name, p.default === undefined ? (p.options?.[0] ?? "") : String(p.default)])));
  const [url, setUrl] = useState<string | null>(null);
  const [n, setN] = useState(0);
  const [removing, setRemoving] = useState<{ kind: "variant" | "prop"; name: string } | null>(null);
  const [adding, setAdding] = useState<"variant" | "prop" | null>(null);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState<"text" | "boolean" | "choice">("text");
  const [newOptions, setNewOptions] = useState("");
  const [copyFrom, setCopyFrom] = useState("");

  useEffect(() => {
    setShown((s) => {
      const kept = s.filter((v) => variants.includes(v));
      return kept.length ? kept : variants.slice(0, 4);
    });
    // Only when the variant list itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variants.join("|")]);

  useEffect(() => {
    if (tab === "usage") return;
    let live = true;
    const request = tab === "variants" ? { ui: part.ui, states: true, ...(shown.length ? { variants: shown } : {}), ...(size ? { size } : {}) } : { ui: part.ui, props };
    void api()
      .designKitSample(threadId, request)
      .then((rel) => {
        if (!live) return;
        setN((x) => x + 1);
        setUrl(siblingUrl(pageUrl, pageRel, rel));
      })
      .catch((err) => live && onError(errorText(err)));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, part.ui, tab, shown.join("|"), size, JSON.stringify(props), rev, pageUrl]);

  const edit = (e: Parameters<ReturnType<typeof api>["designKitEdit"]>[1], label: string): void => {
    void api()
      .designKitEdit(threadId, e)
      .then(({ doc, thread }) => {
        useStore.getState().apply({ type: "thread", thread });
        onDoc(doc);
        onStep(label);
        setRemoving(null);
        setAdding(null);
        setNewName("");
        setNewOptions("");
      })
      .catch((err) => onError(errorText(err)));
  };
  const addNow = (): void => {
    const name = newName.trim();
    if (!name) return;
    if (adding === "variant") edit({ kind: "addVariant", ui: part.ui, name, from: copyFrom || source }, `Added variant ${name} to ${part.name}`);
    else {
      const options = newOptions.split(",").map((o) => o.trim()).filter(Boolean);
      edit({ kind: "addProp", ui: part.ui, prop: { name, label: name, type: newType, ...(newType === "choice" ? { options, default: options[0] } : newType === "boolean" ? { default: false } : { default: "" }) } }, `Added prop ${name} to ${part.name}`);
    }
  };
  const fallback = typeof variantProp?.default === "string" ? variantProp.default : variants[0];
  // A kit's default variant is often its base style, with no rules of its own to copy: start from another one.
  const source = variants.find((v) => v !== fallback) ?? fallback ?? "";

  const usageLine = part.usage.count ? `used ${part.usage.count}× in ${plural(part.usage.files, "file")}` : "not used yet";
  return (
    <div className="lib-page-wrap">
      <div className="lib-page lib-part">
        <h1 className="lib-title">
          {part.name} <span className="lib-title-meta">{usageLine}{part.importName ? ` · ${part.importName}` : ""}</span>
          {part.draft && <span className="lib-tag">draft</span>}
          {part.isNew && !part.draft && <span className="lib-tag">new</span>}
        </h1>
        {part.description && <p className="lib-lede">{part.description}</p>}
        <div className="segmented compact lib-tabs" role="tablist">
          {(["variants", "playground", "usage"] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
              {t === "variants" ? "Variants" : t === "playground" ? "Playground" : `Usage ${part.usage.count}`}
            </button>
          ))}
        </div>
        {tab === "usage" ? (
          <div className="lib-usage">
            <p className="lib-note">{part.usage.count ? `${part.name} is used ${part.usage.count}× across ${plural(part.usage.files, "page")} on this kit, in this project.` : `No page on this kit uses ${part.name} yet.`}</p>
            {part.importName && (
              <pre className="lib-code">
                {`import { ${part.importName} } from "${part.packageName ?? "@/components/ui"}";`}
              </pre>
            )}
            <div className="lib-card-label">Markup</div>
            <pre className="lib-code">{part.snippet}</pre>
          </div>
        ) : (
          <div className="lib-sample">{url && <iframe key={`${n}-${scheme}`} className="lib-sample-frame" title={`${part.name} sample`} src={`${url}?s=${n}`} sandbox="allow-scripts" style={{ colorScheme: scheme }} />}</div>
        )}
      </div>
      <aside className="lib-panel" aria-label={`${part.name} properties`}>
        <h2 className="lib-panel-title">{part.name}</h2>
        {tab === "variants" && (variants.length > 0 || sizes.length > 0) && (
          <div className="lib-card">
            <div className="lib-card-label">Canvas shows</div>
            {variants.length > 0 && (
              <div className="lib-chips" role="group" aria-label="Variants shown">
                {variants.map((v) => (
                  <button key={v} className={"lib-chip" + (shown.includes(v) ? " on" : "")} aria-pressed={shown.includes(v)} onClick={() => setShown((s) => (s.includes(v) ? (s.length > 1 ? s.filter((x) => x !== v) : s) : variants.filter((x) => s.includes(x) || x === v)))}>
                    {v}
                  </button>
                ))}
              </div>
            )}
            {sizes.length > 0 && (
              <div className="lib-chips" role="group" aria-label="Size shown">
                {sizes.map((v) => (
                  <button key={v} className={"lib-chip" + (size === v ? " on" : "")} aria-pressed={size === v} onClick={() => setSize(v)}>
                    {v}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {tab === "playground" &&
          part.props.map((p) => (
            <label className="lib-prop" key={p.name}>
              <span className="lib-prop-label">{p.label || p.name}</span>
              {p.type === "choice" && p.options?.length ? (
                <Select<string> value={props[p.name] ?? p.options[0]!} options={p.options.map((o) => ({ value: o, label: o }))} onChange={(v) => setProps((s) => ({ ...s, [p.name]: v }))} ariaLabel={p.label || p.name} />
              ) : p.type === "boolean" ? (
                <input type="checkbox" checked={props[p.name] === "true"} onChange={(e) => setProps((s) => ({ ...s, [p.name]: String(e.target.checked) }))} />
              ) : (
                <input className="text-input" value={props[p.name] ?? ""} onChange={(e) => setProps((s) => ({ ...s, [p.name]: e.target.value }))} />
              )}
            </label>
          ))}
        {tab !== "usage" && (
          <>
            {variants.length > 0 && (
              <div className="lib-card">
                <div className="lib-card-label">Variants</div>
                {variants.map((v) => (
                  <div className="lib-list-row" key={v}>
                    <span className="lib-mono">{v}</span>
                    {v === fallback && <span className="lib-tag">default</span>}
                    {editable && variants.length > 1 && (
                      <button className="button ghost lib-row-action" aria-label={`Remove variant ${v}`} onClick={() => setRemoving({ kind: "variant", name: v })}>
                        Remove
                      </button>
                    )}
                  </div>
                ))}
                {removing?.kind === "variant" && (
                  <div className="lib-reach">
                    <p>
                      Remove <span className="lib-mono">{removing.name}</span>? {part.usage.count ? `Pages using it fall back to ${removing.name === fallback ? variants.find((x) => x !== fallback) : fallback}.` : "No page uses it."}
                    </p>
                    <div className="lib-picker-actions">
                      <button className="button ghost" onClick={() => setRemoving(null)}>
                        Cancel
                      </button>
                      <button className="button primary" onClick={() => edit({ kind: "removeVariant", ui: part.ui, name: removing.name }, `Removed variant ${removing.name} from ${part.name}`)}>
                        Remove
                      </button>
                    </div>
                  </div>
                )}
                {editable && adding !== "variant" && (
                  <button className="button ghost lib-add" onClick={() => { setAdding("variant"); setNewName(""); }}>
                    + Add variant
                  </button>
                )}
                {adding === "variant" && (
                  <div className="lib-add-form">
                    <input className="text-input" autoFocus placeholder="Name" aria-label="Variant name" value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => (e.key === "Enter" ? addNow() : e.key === "Escape" && setAdding(null))} />
                    <label className="lib-prop">
                      <span className="lib-prop-label">Copy from</span>
                      <Select<string> value={copyFrom || source} options={variants.map((v) => ({ value: v, label: v }))} onChange={setCopyFrom} ariaLabel="Copy from" />
                    </label>
                    <p className="lib-note">Copies its look under the new name; change it from the chat.</p>
                    <div className="lib-picker-actions">
                      <button className="button ghost" onClick={() => setAdding(null)}>
                        Cancel
                      </button>
                      <button className="button primary" disabled={!newName.trim()} onClick={addNow}>
                        Add
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
            <div className="lib-card">
              <div className="lib-card-label">Props</div>
              {part.props.length === 0 && <p className="lib-note">No props.</p>}
              {part.props.map((p) => (
                <div className="lib-list-row" key={p.name}>
                  <span className="lib-mono">{p.name}</span>
                  <span className="lib-list-meta">{p.type}</span>
                  {editable && p.name !== "variant" && (
                    <button className="button ghost lib-row-action" aria-label={`Remove prop ${p.name}`} onClick={() => edit({ kind: "removeProp", ui: part.ui, name: p.name }, `Removed prop ${p.name} from ${part.name}`)}>
                      Remove
                    </button>
                  )}
                </div>
              ))}
              {editable && adding !== "prop" && (
                <button className="button ghost lib-add" onClick={() => { setAdding("prop"); setNewName(""); }}>
                  + Add prop
                </button>
              )}
              {adding === "prop" && (
                <div className="lib-add-form">
                  <input className="text-input" autoFocus placeholder="Name" aria-label="Prop name" value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setAdding(null)} />
                  <Select<"text" | "boolean" | "choice"> value={newType} options={[{ value: "text", label: "Text" }, { value: "boolean", label: "On or off" }, { value: "choice", label: "Choice" }]} onChange={setNewType} ariaLabel="Prop type" />
                  {newType === "choice" && <input className="text-input" placeholder="Options, comma separated" aria-label="Options" value={newOptions} onChange={(e) => setNewOptions(e.target.value)} />}
                  <div className="lib-picker-actions">
                    <button className="button ghost" onClick={() => setAdding(null)}>
                      Cancel
                    </button>
                    <button className="button primary" disabled={!newName.trim() || (newType === "choice" && newOptions.split(",").filter((o) => o.trim()).length < 2)} onClick={addNow}>
                      Add
                    </button>
                  </div>
                </div>
              )}
            </div>
            {tab === "variants" && (
              <div className="lib-card">
                <div className="lib-card-label">States</div>
                {["Normal", "Hover", "Focus", "Disabled"].map((s) => (
                  <div className="lib-list-row" key={s}>
                    <span>{s}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </aside>
    </div>
  );
}
