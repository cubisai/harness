import type { PluginAppTheme, ThemeScheme } from "../../shared/app-themes";
import { appThemePalette } from "../../shared/app-theme-palette";
import { CHROME_THEME_BASE } from "../../shared/chrome-theme-tokens.generated";

/** Native caption foreground only; no Mica/vibrancy/inset or mode changes. */
export function appThemeCaption(platform: string, scheme: ThemeScheme, theme: PluginAppTheme | null): { symbolColor: string } | null {
  if (platform !== "win32" && platform !== "linux") return null;
  return { symbolColor: appThemePalette(theme, scheme).text ?? CHROME_THEME_BASE[scheme].text };
}
