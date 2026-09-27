import { statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

/**
 * A note for the prompt listing the project files and folders the user
 * @-mentioned. Mentions are project-relative; anything absolute, with a ".."
 * segment, resolving outside the project, or that no longer exists is dropped.
 * At most 50 survive; "" when none do.
 */
export function mentionNote(projectPath: string, mentions: string[] | undefined): string {
  if (!mentions?.length) return "";
  const root = resolve(projectPath);
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const mention of mentions) {
    if (lines.length >= 50) break;
    const rel = mention.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!rel || rel.startsWith("/") || /^[A-Za-z]:/.test(rel)) continue;
    if (rel.split("/").includes("..")) continue;
    const abs = resolve(root, rel);
    const inside = relative(root, abs);
    if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) continue;
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      continue;
    }
    if (!stat.isFile() && !stat.isDirectory()) continue;
    const path = rel.endsWith("/") ? rel.slice(0, -1) : rel;
    if (seen.has(path)) continue;
    seen.add(path);
    const folder = stat.isDirectory();
    lines.push(`- ${path}${folder ? "/" : ""} (${folder ? "folder" : "file"})`);
  }
  if (!lines.length) return "";
  return `\n\nThe user mentioned these (paths relative to the project root; read them as needed):\n${lines.join("\n")}`;
}
