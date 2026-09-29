import type { Settings } from "../../shared/types";
import { importNativeMemory } from "./import";
import { MemoryStore } from "./store";

/** Whether shared memory is on for this project: on by default, off globally or per project. */
export function memoryOn(settings: Settings, projectId: string): boolean {
  return (settings.memory?.enabled ?? true) && !(settings.memory?.disabledProjects ?? []).includes(projectId);
}

/** The index as a prompt block for agents without native memory, or "" when there are no facts yet. */
export function memoryPrompt(indexText: string): string {
  if (!indexText.trim()) return "";
  return `<harness-memory>\nProject memory shared across agents (CubiQ). Titles only: call the memory_read tool with a file name for the full note, or with no file to list all notes. Check it before asking the user something they may have told you before.\n${indexText}\n</harness-memory>`;
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
