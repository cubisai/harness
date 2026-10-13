// Live tweaks a design page declares for the canvas: pure, dependency-free, safe in node and the page.

/** The `<script>` id a design page uses to declare its live tweaks. */
export const TWEAKS_ID = "cubiq-tweaks";

/** The most tweaks a page may declare. */
export const MAX_TWEAKS = 12;

/** The units a range tweak may append to its value. */
export const TWEAK_UNITS = ["", "px", "rem", "em", "%"] as const;

/** One live control a design page declares: a choice, toggle, colour or range. */
export type Tweak =
  | { id: string; label: string; type: "choice"; options: string[]; default: string }
  | { id: string; label: string; type: "toggle"; default: boolean }
  | { id: string; label: string; type: "color"; var: string; default: string }
  | { id: string; label: string; type: "range"; var: string; min: number; max: number; step: number; unit: string; default: number };

/** A tweak's current value, keyed by id: an option, "on"/"off", "#rrggbb", or a number as a string. */
export type TweakValues = Record<string, string>;

const ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
const OPTION_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const VAR_RE = /^--[a-z0-9-]{1,48}$/i;
const HEX_RE = /^#[0-9a-f]{6}$/i;
const RGB_RE = /^rgb\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*\)$/i;

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const asRecord = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

const optionList = (v: unknown): string[] => {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const o of v) {
    if (out.length >= 8) break;
    if (typeof o === "string" && OPTION_RE.test(o) && !out.includes(o)) out.push(o);
  }
  return out;
};

const parseTweak = (id: string, label: string, e: Record<string, unknown>): Tweak | null => {
  switch (e.type) {
    case "choice": {
      const options = optionList(e.options);
      if (options.length < 2) return null;
      const def = typeof e.default === "string" && options.includes(e.default) ? e.default : (options[0] ?? id);
      return { id, label, type: "choice", options, default: def };
    }
    case "toggle":
      return { id, label, type: "toggle", default: typeof e.default === "boolean" ? e.default : false };
    case "color": {
      if (typeof e.var !== "string" || !VAR_RE.test(e.var)) return null;
      const def = typeof e.default === "string" && HEX_RE.test(e.default) ? e.default.toLowerCase() : "#000000";
      return { id, label, type: "color", var: e.var, default: def };
    }
    case "range": {
      if (typeof e.var !== "string" || !VAR_RE.test(e.var)) return null;
      if (!isFiniteNumber(e.min) || !isFiniteNumber(e.max) || !(e.min < e.max)) return null;
      const step = isFiniteNumber(e.step) && e.step > 0 ? e.step : 1;
      const unit = typeof e.unit === "string" && (TWEAK_UNITS as readonly string[]).includes(e.unit) ? e.unit : "";
      const raw = isFiniteNumber(e.default) ? e.default : e.min;
      const def = Math.min(e.max, Math.max(e.min, raw));
      return { id, label, type: "range", var: e.var, min: e.min, max: e.max, step, unit, default: def };
    }
    default:
      return null;
  }
};

/** Parses a page's tweak manifest; never throws, and drops anything malformed. */
export function parseTweaks(json: string): Tweak[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const container = asRecord(parsed);
  const list = Array.isArray(parsed) ? parsed : container && Array.isArray(container.tweaks) ? (container.tweaks as unknown[]) : null;
  if (!list) return [];
  const out: Tweak[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    if (out.length >= MAX_TWEAKS) break;
    const e = asRecord(entry);
    if (!e) continue;
    if (typeof e.id !== "string" || !ID_RE.test(e.id) || seen.has(e.id)) continue;
    const trimmed = typeof e.label === "string" ? e.label.trim() : "";
    const label = trimmed.length >= 1 && trimmed.length <= 40 ? trimmed : e.id;
    const tweak = parseTweak(e.id, label, e);
    if (!tweak) continue;
    seen.add(e.id);
    out.push(tweak);
  }
  return out;
}

const colorValue = (raw: unknown): string | null => {
  if (typeof raw !== "string") return null;
  if (HEX_RE.test(raw)) return raw.toLowerCase();
  const m = RGB_RE.exec(raw);
  if (!m) return null;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (!parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) return null;
  return "#" + parts.map((n) => n.toString(16).padStart(2, "0")).join("");
};

const rangeValue = (t: Extract<Tweak, { type: "range" }>, raw: unknown): string | null => {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? parseFloat(raw) : NaN;
  if (!Number.isFinite(n)) return null;
  let v = Math.min(t.max, Math.max(t.min, n));
  v = t.min + Math.round((v - t.min) / t.step) * t.step;
  v = Math.min(t.max, Math.max(t.min, v));
  return String(Number(v.toFixed(4)));
};

/** Validates and normalizes one raw tweak value; null when it does not fit the tweak. */
export function tweakValue(t: Tweak, raw: unknown): string | null {
  switch (t.type) {
    case "choice":
      return typeof raw === "string" && t.options.includes(raw) ? raw : null;
    case "toggle":
      return raw === "on" || raw === true ? "on" : raw === "off" || raw === false ? "off" : null;
    case "color":
      return colorValue(raw);
    case "range":
      return rangeValue(t, raw);
    default:
      return null;
  }
}

/** A tweak's default as the string its value is carried in. */
export function defaultValue(t: Tweak): string {
  switch (t.type) {
    case "choice":
      return t.default;
    case "toggle":
      return t.default ? "on" : "off";
    case "color":
      return t.default;
    case "range":
      return String(t.default);
    default:
      return "";
  }
}

/** Where a tweak's value goes in the page: a `data-` attribute or a CSS custom property. */
export function tweakTarget(t: Tweak, value: string): { attr: string; value: string } | { var: string; value: string } {
  switch (t.type) {
    case "choice":
    case "toggle":
      return { attr: `data-${t.id}`, value };
    case "color":
      return { var: t.var, value };
    case "range":
      return { var: t.var, value: value + t.unit };
    default:
      return { attr: "", value };
  }
}

/** Reads a page's current tweak values from its root attributes and CSS variables, with defaults as fallback. */
export function currentTweakValues(tweaks: Tweak[], attrs: Record<string, string>, vars: Record<string, string>): TweakValues {
  const out: TweakValues = {};
  for (const t of tweaks) {
    const raw = t.type === "choice" || t.type === "toggle" ? attrs[`data-${t.id}`] : vars[t.var];
    out[t.id] = tweakValue(t, raw) ?? defaultValue(t);
  }
  return out;
}

/**
 * The tweaks the user changed: overrides that differ from the page's values. Keep writes only
 * these, so a value the page set on itself after load (e.g. a 700 ms "loading" state) never gets
 * pinned as a default; untouched tweaks keep their manifest defaults.
 */
export function changedTweaks(base: TweakValues, overrides: TweakValues): TweakValues {
  const out: TweakValues = {};
  for (const [id, v] of Object.entries(overrides)) if (id in base && base[id] !== v) out[id] = v;
  return out;
}
