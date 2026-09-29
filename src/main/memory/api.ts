import type { MemoryNote, MemoryOverview, MemoryType, Settings } from "../../shared/types";
import { importNativeMemory } from "./import";
import type { MemoryStore } from "./store";

const TYPES: MemoryType[] = ["user", "feedback", "project", "reference"];

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
    return {
      enabled: s.memory?.enabled ?? true,
      projectOn: !(s.memory?.disabledProjects ?? []).includes(projectId),
      dir,
      index: { lines: idx.lines, tokens: idx.tokens },
      notes: deps.memory.store.list(projectId),
    };
  }

  function read(projectId: string, file: string): (MemoryNote & { body: string }) | null {
    return deps.memory.store.read(projectId, file);
  }

  function write(projectId: string, note: { file?: string; name: string; description: string; type: MemoryType; body: string }): string {
    const name = note.name.trim();
    if (!name) throw new Error("A note needs a name.");
    const type = TYPES.includes(note.type) ? note.type : "project";
    return deps.memory.store.write(projectId, {
      name,
      description: note.description.trim(),
      type,
      body: note.body,
      ...(note.file ? { file: note.file } : {}),
    });
  }

  function remove(projectId: string, file: string): boolean {
    return deps.memory.store.remove(projectId, file);
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
