import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ChevronDown, Code2, Columns3, Diamond, LayoutGrid, Rows3, ToggleLeft, Type } from "lucide-react";
import { elementLabel, type SelectedElement } from "../../../shared/selection";
import { api } from "../api";
import { Select } from "../components/Select";
import { IconClose } from "../icons";
import { ColorSwatch } from "./ColorSwatch";
import { RETAG_TAGS } from "../../../shared/design-mutation";
import { colourTokenOf, colourTokens, inlineStyle, optionLabel, scaleChanges, scaleStepOf, sizeMeta, textVariantProp, typeScale, type ColourToken } from "./text-styles";
import { flowChanges, flowOf, gapSteps, lineOf, startAttrs, startTagOf, wrapShapes, type AttrChange, type Flow, type KitPart, type WrapShape } from "./kit-parts";

/** The page tokens the panel reads and writes. A page without one just doesn't show its control. */
export const THEME_TOKENS = ["--color-accent", "--color-bg", "--color-surface", "--color-surface-2", "--color-text-muted", "--color-border", "--radius-sm", "--radius-md", "--radius-lg", "--radius-xl"];

const PAGE_COLOURS: { token: string; label: string }[] = [
  { token: "--color-accent", label: "Accent" },
  { token: "--color-bg", label: "Canvas" },
  { token: "--color-surface", label: "Surface" },
];
const SYSTEM_SWATCHES: { token: string; label: string }[] = [
  { token: "--color-accent", label: "Primary" },
  { token: "--color-surface", label: "Surface" },
  { token: "--color-surface-2", label: "Subtle" },
  { token: "--color-text-muted", label: "Muted" },
];
const PAGE_CORNERS: { label: string; values: Record<string, string> }[] = [
  { label: "Sharp", values: { "--radius-sm": "0px", "--radius-md": "0px", "--radius-lg": "0px", "--radius-xl": "0px" } },
  { label: "Soft", values: { "--radius-sm": "4px", "--radius-md": "6px", "--radius-lg": "8px", "--radius-xl": "12px" } },
  { label: "Round", values: { "--radius-sm": "8px", "--radius-md": "12px", "--radius-lg": "16px", "--radius-xl": "24px" } },
  { label: "Pill", values: { "--radius-sm": "999px", "--radius-md": "999px", "--radius-lg": "999px", "--radius-xl": "999px" } },
];
const TEXT_SIZES = [
  { label: "S", value: "12px" },
  { label: "M", value: "14px" },
  { label: "L", value: "18px" },
  { label: "XL", value: "24px" },
];
const PADDINGS = [
  { label: "Tight", value: "4px 8px" },
  { label: "Normal", value: "8px 16px" },
  { label: "Roomy", value: "12px 24px" },
];
const CORNERS = [
  { label: "Sharp", value: "0px" },
  { label: "Soft", value: "6px" },
  { label: "Round", value: "12px" },
  { label: "Pill", value: "999px" },
];
/** Every inline style the panel may write, so `Reset overrides` takes back exactly those. */
const OWN_STYLES = ["background-color", "color", "border-color", "font-size", "line-height", "padding", "border-radius"];

/** A kit's declared prop: its options (the first is the default), or none for an on or off one. */
interface KitProp {
  name: string;
  /** `choice`, `boolean` or `text`, from the kit's components.json. */
  type?: string;
  label?: string;
  options?: string[] | null;
}

/** A prop row's lead icon, by the prop's type. */
const PROP_ICONS: Record<string, typeof Diamond> = { choice: Diamond, boolean: ToggleLeft, text: Type };

/** An attribute's value in an element's start tag, or null. `html` comes from the page, so this only reads it. */
export function attrOf(html: string, name: string): string | null {
  const tag = /^<[^>]*>/.exec(html)?.[0] ?? "";
  const m = new RegExp(`\\s${name}(?:\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+)))?(?=[\\s/>])`, "i").exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : null;
}

