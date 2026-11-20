/** Host chrome customization, separate from the iframe bridge's APP_THEME_TOKENS. */
export const CHROME_THEME_TOKENS = ["bg", "bg-sidebar", "bg-elevated", "bg-subtle", "bg-chip", "bg-hover", "bg-selected", "text", "text-secondary", "text-tertiary", "hairline", "hairline-strong", "primary", "on-primary", "focus"] as const;
export type ChromeThemeToken = (typeof CHROME_THEME_TOKENS)[number];
export type ThemeScheme = "light" | "dark";
export interface PluginAppTheme { light?: Partial<Record<ChromeThemeToken, string>>; dark?: Partial<Record<ChromeThemeToken, string>> }
export interface AppThemeHandle { key: string; revision: string; hash: string }
export type AppThemeSource = { proposalId: string } | AppThemeHandle;
export interface AppThemeView extends AppThemeHandle { title: string; enabled: boolean; error?: string; theme: PluginAppTheme }
export interface AppThemeSelection { key: string; hash: string }
export interface AppThemeState {
  version: number;
  selected: AppThemeSelection | null;
  themes: AppThemeView[];
  active: PluginAppTheme | null;
  preview: { token: string; source: AppThemeSource; title: string; theme: PluginAppTheme; windowId: number } | null;
  error?: string;
}
