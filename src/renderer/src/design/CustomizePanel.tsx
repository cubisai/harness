import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { elementLabel, type SelectedElement } from "../../../shared/selection";
import { api } from "../api";
import { Select } from "../components/Select";
import { IconClose } from "../icons";
import { ColorSwatch } from "./ColorSwatch";

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
const OWN_STYLES = ["background-color", "color", "border-color", "font-size", "padding", "border-radius"];

/** A kit's declared prop: its options (the first is the default), or none for an on or off one. */
interface KitProp {
  name: string;
  options?: string[] | null;
}

/** An attribute's value in an element's start tag, or null. `html` comes from the page, so this only reads it. */
export function attrOf(html: string, name: string): string | null {
  const tag = /^<[^>]*>/.exec(html)?.[0] ?? "";
  const m = new RegExp(`\\s${name}(?:\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+)))?(?=[\\s/>])`, "i").exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : null;
}

const canHoldText = (el: SelectedElement): boolean => !/^(input|select|textarea|img|svg)$/.test(el.tag) && el.text !== "";
const isField = (el: SelectedElement): boolean => el.tag === "input" || el.tag === "textarea";
const canDisable = (el: SelectedElement): boolean => /^(button|input|select|textarea)$/.test(el.tag);

/** A short name for the header: the kit part's name, else the element's own. */
function displayName(el: SelectedElement): string {
  const ui = attrOf(el.html, "data-ui");
  if (!ui) return elementLabel(el);
  const name = ui.replace(/(^|-)(\w)/g, (_, dash: string, c: string) => `${dash ? " " : ""}${c.toUpperCase()}`);
  return el.text ? `${name} "${el.text.slice(0, 24)}"` : name;
}

export interface CustomizeHandlers {
  /** Change inline styles on an element (the page's root for page tokens). Previewed at once, then saved. */
  onStyle: (el: SelectedElement | null, changes: { prop: string; value: string }[], key: string) => void;
  onAttr: (el: SelectedElement, name: string, value: string | null) => void;
  onText: (el: SelectedElement, value: string) => void;
}

/**
 * Design v2's right panel, never empty: the page's theme when nothing is selected, the element's style when something
 * is. There's no Apply: every control previews on the next frame and saves itself, and ⌘Z takes it back.
 */
export function CustomizePanel({
  threadId,
  designDir,
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
}: {
  threadId: string;
  designDir: string;
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
  const propRows = props.filter((p) => p.name !== "disabled" && shows(p.name, ...(p.options ?? [])));
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
                <input className="text-input" key={`v-${el.selector}`} aria-label="Value" defaultValue={el.text} onChange={(e) => handlers.onText(el, e.target.value)} />
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
              return (
                <Row key={p.name} label={p.name.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase())} stacked={Boolean(options)}>
                  {options && options.length > 4 ? (
                    <Select<string> value={current ?? options[0] ?? ""} options={options.map((o) => ({ value: o, label: o }))} onChange={(v) => handlers.onAttr(el, name, v === options[0] ? null : v)} ariaLabel={p.name} className="ghost-select" />
                  ) : options ? (
                    <Segments label={p.name} options={options.map((o) => ({ label: o, value: o }))} value={current ?? options[0] ?? null} onPick={(v) => handlers.onAttr(el, name, v === options[0] ? null : v)} />
                  ) : (
                    <Toggle label={p.name} on={current !== null && current !== "false"} onChange={(on) => handlers.onAttr(el, name, on ? "true" : null)} />
                  )}
                </Row>
              );
            })}
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
            {colours.map((c) => (
              <Row key={c.prop} label={c.label}>
                <ColorSwatch value={c.computed} label={c.label} disabled={readOnly} onInput={(value) => setStyle(c.prop, value)} />
                <span className="design-customize-tokens">
                  {swatches.map((s) => (
                    <button key={s.token} className="design-customize-token" style={{ background: theme[s.token] }} aria-label={`${c.label}: ${s.label}`} title={s.label} onClick={() => setStyle(c.prop, `var(${s.token})`)} />
                  ))}
                </span>
              </Row>
            ))}
          </Card>
        )}
        {shows("text", "spacing", "padding", "corners", "size") && (
          <Card title="Text & Spacing">
            <Row label="Text size" stacked>
              <Segments label="Text size" options={TEXT_SIZES} value={TEXT_SIZES.find((t) => t.value === style.fontSize)?.value ?? null} onPick={(v) => setStyle("font-size", v)} />
            </Row>
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
    </aside>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="design-inspector-group">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

function Row({ label, stacked = false, children }: { label: string; stacked?: boolean; children: ReactNode }) {
  return (
    <div className={`design-customize-row${stacked ? " stacked" : ""}`}>
      <span className="design-inspector-row-label">{label}</span>
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