const canHoldText = (el: SelectedElement): boolean => !/^(input|select|textarea|img|svg)$/.test(el.tag) && Boolean(el.ownText);
const isField = (el: SelectedElement): boolean => el.tag === "input" || el.tag === "textarea";
const canDisable = (el: SelectedElement): boolean => /^(button|input|select|textarea)$/.test(el.tag);

/** A short name for the header: the kit part's name, else the element's own. */
function displayName(el: SelectedElement): string {
  const ui = attrOf(el.html, "data-ui");
  if (!ui) return elementLabel(el);
  const name = ui.replace(/(^|-)(\w)/g, (_, dash: string, c: string) => `${dash ? " " : ""}${c.toUpperCase()}`);
  const text = el.ownText || el.text;
  return text ? `${name} "${text.slice(0, 24)}"` : name;
}

export interface CustomizeHandlers {
  /** Change inline styles on an element (the page's root for page tokens). Previewed at once, then saved. */
  onStyle: (el: SelectedElement | null, changes: { prop: string; value: string }[], key: string) => void;
  onAttr: (el: SelectedElement, name: string, value: string | null) => void;
  onText: (el: SelectedElement, value: string) => void;
  /** Render as: change a text element's tag. */
  onRetag?: (el: SelectedElement, tag: string) => void;
  /** Several attributes as one undo step (the Layout card). */
  onAttrs: (el: SelectedElement, changes: AttrChange[], key: string) => void;
}

/**
 * Design v2's right panel, never empty: the page's theme when nothing is selected, the element's style when something
 * is. There's no Apply: every control previews on the next frame and saves itself, and ⌘Z takes it back.
 */
