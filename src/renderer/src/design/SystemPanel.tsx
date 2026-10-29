import { useEffect, useRef, useState, type ReactNode } from "react";
import type { DesignSystemDoc, DesignToken } from "../../../shared/types";
import { api } from "../api";
import { Markdown } from "../markdown";
import { useStore } from "../store";
import { ColorSwatch } from "./ColorSwatch";
import { contrastLabel, contrastRatio, groundFor, isColorToken, parseColor } from "./contrast";

/** The panel's token sections, in display order. */
type SectionKey = "colors" | "type" | "space" | "radius" | "shadows" | "other";
const SECTION_ORDER: SectionKey[] = ["colors", "type", "space", "radius", "shadows", "other"];
const SECTION_LABELS: Record<SectionKey, string> = {
  colors: "Colors",
  type: "Type",
  space: "Space",
  radius: "Radius",
  shadows: "Shadows",
  other: "Other",
};

type Scheme = "light" | "dark";
type JumpKey = SectionKey | "overview";

/** Which section a token belongs to, in precedence order (colour, then by name prefix, else Other). */
function sectionOf(token: DesignToken): SectionKey {
  if (isColorToken(token.name, token.light) && !token.name.startsWith("--shadow-")) return "colors";
  if (/^--(font|text|leading|weight)-/.test(token.name)) return "type";
  if (token.name.startsWith("--space-")) return "space";
  if (token.name.startsWith("--radius-")) return "radius";
  if (token.name.startsWith("--shadow-")) return "shadows";
  return "other";
}

/** The small preview beside a token's row: a font sample, a length bar, a radius box or a shadow box. */
function previewOf(section: SectionKey, name: string, value: string): ReactNode {
  if (name.startsWith("--font-")) return <span style={{ fontFamily: value, fontSize: 11.5 }} aria-hidden>Aa</span>;
  if (section === "shadows") return <span className="sys-shadow" style={{ boxShadow: value }} aria-hidden />;
  if (section === "radius") return <span className="sys-radius" style={{ borderRadius: value }} aria-hidden />;
  if (section === "space") return <span className="sys-space" style={{ width: `min(${value}, 96px)` }} aria-hidden />;
  return null;
}

/** The WCAG badge for an ink colour on its ground, or null when either side has no fixed value. */
function badgeFor(ink: string, ground: string | null): ReactNode {
  if (ground === null) return null;
  const a = parseColor(ink);
  const b = parseColor(ground);
  if (!a || !b) return null;
  const label = contrastLabel(contrastRatio(a, b));
  const title = label.pass === "aa" ? "WCAG AA" : label.pass === "large" ? "AA large text only" : "Fails WCAG AA";
  return (
    <span className={"sys-badge " + label.pass} title={title}>
      {label.pass === "fail" ? "✕" : "✓"} {label.text}
    </span>
  );
}

/** The IPC error message, with Electron's "Error invoking remote method …" wrapper stripped. */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err);
}

/**
 * The System tab: the thread's design system — its DESIGN.md and tokens.css. Tokens are grouped by role, each
 * editable inline; a colour row shows its light and dark values with a WCAG contrast badge. Edits go straight to
 * the file through the agent's IPC, so the canvas re-renders live.
 */
