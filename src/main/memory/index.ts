import type { Settings } from "../../shared/types";
import { importNativeMemory } from "./import";
import { MemoryStore } from "./store";

/** Whether shared memory is on for this project: on by default, off globally or per project. */
export function memoryOn(settings: Settings, projectId: string): boolean {
  return (settings.memory?.enabled ?? true) && !(settings.memory?.disabledProjects ?? []).includes(projectId);
}

/** The memory block (global then project titles) wrapped in its instructions, or "" when there are no notes yet. */
export function memoryPrompt(blockText: string): string {
  if (!blockText.trim()) return "";
  return `<harness-memory>\nCubiQ memory, shared by every agent and session. Lines are titles: memory_read gives a note (file), searches (query) or lists all.\nCheck it before asking the user something they may have told you. Save preferences, corrections and facts the code doesn't show with memory_write (scope "global" for things about the user in every project). Fix or delete a wrong note instead of adding one. Notes date from when written: check what they name still exists. No secrets.\n${blockText}\n</harness-memory>`;
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