export function CustomizePanel({
  threadId,
  designDir,
  pageRel = "index.html",
  reloadKey,
  element,
  readOnly,
  styleName,
  theme,
  appearance,
  onAppearance,
  onClear,
  onViewHtml,
  tweaks,
  handlers,
  selection = [],
  parts = [],
  onDeselect,
  onWrap,
  onCode,
  onSwitchStyle,
  overrides = 0,
  onSaveTheme,
}: {
  threadId: string;
  designDir: string;
  pageRel?: string;
  reloadKey: string;
  element: SelectedElement | null;
  /** An agent turn is writing this page. */
  readOnly: boolean;
  styleName: string | null;
  /** The page's own values for THEME_TOKENS. */
  theme: Record<string, string>;
  appearance: "light" | "dark";
  onAppearance: (next: "light" | "dark") => void;
  onClear: () => void;
  onViewHtml: () => void;
  tweaks: ReactNode | null;
  handlers: CustomizeHandlers;
  /** Everything selected: more than one shows the `N selected` panel. */
  selection?: SelectedElement[];
  parts?: KitPart[];
  onDeselect?: (el: SelectedElement) => void;
  onWrap?: (shape: WrapShape) => void;
  /** Open the Code view at this element. */
  onCode?: (el: SelectedElement) => void;
  /** Open the style picker. */
  onSwitchStyle?: () => void;
  /** How many tokens this page overrides, and how to keep them: offered once there's something to keep. */
  overrides?: number;
  onSaveTheme?: () => void;
}) {
  const [kitProps, setKitProps] = useState<Record<string, KitProp[]>>({});
  const [filter, setFilter] = useState("");

  // A kit thread's parts and their props; a flat style has no manifest, and the element card just has fewer rows.
  useEffect(() => {
    let live = true;
    void api()
      .readArtifact(threadId, `${designDir}/system/components.json`)
      .then((res) => {
        if (!live) return;
        const parsed = res.ok && typeof res.text === "string" ? (JSON.parse(res.text) as { components?: { ui?: string; props?: KitProp[] }[] }) : null;
        const next: Record<string, KitProp[]> = {};
        for (const c of parsed?.components ?? []) if (c.ui) next[c.ui] = c.props ?? [];
        setKitProps(next);
      })
      .catch(() => live && setKitProps({}));
    return () => {
      live = false;
    };
  }, [threadId, designDir, reloadKey]);

  const selector = element?.selector ?? "";
  useEffect(() => setFilter(""), [selector]);

  const swatches = useMemo(() => SYSTEM_SWATCHES.filter((s) => theme[s.token]), [theme]);

  if (selection.length > 1) {
    return (
      <aside className="design-inspector design-customize" aria-label="Customize">
        <div className="design-customize-head">
          <h2 className="design-customize-title">{selection.length} selected</h2>
          <button className="icon-button" aria-label="Clear selection" title="Clear selection" onClick={onClear}>
            <IconClose />
          </button>
        </div>
        <fieldset className="design-customize-fields" disabled={readOnly}>
          <Card title="Items">
            {selection.map((s) => (
              <label key={s.selector} className="design-customize-check" title={s.selector}>
                <input type="checkbox" checked onChange={() => onDeselect?.(s)} />
                <span>{displayName(s)}</span>
              </label>
            ))}
            <p className="design-customize-help">Shift-click on the canvas or in Layers to add or remove an item.</p>
          </Card>
          <Card title="Wrap">
            <div className="design-customize-wraps">
              {wrapShapes(parts).map((s) => (
                <button key={s} className="button ghost" onClick={() => onWrap?.(s)}>
                  {s === "grid" ? `Wrap ${selection.length} in Grid` : `Wrap in ${s[0]!.toUpperCase()}${s.slice(1)}`}
                </button>
              ))}
            </div>
          </Card>
        </fieldset>
      </aside>
    );
  }

  if (!element) {
    const corners = PAGE_CORNERS.find((c) => Object.entries(c.values).every(([k, v]) => !theme[k] || theme[k] === v))?.label ?? null;
    return (
      <aside className="design-inspector design-customize" aria-label="Customize">
        <div className="design-customize-head">
          <h2 className="design-customize-title">Page Theme</h2>
        </div>
        {readOnly && <p className="design-customize-note">Design in progress. Controls return when the turn ends.</p>}
        <fieldset className="design-customize-fields" disabled={readOnly}>
          <Card title="Style">
            <div className="design-customize-style">
              <span className="design-customize-style-name">{styleName ?? "Auto"}</span>
              <span className="design-customize-chips" aria-hidden>
                {PAGE_COLOURS.concat(swatches.slice(3)).map((c) => theme[c.token] && <span key={c.token} className="design-inspector-swatch" style={{ background: theme[c.token] }} />)}
              </span>
            </div>
            {onSwitchStyle && (
              <button type="button" className="button ghost design-customize-switch" onClick={onSwitchStyle}>
                Switch style…
              </button>
            )}
            {overrides > 0 && onSaveTheme && (
              <button type="button" className="button ghost design-customize-switch" onClick={onSaveTheme} title={`Keep this page's ${overrides} changed value${overrides === 1 ? "" : "s"} as a theme in this project`}>
                Save as new theme…
              </button>
            )}
          </Card>
          <Card title="Appearance">
            <Segments label="Appearance" options={[{ label: "Light", value: "light" }, { label: "Dark", value: "dark" }]} value={appearance} onPick={(v) => onAppearance(v as "light" | "dark")} />
          </Card>
          {PAGE_COLOURS.some((c) => theme[c.token]) && (
            <Card title="Colours">
              {PAGE_COLOURS.filter((c) => theme[c.token]).map((c) => (
                <Row key={c.token} label={c.label}>
                  <ColorSwatch value={theme[c.token]!} label={c.label} disabled={readOnly} onInput={(value) => handlers.onStyle(null, [{ prop: c.token, value }], `page:${c.token}`)} />
                  <span className="design-customize-value">{theme[c.token]}</span>
                </Row>
              ))}
            </Card>
          )}
          {PAGE_CORNERS[0] && Object.keys(PAGE_CORNERS[0].values).some((k) => theme[k]) && (
            <Card title="Corners">
              <Segments
                label="Corner style"
                options={PAGE_CORNERS.map((c) => ({ label: c.label, value: c.label }))}
                value={corners}
                onPick={(picked) => {
                  const values = PAGE_CORNERS.find((c) => c.label === picked)?.values ?? {};
                  handlers.onStyle(null, Object.entries(values).filter(([k]) => theme[k]).map(([prop, value]) => ({ prop, value })), "page:corners");
                }}
              />
            </Card>
          )}
          {tweaks && <Card title="Page Tweaks">{tweaks}</Card>}
        </fieldset>
      </aside>
    );
  }

  const el = element;
  const style = el.style ?? {};
  const ui = attrOf(el.html, "data-ui");
  const props = ui ? (kitProps[ui] ?? []) : [];
  const q = filter.trim().toLowerCase();
  const shows = (...terms: string[]): boolean => q === "" || terms.some((t) => t.toLowerCase().includes(q));
  const setStyle = (prop: string, value: string) => handlers.onStyle(el, [{ prop, value }], `${el.selector}:${prop}`);
  const colours = [
    { label: "Fill", prop: "background-color", computed: style.backgroundColor ?? "" },
    { label: "Text", prop: "color", computed: style.color ?? "" },
    { label: "Border", prop: "border-color", computed: style.borderColor ?? "" },
  ];
  const inline = attrOf(el.html, "style") ?? undefined;
  const tokenList = colourTokens(theme);
  const scale = typeScale(theme);
  const variantProp = textVariantProp(ui, props);
  const retaggable = (RETAG_TAGS as readonly string[]).includes(el.tag);
  // A text element: a kit text part, or plain text in a text tag. It gets the Text card instead of pixel sizes.
  const isText = canHoldText(el) && (variantProp !== null || retaggable);
  // A text part's own colour prop (`text-secondary`) is its Color, so the Component card doesn't repeat it.
  const colourProp = variantProp ? (props.find((p) => (p.name === "color" || p.name === "tone") && p.options?.length) ?? null) : null;
  // The Layout card already has these on a stack or grid.
  const inLayoutCard = flowOf(startAttrs(el.html)) ? ["direction", "gap", "align", "columns"] : [];
  const propRows = props.filter((p) => p.name !== "disabled" && p.name !== variantProp?.name && p.name !== colourProp?.name && !inLayoutCard.includes(p.name) && shows(p.name, ...(p.options ?? [])));
  const scaleNow = scaleStepOf(scale, inlineStyle(inline, "font-size"), style.fontSize);
  return (
    <aside className="design-inspector design-customize" aria-label="Customize">
      <div className="design-customize-head">
        <button className="icon-button" aria-label="Back to Page Theme" title="Page Theme" onClick={onClear}>
          <ArrowLeft size={16} strokeWidth={1.75} aria-hidden />
        </button>
        <h2 className="design-customize-title" title={el.selector}>
          {displayName(el)}
        </h2>
        <button className="icon-button" aria-label="Clear selection" title="Clear selection" onClick={onClear}>
          <IconClose />
        </button>
      </div>
      {readOnly && <p className="design-customize-note">Design in progress. Controls return when the turn ends.</p>}
      <div className="design-customize-filter">
        <input className="text-input" type="search" placeholder="Filter props and values" aria-label="Filter props and values" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <fieldset className="design-customize-fields" disabled={readOnly}>
        {(canHoldText(el) || isField(el)) && shows("content", "value", "placeholder", "text") && (
          <Card title="Content">
            {canHoldText(el) && (
              <Row label="Value">
                <input className="text-input" key={`v-${el.selector}`} aria-label="Value" defaultValue={el.ownText} onChange={(e) => handlers.onText(el, e.target.value)} />
              </Row>
            )}
            {isField(el) && (
              <>
                <Row label="Value">
                  <input className="text-input" key={`fv-${el.selector}`} aria-label="Value" defaultValue={attrOf(el.html, "value") ?? ""} onChange={(e) => handlers.onAttr(el, "value", e.target.value)} />
                </Row>
                <Row label="Placeholder">
                  <input className="text-input" key={`fp-${el.selector}`} aria-label="Placeholder" defaultValue={attrOf(el.html, "placeholder") ?? ""} onChange={(e) => handlers.onAttr(el, "placeholder", e.target.value || null)} />
                </Row>
              </>
            )}
          </Card>
        )}
        {propRows.length > 0 && (
          <Card title="Component">
            {propRows.map((p) => {
              const name = `data-${p.name}`;
              const current = attrOf(el.html, name);
              const options = p.options ?? null;
              const type = p.type ?? (options ? "choice" : "boolean");
              const label = p.label || p.name.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
              return (
                <Row key={p.name} label={label} stacked={type !== "boolean"} icon={PROP_ICONS[type]} onReset={current !== null ? () => handlers.onAttr(el, name, null) : undefined}>
                  {type === "text" ? (
                    <input className="text-input" key={`p-${el.selector}-${p.name}`} aria-label={label} defaultValue={current ?? ""} onChange={(e) => handlers.onAttr(el, name, e.target.value || null)} />
                  ) : options && options.length > 4 ? (
                    <Select<string> value={current ?? options[0] ?? ""} options={options.map((o) => ({ value: o, label: o }))} onChange={(v) => handlers.onAttr(el, name, v === options[0] ? null : v)} ariaLabel={label} className="ghost-select" />
                  ) : options ? (
                    <Segments label={label} options={options.map((o) => ({ label: o, value: o }))} value={current ?? options[0] ?? null} onPick={(v) => handlers.onAttr(el, name, v === options[0] ? null : v)} />
                  ) : (
                    <Toggle label={label} on={current !== null && current !== "false"} onChange={(on) => handlers.onAttr(el, name, on ? "true" : null)} />
                  )}
                </Row>
              );
            })}
          </Card>
        )}
        {flowOf(startAttrs(el.html)) && shows("layout", "flow", "gap", "columns", "align") && <LayoutCard el={el} parts={parts} handlers={handlers} />}
        {isText && shows("text", "render", "variant", "color", "tag", "type") && (
          <Card title="Text">
            {retaggable && handlers.onRetag && (
              <Row label="Render as" stacked>
                <Select<string> value={el.tag} options={RETAG_TAGS.map((t) => ({ value: t, label: t }))} onChange={(t) => handlers.onRetag?.(el, t)} ariaLabel="Render as" className="ghost-select block mono-select" />
              </Row>
            )}
            {variantProp ? (
              <Row label="Variant" stacked>
                <Select<string>
                  value={attrOf(el.html, `data-${variantProp.name}`) ?? variantProp.options[0] ?? ""}
                  options={variantProp.options.map((o) => {
                    const on = (attrOf(el.html, `data-${variantProp.name}`) ?? variantProp.options[0]) === o;
                    return { value: o, label: optionLabel(variantProp.name, o), lead: <TypeSample />, meta: on ? sizeMeta(style) : undefined };
                  })}
                  onChange={(v) => handlers.onAttr(el, `data-${variantProp.name}`, v === variantProp.options[0] ? null : v)}
                  ariaLabel="Variant"
                  className="ghost-select block"
                />
              </Row>
            ) : scale.length > 0 ? (
              <Row label="Variant" stacked>
                <Select<string>
                  value={scaleNow ?? ""}
                  options={[...(scaleNow ? [] : [{ value: "", label: "Custom", lead: <TypeSample />, meta: sizeMeta(style) }]), ...scale.map((st) => ({ value: st.id, label: st.label, lead: <TypeSample />, meta: st.meta }))]}
                  onChange={(id) =>
                    id &&
                    handlers.onStyle(el, scaleChanges(id, theme), `${el.selector}:type`)
                  }
                  ariaLabel="Variant"
                  className="ghost-select block"
                />
              </Row>
            ) : null}
            {colourProp?.options ? (
              <Row label="Color" stacked>
                <Select<string>
                  value={attrOf(el.html, `data-${colourProp.name}`) ?? colourProp.options[0] ?? ""}
                  options={colourProp.options.map((o) => ({ value: o, label: o, lead: theme[`--color-${o}`] ? <span className="design-token-dot" style={{ background: theme[`--color-${o}`] }} aria-hidden /> : undefined }))}
                  onChange={(v) => handlers.onAttr(el, `data-${colourProp.name}`, v === colourProp.options![0] ? null : v)}
                  ariaLabel="Color"
                  className="ghost-select block mono-select"
                />
              </Row>
            ) : tokenList.length > 0 && (
              <Row label="Color" stacked>
                <TokenSelect label="Color" tokens={tokenList} value={colourTokenOf(tokenList, "color", inlineStyle(inline, "color"), style.color)} computed={style.color ?? ""} onPick={(token) => setStyle("color", `var(${token})`)} />
              </Row>
            )}
          </Card>
        )}
        {canDisable(el) && shows("state", "disabled") && (
          <Card title="State">
            <Row label="Disabled">
              <Toggle label="Disabled" on={attrOf(el.html, "disabled") !== null} onChange={(on) => handlers.onAttr(el, "disabled", on ? "" : null)} />
            </Row>
          </Card>
        )}
        {shows("colours", "colors", "fill", "text", "border") && (
          <Card title="Colours">
            {colours.filter((c) => !(isText && c.prop === "color")).map((c) => (
              <Row key={c.prop} label={c.label}>
                {tokenList.length > 0 ? (
                  <TokenSelect label={c.label} tokens={tokenList} value={colourTokenOf(tokenList, c.prop, inlineStyle(inline, c.prop), c.computed)} computed={c.computed} onPick={(token) => setStyle(c.prop, `var(${token})`)} />
                ) : (
                  <span className="design-customize-tokens">
                    {swatches.map((s) => (
                      <button key={s.token} className="design-customize-token" style={{ background: theme[s.token] }} aria-label={`${c.label}: ${s.label}`} title={s.label} onClick={() => setStyle(c.prop, `var(${s.token})`)} />
                    ))}
                  </span>
                )}
                <ColorSwatch value={c.computed} label={`${c.label}, custom`} disabled={readOnly} onInput={(value) => setStyle(c.prop, value)} />
              </Row>
            ))}
          </Card>
        )}
        {shows("text", "spacing", "padding", "corners", "size") && (
          <Card title="Text & Spacing">
            {!isText && (
              <Row label="Text size" stacked>
                <Segments label="Text size" options={TEXT_SIZES} value={TEXT_SIZES.find((t) => t.value === style.fontSize)?.value ?? null} onPick={(v) => setStyle("font-size", v)} />
              </Row>
            )}
            <Row label="Padding" stacked>
              <Segments label="Padding" options={PADDINGS} value={null} onPick={(v) => setStyle("padding", v)} />
            </Row>
            <Row label="Corners" stacked>
              <Segments label="Corners" options={CORNERS} value={CORNERS.find((c) => c.value === style.borderRadius)?.value ?? null} onPick={(v) => setStyle("border-radius", v)} />
            </Row>
          </Card>
        )}
        <div className="design-customize-foot">
          <button className="link-button" onClick={onViewHtml}>
            View HTML
          </button>
          <button
            className="link-button"
            title="Take back this panel's colour, text, spacing and corner changes"
            onClick={() => handlers.onStyle(el, OWN_STYLES.map((prop) => ({ prop, value: "" })), `${el.selector}:reset`)}
          >
            Reset overrides
          </button>
        </div>
      </fieldset>
      <SourceRow threadId={threadId} designDir={designDir} page={pageRel} reloadKey={reloadKey} el={el} onCode={onCode} />
    </aside>
  );
}

