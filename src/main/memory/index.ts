import type { Settings } from "../../shared/types";
import { importNativeMemory } from "./import";
import { MemoryStore } from "./store";

/** Whether shared memory is on for this project: on by default, off globally or per project. */
export function memoryOn(settings: Settings, projectId: string): boolean {
  return (settings.memory?.enabled ?? true) && !(settings.memory?.disabledProjects ?? []).includes(projectId);
}

export function createMemory(opts: { root: string; home: string; codexHome?: string }): {
  store: MemoryStore;
  /** The project's memory folder, creating it and running the one-time import on first use. */
  ensure(projectId: string, projectPath: string): string;
} {
  const store = new MemoryStore(opts.root);
  return {
    store,
    ensure(projectId: string, projectPath: string): string {
      const dir = store.dir(projectId);
      try {
        importNativeMemory(store, projectId, projectPath, { home: opts.home, ...(opts.codexHome ? { codexHome: opts.codexHome } : {}) });
      } catch (err) {
        // A failed import must never block a turn; the turn's memory dir is still valid.
        console.warn("native memory import failed", err);
      }
      return dir;
    },
  };
}
