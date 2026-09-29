import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type MemoryStore, parseFact } from "./store";

/** Claude Code's folder name for a project path: every non-alphanumeric char becomes a dash. */
export function claudeProjectKey(projectPath: string): string {
  return projectPath.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * Copy Claude's native auto-memory into the shared store once per project,
 * plus Codex's memory file. Runs at most once per project (the `.imported`
 * marker), never touches the sources, and is tolerant of missing folders.
 * `force` re-runs it anyway (the Library's Import button); name dedupe still
 * keeps it from importing anything twice.
 */
export function importNativeMemory(
  store: MemoryStore,
  projectId: string,
  projectPath: string,
  opts: { home: string; codexHome?: string; force?: boolean },
): { imported: number; skipped: number } {
  const dir = store.dir(projectId);
  const marker = join(dir, ".imported");
  if (!opts.force && existsSync(marker)) return { imported: 0, skipped: 0 };
  let imported = 0;
  let skipped = 0;

  const key = claudeProjectKey(projectPath);
  // Claude hashes keys over 200 chars; we can't reproduce that path, so skip.
  if (key.length <= 200) {
    const source = join(opts.home, ".claude", "projects", key, "memory");
    if (existsSync(source)) {
      for (const file of readdirSync(source)) {
        if (!file.endsWith(".md") || file === "MEMORY.md") continue;
        try {
          const fact = parseFact(file, readFileSync(join(source, file), "utf8"));
          const existing = store.list(projectId);
          if (existing.some((f) => f.name.toLowerCase() === fact.name.toLowerCase())) {
            skipped++;
            continue;
          }
          // Keep Claude's own basename when it's free, so its links stay valid.
          const basenameFree = !existing.some((f) => f.file.toLowerCase() === file.toLowerCase());
          store.write(projectId, {
            name: fact.name,
            description: fact.description,
            type: fact.type,
            body: fact.body,
            ...(basenameFree ? { file } : {}),
          });
          imported++;
        } catch {
          // One unreadable or oddly named file must not stop the rest, or the marker, from landing.
          skipped++;
        }
      }
    }
  }

  const codexPath = join(opts.codexHome ?? join(opts.home, ".codex"), "memories", "MEMORY.md");
  if (existsSync(codexPath) && !store.list(projectId).some((f) => f.name.toLowerCase() === "codex-memories")) {
    const body = readFileSync(codexPath, "utf8").slice(0, 8000);
    store.write(projectId, { name: "codex-memories", description: "Imported from Codex's own memories", type: "reference", body });
    imported++;
  }

  writeFileSync(marker, JSON.stringify({ at: new Date().toISOString(), imported, skipped }));
  return { imported, skipped };
}
