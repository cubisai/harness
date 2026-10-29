import { join, relative, resolve, sep } from "node:path";

/**
 * The built-in Chats project: chats started without a project folder. It is an
 * ordinary project row whose folder the app owns (`<userData>/chats`); each chat
 * works in its own subfolder, stored as the thread's worktreePath with no branch.
 */
export const CHATS_NAME = "Chats";

/** The Chats project's folder under the app's data folder. */
export function chatsRoot(userData: string): string {
  return join(userData, "chats");
}

const norm = (p: string, platform: NodeJS.Platform): string => {
  const r = resolve(p);
  return platform === "win32" ? r.toLowerCase() : r;
};

/** Whether `path` is the Chats project's folder (case-insensitive on Windows). */
export function isChatsRoot(path: string, root: string | null, platform: NodeJS.Platform = process.platform): boolean {
  return Boolean(root) && norm(path, platform) === norm(root!, platform);
}

/** Whether `path` is one chat's own folder: directly inside the Chats folder, never the folder itself or anything outside it. */
export function isChatDir(path: string, root: string | null, platform: NodeJS.Platform = process.platform): boolean {
  if (!root) return false;
  const rel = relative(norm(root, platform), norm(path, platform));
  return Boolean(rel) && !rel.startsWith("..") && !rel.includes(sep) && !rel.includes("/");
}
