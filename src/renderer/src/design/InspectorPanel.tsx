import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Copy } from "lucide-react";
import { elementLabel, type SelectedElement } from "../../../shared/selection";
import { api } from "../api";
import { Select } from "../components/Select";
import { ColorSwatch } from "./ColorSwatch";
import { highlight, langOf } from "./highlight";
import { SystemPanel } from "./SystemPanel";

// The inspector's rows, in display order. The keys match STYLE_KEYS in shared/selection.ts.
const SIZE_FIELDS = ["width", "height"];
const LAYOUT_FIELDS = ["display", "flexDirection", "justifyContent", "alignItems", "gap"];
const PADDING_FIELDS = ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"];
const TYPE_FIELDS = ["fontSize", "fontWeight", "lineHeight", "letterSpacing", "color"];
const APPEARANCE_FIELDS = ["backgroundColor", "borderRadius", "borderWidth", "borderColor", "opacity", "boxShadow"];
const ALL_FIELDS = [...SIZE_FIELDS, ...LAYOUT_FIELDS, ...PADDING_FIELDS, ...TYPE_FIELDS, ...APPEARANCE_FIELDS];
const COLOUR_FIELDS = new Set(["color", "backgroundColor", "borderColor"]);
const PAD_LABEL: Record<string, string> = { paddingTop: "T", paddingRight: "R", paddingBottom: "B", paddingLeft: "L" };

/** How a box is sized on one axis: by its content, by its parent, or by a fixed length. */
export type SizeMode = "hug" | "fill" | "fixed";
const SIZE_VALUE: Record<Exclude<SizeMode, "fixed">, string> = { hug: "fit-content", fill: "100%" };

/** The sizing mode a width or height value stands for; anything that isn't Hug or Fill is Fixed. */
export function sizeModeOf(value: string): SizeMode {
  const v = value.trim();
  return v === "fit-content" || v === "max-content" ? "hug" : v === "100%" ? "fill" : "fixed";
}

/** `flexDirection` → `Flex direction`; `backgroundColor` → `Background color`. */
function propLabel(prop: string): string {
  return prop.replace(/([A-Z])/g, (c) => ` ${c.toLowerCase()}`).replace(/^./, (c) => c.toUpperCase());
}

/**
 * Design mode's inspector: the selected element's computed style, editable with a live preview in the frame, the
 * page's layers, its own code and its tweaks. Apply hands the edits to the canvas, which writes them into the page
 * (`writes`: Working and Real app tiers, an element with a data-agent-id) or turns them into a message for the agent.
 */
export type InspectorTab = "properties" | "elements" | "code" | "system" | "tweaks";

