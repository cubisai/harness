/**
 * Injected by electron.vite.config.ts into the main build only. Read lazily
 * inside the IPC handler (guarded by `typeof`) so a non-electron-vite run
 * (vitest) never evaluates it.
 */
declare const __CUBIQ_BUILD__: {
  commit: string | null;
  date: string | null;
  changelog: { hash: string; date: string; subject: string }[];
};
