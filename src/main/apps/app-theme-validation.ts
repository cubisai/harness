import { createHash } from "node:crypto";
import { CHROME_THEME_TOKENS, type ChromeThemeToken, type PluginAppTheme } from "../../shared/app-themes";
import { appThemeContrastErrors } from "../../shared/app-theme-palette";

const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
export function parseAppTheme(raw: unknown): PluginAppTheme | undefined {
  if (raw === undefined) return undefined;
  if (!record(raw) || Object.keys(raw).some((k) => k !== "light" && k !== "dark")) throw new Error("appTheme accepts only light and dark token maps.");
  if (Buffer.byteLength(JSON.stringify(raw)) > 16 * 1024) throw new Error("appTheme exceeds 16 KB.");
  const out: PluginAppTheme = {};
  let total = 0;
  for (const scheme of ["light", "dark"] as const) {
    if (raw[scheme] === undefined) continue;
    const map = raw[scheme];
    if (!record(map) || Object.keys(map).length > CHROME_THEME_TOKENS.length) throw new Error(`${scheme} needs at most 15 app theme tokens.`);
    const values: Partial<Record<ChromeThemeToken, string>> = {};
    for (const [key, value] of Object.entries(map).sort(([a], [b]) => a.localeCompare(b))) {
      if (!(CHROME_THEME_TOKENS as readonly string[]).includes(key)) throw new Error(`Unknown app theme token ${scheme}.${key}.`);
      if (typeof value !== "string" || !/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(value)) throw new Error(`${scheme}.${key} needs an opaque 3/6-digit hex color, not CSS.`);
      values[key as ChromeThemeToken] = (value.length === 4 ? `#${value.slice(1).split("").map((c) => c + c).join("")}` : value).toLowerCase();
      total++;
    }
    if (Object.keys(values).length) out[scheme] = values;
  }
  if (!total) throw new Error("appTheme needs at least one token override.");
  const errors = appThemeContrastErrors(out);
  if (errors.length) throw new Error(`App theme contrast: ${errors.join(" ")}`);
  return out;
}
export const appThemeHash = (theme: PluginAppTheme): string => createHash("sha256").update(JSON.stringify(parseAppTheme(theme))).digest("hex");