export function InspectorPanel({
  threadId,
  tab: tabProp,
  onTab,
  element,
  pageRel,
  designDir,
  reloadKey,
  onPreview,
  onClearPreview,
  onApply,
  writes,
  elements,
  tweaks,
}: {
  threadId: string;
  /** The open tab, when the canvas holds it (its DESIGN.md button opens System); otherwise the panel keeps its own. */
  tab?: InspectorTab;
  onTab?: (tab: InspectorTab) => void;
  element: SelectedElement | null;
  pageRel: string;
  designDir: string;
  reloadKey: string;
  onPreview: (prop: string, value: string) => void;
  onClearPreview: () => void;
  onApply: (changes: { prop: string; from: string; to: string }[]) => void;
  /** True when Apply writes into the page file; false when it drafts a message. */
  writes: boolean;
  /** The Elements tab's layer tree, or null when the Layers rail already shows it (no tab then). */
  elements: ReactNode | null;
  /** The Tweaks tab's controls, or null when the page has none (or the tier has no tweaks). */
  tweaks: ReactNode | null;
}) {
  const [ownTab, setOwnTab] = useState<InspectorTab>("properties");
  const tab = tabProp ?? ownTab;
  const setTab = onTab ?? setOwnTab;
  const shownTab = (tab === "tweaks" && !tweaks) || (tab === "elements" && !elements) ? "properties" : tab;
  // The user's edits, keyed by prop; an absent key means "still the original".
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [code, setCode] = useState<string | null>(null);
  const [files, setFiles] = useState<string[]>([]);
  const [file, setFile] = useState(pageRel);

  // A different element starts with a clean slate, and the old one's preview comes off the page.
  const selector = element?.selector ?? "";
  useEffect(() => {
    setEdits({});
    onClearPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on a new element, not on a new callback
  }, [selector]);

  // A new page becomes the Code tab's current file again.
  useEffect(() => {
    setFile(pageRel);
  }, [pageRel]);

  // The design folder's files, for the picker; a new page or reload refreshes them.
  useEffect(() => {
    let live = true;
    void api()
      .designFiles(threadId)
      .then((res) => live && setFiles(res))
      .catch(() => live && setFiles([]));
    return () => {
      live = false;
    };
  }, [threadId, designDir, reloadKey]);

  // The chosen file's own source, reloaded whenever the file or the folder changes.
  useEffect(() => {
    let live = true;
    void api()
      .readArtifact(threadId, `${designDir}/${file}`)
      .then((res) => live && setCode(res.ok && typeof res.text === "string" ? res.text : null))
      .catch(() => live && setCode(null));
    return () => {
      live = false;
    };
  }, [threadId, designDir, file, reloadKey]);

  const tokens = useMemo(() => (code === null ? [] : highlight(code, langOf(file))), [code, file]);
  const lineCount = useMemo(() => (code === null ? 0 : code.split("\n").length), [code]);

  const original = (prop: string): string => element?.style?.[prop] ?? "";
  const changed = (prop: string): boolean => edits[prop] !== undefined && edits[prop] !== original(prop);
  const dirty = ALL_FIELDS.some(changed);

  const input = (prop: string, value: string): void => {
    setEdits((s) => ({ ...s, [prop]: value }));
    onPreview(prop, value);
  };
  const resetEdits = (): void => {
    setEdits({});
    onClearPreview();
  };
  const apply = (): void => {
    const changes = ALL_FIELDS.filter(changed).map((prop) => ({ prop, from: original(prop), to: edits[prop]! }));
    if (!changes.length) return;
    onApply(changes);
    setEdits({});
  };

  const row = (prop: string) => <PropRow key={prop} prop={prop} value={edits[prop] ?? original(prop)} changed={changed(prop)} onInput={input} />;
  // Width and height get a Hug | Fill | Fixed switch over their value; Fixed goes back to the measured length.
  const sizeRow = (prop: string) => {
    const mode = sizeModeOf(edits[prop] ?? original(prop));
    const pick = (next: SizeMode) => input(prop, next === "fixed" ? (sizeModeOf(original(prop)) === "fixed" ? original(prop) : `${Math.round(prop === "width" ? element!.rect.width : element!.rect.height)}px`) : SIZE_VALUE[next]);
    return (
      <div key={prop} className="design-inspector-size">
        <div className="segmented design-inspector-sizing" role="group" aria-label={`${propLabel(prop)} sizing`}>
          {(["hug", "fill", "fixed"] as const).map((m) => (
            <button key={m} aria-pressed={mode === m} className={mode === m ? "on" : ""} onClick={() => pick(m)}>
              {m === "hug" ? "Hug" : m === "fill" ? "Fill" : "Fixed"}
            </button>
          ))}
        </div>
        {row(prop)}
      </div>
    );
  };
  const tabButton = (id: typeof tab, label: string) => (
    <button role="tab" aria-selected={shownTab === id} className={shownTab === id ? "on" : ""} onClick={() => setTab(id)}>
      {label}
    </button>
  );

  return (
    <aside className="design-inspector" aria-label="Inspector">
      <div className="design-inspector-tabs">
        <div className="segmented" role="tablist">
          {tabButton("properties", "Properties")}
          {elements && tabButton("elements", "Elements")}
          {tabButton("code", "Code")}
          {tabButton("system", "System")}
          {tweaks && tabButton("tweaks", "Tweaks")}
        </div>
      </div>
      {shownTab === "system" ? (
        <SystemPanel threadId={threadId} reloadKey={reloadKey} />
      ) : shownTab === "elements" ? (
        elements
      ) : shownTab === "tweaks" ? (
        tweaks
      ) : shownTab === "properties" ? (
        !element ? (
          <p className="design-inspector-empty">Pick an element on the canvas to inspect it.</p>
        ) : (
          <>
            <div className="design-inspector-head">
              <span className="design-inspector-tag">&lt;{element.tag}&gt;</span>
              <span className="design-inspector-label" title={element.selector}>
                {element.id ?? elementLabel(element)}
              </span>
            </div>
            <Group title="Size">{SIZE_FIELDS.map(sizeRow)}</Group>
            <Group title="Layout">
              {LAYOUT_FIELDS.map(row)}
              <div className="design-inspector-row">
                <span className="design-inspector-row-label">Padding</span>
                <div className="design-inspector-pad">
                  {PADDING_FIELDS.map((p) => (
                    <label key={p}>
                      <span>{PAD_LABEL[p]}</span>
                      <input
                        className="text-input"
                        value={edits[p] ?? original(p)}
                        aria-label={propLabel(p)}
                        spellCheck={false}
                        onChange={(e) => input(p, e.target.value)}
                      />
                    </label>
                  ))}
                </div>
                {PADDING_FIELDS.some(changed) && <span className="design-inspector-dot" aria-hidden />}
              </div>
            </Group>
            <Group title="Type">{TYPE_FIELDS.map(row)}</Group>
            <Group title="Appearance">{APPEARANCE_FIELDS.map(row)}</Group>
          </>
        )
      ) : code !== null ? (
        <>
          <div className="design-inspector-code-head">
            {files.length > 1 ? (
              <Select<string> value={file} options={files.map((f) => ({ value: f, label: f }))} onChange={setFile} ariaLabel="File" className="ghost-select" />
            ) : (
              <span className="design-inspector-code-path" title={`${designDir}/${file}`}>
                {file}
              </span>
            )}
            <button className="button ghost" onClick={() => void navigator.clipboard?.writeText(code)}>
              <Copy size={14} strokeWidth={1.75} aria-hidden />
              Copy
            </button>
          </div>
          <div className="design-inspector-code-scroll">
            <div className="design-inspector-gutter" aria-hidden="true">
              {Array.from({ length: lineCount }, (_, i) => (
                <div key={i}>{i + 1}</div>
              ))}
            </div>
            <pre className="design-inspector-code">
              {tokens.map((t, i) => (t.kind === "plain" ? t.text : <span key={i} className={`syn-${t.kind}`}>{t.text}</span>))}
            </pre>
          </div>
        </>
      ) : (
        <p className="design-inspector-empty">Can't show this file.</p>
      )}
      {shownTab === "properties" && element && (
        <div className="design-inspector-foot">
          <span className="design-inspector-hint">{writes ? "Writes into the page" : element.id ? "Drafts a message" : "No data-agent-id: drafts a message"}</span>
          <span className="grow" />
          <button className="button ghost" onClick={resetEdits} disabled={!dirty}>
            Reset
          </button>
          <button
            className="button primary"
            onClick={apply}
            disabled={!dirty}
            title={writes ? "Write these styles into the page" : "Put these changes in the composer for the agent"}
          >
            Apply
          </button>
        </div>
      )}
    </aside>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="design-inspector-group">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

/** One property row: its label, a colour picker for colours, a mono text input and a dot while it differs from the page. */
function PropRow({ prop, value, changed, onInput }: { prop: string; value: string; changed: boolean; onInput: (prop: string, value: string) => void }) {
  return (
    <div className="design-inspector-row">
      <span className="design-inspector-row-label">{propLabel(prop)}</span>
      {COLOUR_FIELDS.has(prop) && <ColorSwatch value={value} label={propLabel(prop)} onInput={(v) => onInput(prop, v)} />}
      <input className="text-input" value={value} aria-label={propLabel(prop)} spellCheck={false} onChange={(e) => onInput(prop, e.target.value)} />
      {changed && <span className="design-inspector-dot" aria-hidden />}
    </div>
  );
}