const FLOWS: { value: Flow; label: string; Icon: typeof Rows3 }[] = [
  { value: "column", label: "Column", Icon: Rows3 },
  { value: "row", label: "Row", Icon: Columns3 },
  { value: "grid", label: "Grid", Icon: LayoutGrid },
];
const ALIGNS = ["start", "center", "end", "stretch"];

/**
 * Stack and Grid: Flow changes the component, not just its CSS, and each flow keeps its last values. Gap writes the
 * kit's token name.
 */
function LayoutCard({ el, parts, handlers }: { el: SelectedElement; parts: KitPart[]; handlers: CustomizeHandlers }) {
  const attrs = startAttrs(el.html);
  const flow = flowOf(attrs);
  const memory = useRef<Record<string, Partial<Record<string, string>>>>({});
  if (!flow) return null;
  const part = parts.find((p) => p.ui === attrs["data-ui"]) ?? null;
  const stackPart = parts.find((p) => p.ui === "stack") ?? part;
  const gridPart = parts.find((p) => p.ui === "grid") ?? part;
  const gaps = gapSteps(flow === "grid" ? gridPart : stackPart);
  const gapName = attrs["data-gap"] ?? gaps.find((g) => g === "md") ?? gaps[0] ?? "";
  const key = `${el.selector}:layout`;
  const columns = (gridPart?.props.find((p) => p.name === "columns")?.options ?? ["1", "2", "3", "4", "6"]).filter((c) => /^\d+$/.test(c) && Number(c) <= 6);
  const set = (name: string, value: string | null) => handlers.onAttrs(el, [{ name, value }], key);
  const pick = (next: Flow) => {
    memory.current[el.selector] = { ...memory.current[el.selector], ...attrs };
    handlers.onAttrs(el, flowChanges(attrs, next, memory.current[el.selector]), key);
  };
  const gapIndex = Math.max(0, gaps.indexOf(gapName));
  return (
    <Card title="Layout">
      <Row label="Flow" stacked>
        <div className="segmented design-customize-segments" role="group" aria-label="Flow">
          {FLOWS.map((f) => (
            <button key={f.value} aria-pressed={flow === f.value} aria-label={f.label} title={f.label} className={flow === f.value ? "on" : ""} onClick={() => pick(f.value)}>
              <f.Icon size={14} strokeWidth={1.75} aria-hidden />
            </button>
          ))}
        </div>
      </Row>
      {flow === "grid" && (
        <Row label="Columns" stacked>
          <Segments label="Columns" options={columns.map((c) => ({ label: c, value: c }))} value={attrs["data-columns"] ?? null} onPick={(c) => set("data-columns", c)} />
        </Row>
      )}
      {gaps.length > 0 && (
        <Row label="Gap" stacked>
          <div className="design-customize-gap">
            <input type="range" aria-label="Gap" aria-valuetext={gapName} min={0} max={gaps.length - 1} step={1} value={gapIndex} onChange={(e) => set("data-gap", gaps[Number(e.target.value)] ?? null)} />
            <span className="design-customize-value">{gapName}</span>
          </div>
        </Row>
      )}
      <Row label={flow === "grid" ? "Place in cell" : "Align"} stacked>
        <Segments label="Align" options={ALIGNS.map((a) => ({ label: a[0]!.toUpperCase() + a.slice(1), value: a }))} value={attrs["data-align"] ?? null} onPick={(a) => set("data-align", a)} />
      </Row>
    </Card>
  );
}

