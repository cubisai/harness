import type { MemoryNote, MemoryOverview, MemoryScope, MemoryType, Settings } from "../../shared/types";
import { importNativeMemory } from "./import";
import { GLOBAL_SCOPE, type MemoryStore } from "./store";

const TYPES: MemoryType[] = ["user", "feedback", "project", "reference"];

/** The store folder a Library call targets: the project's, or the shared global one. */
function scopeId(projectId: string, scope?: MemoryScope): string {
  return scope === "global" ? GLOBAL_SCOPE : projectId;
}

/** The Library's memory calls, as a plain factory so they're testable without electron. */
export function createMemoryApi(deps: {
  memory: { store: MemoryStore; ensure(projectId: string, projectPath: string): string };
  settings: { get(): Settings; update(patch: Partial<Settings>): Settings };
  projectPath: (projectId: string) => string;
  home: string;
  codexHome?: string;
}) {
  /** One project's memory as the Library shows it. */
  function overview(projectId: string): MemoryOverview {
    const s = deps.settings.get();
    const dir = deps.memory.ensure(projectId, deps.projectPath(projectId));
    const idx = deps.memory.store.index(projectId);
    const block = deps.memory.store.blockIndex(projectId);
    return {
      enabled: s.memory?.enabled ?? true,
      projectOn: !(s.memory?.disabledProjects ?? []).includes(projectId),
      dir,
      index: { lines: idx.lines, tokens: idx.tokens },
      notes: deps.memory.store.list(projectId),
      global: deps.memory.store.list(GLOBAL_SCOPE),
      block: { shown: block.shown, total: block.total, tokens: block.tokens },
    };
  }

  function read(projectId: string, file: string, scope?: MemoryScope): (MemoryNote & { body: string }) | null {
    return deps.memory.store.read(scopeId(projectId, scope), file);
  }

  function write(projectId: string, note: { file?: string; name: string; description: string; type: MemoryType; body: string }, scope?: MemoryScope): string {
    const name = note.name.trim();
    if (!name) throw new Error("A note needs a name.");
    const type = TYPES.includes(note.type) ? note.type : "project";
    return deps.memory.store.write(scopeId(projectId, scope), {
      name,
      description: note.description.trim(),
      type,
      body: note.body,
      ...(note.file ? { file: note.file } : {}),
    });
  }

  function remove(projectId: string, file: string, scope?: MemoryScope): boolean {
    return deps.memory.store.remove(scopeId(projectId, scope), file);
  }

  function setEnabled(projectId: string | null, on: boolean): MemoryOverview | null {
    const current = deps.settings.get().memory;
    const disabled = current?.disabledProjects ?? [];
    if (projectId === null) {
      deps.settings.update({ memory: { enabled: on, disabledProjects: [...disabled] } });
      return null;
    }
    const disabledProjects = on ? disabled.filter((p) => p !== projectId) : [...new Set([...disabled, projectId])];
    deps.settings.update({ memory: { enabled: current?.enabled ?? true, disabledProjects } });
    return overview(projectId);
  }

  function reimport(projectId: string): number {
    return importNativeMemory(deps.memory.store, projectId, deps.projectPath(projectId), {
      home: deps.home,
      ...(deps.codexHome ? { codexHome: deps.codexHome } : {}),
      force: true,
    }).imported;
  }

  return { overview, read, write, remove, setEnabled, reimport };
}
