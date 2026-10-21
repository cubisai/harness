// Codex's own document plugins (installed by the Codex app) do the same jobs as
// CubiQ's bundled Office skills. When one is enabled in Codex's config.toml, the
// bundled skill it covers is left out of the set CubiQ gives Codex, so Codex's
// skill list doesn't carry the same job twice. Without the plugin (a CLI-only
// install), Codex keeps CubiQ's skill.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SkillEntry } from "../../shared/types";

/** Each Codex plugin and the bundled CubiQ skill it covers. */
const COVERS: Record<string, string> = { documents: "docx", pdf: "pdf", presentations: "pptx", spreadsheets: "xlsx" };

/** Plugin names (without the `@marketplace`) a Codex config.toml enables: `[plugins."<name>@<market>"]` with `enabled = true`. */
export function enabledCodexPlugins(toml: string): Set<string> {
  const out = new Set<string>();
  let current: string | null = null;
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      const m = /^\[\s*plugins\.(?:"([^"]+)"|'([^']+)'|([^.\]\s]+))\s*\]$/.exec(line);
      const key = m?.[1] ?? m?.[2] ?? m?.[3];
      current = key ? key.split("@")[0]! : null;
      continue;
    }
    if (current && /^enabled\s*=\s*true(\s|#|$)/.test(line)) out.add(current);
  }
  return out;
}

/** The bundled skill names Codex already covers with an enabled plugin of its own; none when its config can't be read. */
export function codexCoveredSkills(env: NodeJS.ProcessEnv = process.env, read: (file: string) => string = (f) => readFileSync(f, "utf8")): Set<string> {
  let toml: string;
  try {
    toml = read(join(env.CODEX_HOME || join(homedir(), ".codex"), "config.toml"));
  } catch {
    return new Set();
  }
  const plugins = enabledCodexPlugins(toml);
  return new Set(Object.entries(COVERS).flatMap(([plugin, skill]) => (plugins.has(plugin) ? [skill] : [])));
}

/** Codex's skill set without the bundled skills its own plugins cover; a project or shared skill of the same name stays. */
export function withoutCodexCovered(skills: SkillEntry[], covered: Set<string>): SkillEntry[] {
  return covered.size ? skills.filter((s) => !(s.origin === "bundled" && covered.has(s.name))) : skills;
}