/**
 * The panel's last row: where the element is in the page's source (`index.html:42`, opens the Code view there), and its
 * start tag as it really is in the file, read back after each change.
 */
function SourceRow({ threadId, designDir, page, reloadKey, el, onCode }: { threadId: string; designDir: string; page: string; reloadKey: string; el: SelectedElement; onCode?: (el: SelectedElement) => void }) {
  const [source, setSource] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let live = true;
    void api()
      .readArtifact(threadId, `${designDir}/${page}`)
      .then((res) => live && setSource(res.ok && typeof res.text === "string" ? res.text : null))
      .catch(() => live && setSource(null));
    return () => {
      live = false;
    };
  }, [threadId, designDir, page, reloadKey]);
  const line = source ? lineOf(source, el.id, el.html) : null;
  return (
    <div className="design-customize-code">
      <div className="design-customize-code-head">
        <button className="icon-button" aria-label={open ? "Hide the code" : "Show the code"} aria-expanded={open} onClick={() => setOpen(!open)}>
          <ChevronDown size={14} strokeWidth={1.75} aria-hidden className={open ? "" : "design-customize-chev"} />
        </button>
        <button className="link-button design-customize-source" title="Open this line in the Code view" onClick={() => onCode?.(el)}>
          <Code2 size={13} strokeWidth={1.75} aria-hidden />
          {page}
          {line ? `:${line}` : ""}
        </button>
        <span className="design-customize-code-kind">HTML</span>
      </div>
      {open && <code className="design-customize-code-body">{startTagOf(el.html)}</code>}
    </div>
  );
}

