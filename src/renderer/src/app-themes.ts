import type { CSSProperties } from "react";
import { CHROME_THEME_TOKENS, type PluginAppTheme, type ThemeScheme } from "../../shared/app-themes";
import { appThemePalette, CHROME_THEME_DERIVED } from "../../shared/app-theme-palette";
import { CHROME_THEME_BASE } from "../../shared/chrome-theme-tokens.generated";

const owned = [...CHROME_THEME_TOKENS, ...CHROME_THEME_DERIVED];
const applied = new WeakMap<HTMLElement, string[]>();
export function applyChromePalette(theme: PluginAppTheme | null, scheme: ThemeScheme, root = document.documentElement): void {
  for (const name of applied.get(root) ?? []) root.style.removeProperty(`--${name}`);
  const palette = appThemePalette(theme, scheme);
  for (const [name, value] of Object.entries(palette)) root.style.setProperty(`--${name}`, value);
  applied.set(root, Object.keys(palette));
  window.dispatchEvent(new Event("unskilled-theme"));
}

/** Baseline recovery/security colors follow color-scheme without a React listener. */
export function chromeSafetyStyle(): CSSProperties {
  const base = CHROME_THEME_BASE;
  return Object.fromEntries(owned.map((name) => [`--${name}`, `light-dark(${base.light[name as keyof typeof base.light]}, ${base.dark[name as keyof typeof base.dark]})`])) as CSSProperties;
}