export function SystemPanel({ threadId, reloadKey }: { threadId: string; reloadKey: string }) {
  const [doc, setDoc] = useState<DesignSystemDoc | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingMd, setEditingMd] = useState(false);
  const [mdDraft, setMdDraft] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const sectionRefs = useRef<Partial<Record<JumpKey, HTMLElement | null>>>({});
  // The thread's chosen system: a pick in the composer's menu re-reads the panel.
  const systemId = useStore((s) => {
    for (const list of Object.values(s.threads)) {
      const t = list.find((x) => x.id === threadId);
      if (t) return t.designSystem ?? "";
    }
    return "";
  });

  // Reload on a new thread or a canvas reload; a stale response must never win. A canvas reload (after an edit here)
  // refreshes in place, so the scroll position and the focused field survive.
  const shownThread = useRef(threadId);
  useEffect(() => {
    let cancelled = false;
    if (shownThread.current !== threadId) {
      shownThread.current = threadId;
      setLoading(true);
      setDrafts({});
      setEditingMd(false);
    }
    void api()
      .designSystemDoc(threadId)
      .then((res) => {
        if (cancelled) return;
        setDoc(res);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(errorText(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [threadId, reloadKey, systemId]);

  if (loading) return <p className="design-inspector-empty">Loading…</p>;
  if (!doc) return <p className="design-inspector-empty">{error ?? "This thread has no design system."}</p>;

  const system = doc;
  const editable = system.editable;
  const fieldClass = "text-input sys-input";

  const tokens = system.groups.flatMap((g) => g.tokens);
  const byName = new Map(tokens.map((t) => [t.name, t]));
  const sections: Record<SectionKey, DesignToken[]> = { colors: [], type: [], space: [], radius: [], shadows: [], other: [] };
  for (const t of tokens) sections[sectionOf(t)].push(t);
  const hasOverview = system.designMd.trim().length > 0 || editable;
  const subline = system.copyOnWrite
    ? "Library style · your first edit saves a copy in .agents/design-systems/"
    : !editable
      ? "Read-only: open a project folder to customize it."
      : "Project copy · edits apply live";

  const keyOf = (name: string, scheme: Scheme): string => `${name}|${scheme}`;
  const setDraft = (key: string, value: string): void => setDrafts((s) => ({ ...s, [key]: value }));
  const dropDraft = (key: string): void =>
    setDrafts((s) => {
      if (!(key in s)) return s;
      const next = { ...s };
      delete next[key];
      return next;
    });
  const jumpTo = (key: JumpKey): void => sectionRefs.current[key]?.scrollIntoView({ block: "start" });

  // Commit one token value (the draft, or a value the colour picker hands over); on success the fresh doc replaces
  // it, on failure the draft reverts and the error shows.
  const commitToken = (token: DesignToken, scheme: Scheme, picked?: string): void => {
    const key = keyOf(token.name, scheme);
    const value = picked ?? drafts[key];
    if (value === undefined) return;
    const base = scheme === "dark" ? token.dark ?? token.light : token.light;
    if (value.trim() === base.trim()) {
      dropDraft(key);
      return;
    }
    void api()
      .designSystemEdit(threadId, { token: { name: token.name, scheme, value: value.trim() } })
      .then(({ doc: next, thread }) => {
        useStore.getState().apply({ type: "thread", thread });
        setDoc(next);
        setError(null);
        dropDraft(key);
      })
      .catch((err) => {
        setError(errorText(err));
        dropDraft(key);
      });
  };

  const saveMd = (): void => {
    void api()
      .designSystemEdit(threadId, { designMd: mdDraft })
      .then(({ doc: next, thread }) => {
        useStore.getState().apply({ type: "thread", thread });
        setDoc(next);
        setError(null);
        setEditingMd(false);
      })
      .catch((err) => setError(errorText(err)));
  };

  const input = (token: DesignToken, scheme: Scheme, key: string, shown: string): ReactNode => (
    <input
      className={fieldClass}
      value={shown}
      aria-label={token.name}
      spellCheck={false}
      readOnly={!editable}
      onChange={(e) => setDraft(key, e.target.value)}
      onBlur={() => commitToken(token, scheme)}
      onKeyDown={(e) => {
        if (e.key === "Enter") commitToken(token, scheme);
        else if (e.key === "Escape") dropDraft(key);
      }}
    />
  );

  // Light and Dark cells: the swatch, the value and, for ink tokens, the contrast badge.
  const colourCell = (token: DesignToken, scheme: Scheme): ReactNode => {
    const key = keyOf(token.name, scheme);
    const base = scheme === "dark" ? token.dark ?? token.light : token.light;
    const shown = drafts[key] ?? base;
    const groundName = groundFor(token.name);
    const ground = groundName ? byName.get(groundName) : undefined;
    const groundValue = ground ? (scheme === "dark" ? ground.dark ?? ground.light : ground.light) : null;
    const inherited = scheme === "dark" && token.dark === null;
    const label = token.name.replace(/^--color-/, "");
    return (
      <div key={scheme}>
        <ColorSwatch
          value={shown}
          label={`${label} ${scheme}`}
          disabled={!editable}
          onInput={(v) => setDraft(key, v)}
          onCommit={(v) => commitToken(token, scheme, v)}
        />
        <input
          className={fieldClass + (inherited ? " inherited" : "")}
          value={shown}
          aria-label={`${label} ${scheme}`}
          spellCheck={false}
          readOnly={!editable}
          onChange={(e) => setDraft(key, e.target.value)}
          onBlur={() => commitToken(token, scheme)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitToken(token, scheme);
            else if (e.key === "Escape") dropDraft(key);
          }}
        />
        {badgeFor(base, groundValue)}
      </div>
    );
  };

  const plainRow = (token: DesignToken, section: SectionKey): ReactNode => {
    const key = keyOf(token.name, "light");
    return (
      <div className="sys-row" key={token.name}>
        <span className="sys-name" title={token.name}>
          {token.name}
        </span>
        {previewOf(section, token.name, token.light)}
        {input(token, "light", key, drafts[key] ?? token.light)}
      </div>
    );
  };

  return (
    <>
      <div className="sys-head">
        <span className="sys-title" title={system.name}>
          {system.name}
        </span>
        <span className="sys-sub">{subline}</span>
      </div>
      {error && <p className="sys-error">{error}</p>}
      <div className="sys-jump">
        {hasOverview && (
          <button className="button ghost" onClick={() => jumpTo("overview")}>
            Overview
          </button>
        )}
        {SECTION_ORDER.filter((s) => sections[s].length > 0).map((s) => (
          <button className="button ghost" key={s} onClick={() => jumpTo(s)}>
            {SECTION_LABELS[s]}
          </button>
        ))}
      </div>
      {hasOverview && (
        <div className="design-inspector-group" ref={(el) => { sectionRefs.current.overview = el; }}>
          <h3>Overview</h3>
          {editingMd ? (
            <>
              <textarea
                className="text-input sys-md-edit"
                value={mdDraft}
                rows={16}
                spellCheck={false}
                aria-label="DESIGN.md"
                onChange={(e) => setMdDraft(e.target.value)}
              />
              <div className="sys-md-actions">
                <button className="button primary" onClick={saveMd}>
                  Save
                </button>
                <button className="button ghost" onClick={() => setEditingMd(false)}>
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="sys-md">
                <Markdown text={system.designMd} />
              </div>
              {editable && (
                <button
                  className="button ghost"
                  onClick={() => {
                    setMdDraft(system.designMd);
                    setEditingMd(true);
                  }}
                >
                  Edit
                </button>
              )}
            </>
          )}
        </div>
      )}
      {SECTION_ORDER.map((s) =>
        sections[s].length === 0 ? null : (
          <div className="design-inspector-group" key={s} ref={(el) => { sectionRefs.current[s] = el; }}>
            <h3>{SECTION_LABELS[s]}</h3>
            {s === "colors"
              ? sections.colors.map((t) => (
                  <div className="sys-color" key={t.name}>
                    <span className="sys-name" title={t.name}>
                      {t.name.replace(/^--color-/, "")}
                    </span>
                    <div className="sys-color-cells">
                      {colourCell(t, "light")}
                      {colourCell(t, "dark")}
                    </div>
                  </div>
                ))
              : sections[s].map((t) => plainRow(t, s))}
          </div>
        ),
      )}
    </>
  );
}