/** The `Aa` before a type style's name. */
function TypeSample() {
  return (
    <span className="design-type-sample" aria-hidden>
      Aa
    </span>
  );
}

/** A colour by its token name, with its swatch: `text-muted`. A colour that's no token reads `Custom`. */
function TokenSelect({ label, tokens, value, computed, onPick }: { label: string; tokens: ColourToken[]; value: string | null; computed: string; onPick: (token: string) => void }) {
  const swatch = (colour: string) => <span className="design-token-dot" style={{ background: colour }} aria-hidden />;
  const none = /^(transparent|rgba\(0,0,0,0\))$/.test(computed.replace(/\s+/g, ""));
  const options = [
    ...(value ? [] : [{ value: "", label: none ? "None" : "Custom", lead: swatch(none ? "transparent" : computed) }]),
    ...tokens.map((t) => ({ value: t.token, label: t.name, lead: swatch(t.value) })),
  ];
  return <Select<string> value={value ?? ""} options={options} onChange={(token) => token && onPick(token)} ariaLabel={label} className="ghost-select block mono-select design-token-select" />;
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="design-inspector-group">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

/** A labelled control. A typed prop leads with its type's icon; one set on the element shows a dot that resets it. */
function Row({ label, stacked = false, icon: Icon, onReset, children }: { label: string; stacked?: boolean; icon?: typeof Diamond; onReset?: () => void; children: ReactNode }) {
  return (
    <div className={`design-customize-row${stacked ? " stacked" : ""}`}>
      <span className="design-inspector-row-label" title={label}>
        {Icon && <Icon size={12} strokeWidth={1.75} aria-hidden className="design-customize-prop-icon" />}
        {label}
        {onReset && <button type="button" className="design-customize-set" aria-label={`Reset ${label}`} title={`Set here. Click to reset ${label} to the default`} onClick={onReset} />}
      </span>
      {children}
    </div>
  );
}

function Segments({ label, options, value, onPick }: { label: string; options: { label: string; value: string }[]; value: string | null; onPick: (value: string) => void }) {
  return (
    <div className="segmented design-customize-segments" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} aria-pressed={o.value === value} className={o.value === value ? "on" : ""} onClick={() => onPick(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Toggle({ label, on, onChange }: { label: string; on: boolean; onChange: (on: boolean) => void }) {
  return (
    <div className="segmented design-customize-segments" role="group" aria-label={label}>
      <button aria-pressed={!on} className={!on ? "on" : ""} onClick={() => onChange(false)}>
        Off
      </button>
      <button aria-pressed={on} className={on ? "on" : ""} onClick={() => onChange(true)}>
        On
      </button>
    </div>
  );
}
