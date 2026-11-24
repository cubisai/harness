import type { AppInfo } from "../../shared/types";

/** How many apps the sidebar lists before "See all". */
export const SIDEBAR_APPS = 3;

const RECENTS_KEY = "cubiq.apps.recent";

/** When each installed app was last opened, from localStorage (a per-window convenience; unreadable means none). */
export function readAppRecents(): Record<string, number> {
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem(RECENTS_KEY) ?? "{}") as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v).filter((e): e is [string, number] => typeof e[1] === "number" && Number.isFinite(e[1]) && e[0].length <= 200).slice(0, 200));
  } catch {
    return {};
  }
}

export function writeAppRecents(recents: Record<string, number>): void {
  try {
    globalThis.localStorage?.setItem(RECENTS_KEY, JSON.stringify(recents));
  } catch {
    // Not remembered: the order falls back to favourites and names.
  }
}

/**
 * The apps the sidebar shows: enabled installed ones only, favourites first (oldest star first), then the most
 * recently opened, then by name; at most `limit`.
 */
export function sidebarApps(apps: AppInfo[], recents: Record<string, number>, limit = SIDEBAR_APPS): AppInfo[] {
  const usable = apps.filter((a) => a.enabled !== false && a.scope !== "draft");
  const favs = usable.filter((a) => a.favorite !== undefined).sort((a, b) => a.favorite! - b.favorite!);
  const rest = usable
    .filter((a) => a.favorite === undefined)
    .sort((a, b) => (recents[b.key] ?? 0) - (recents[a.key] ?? 0) || a.title.localeCompare(b.title));
  return [...favs, ...rest].slice(0, limit);
}
