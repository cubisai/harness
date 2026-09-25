import { describe, expect, it } from "vitest";
import type { AppUpdateStatus } from "../src/shared/types";
import { Updater, type UpdaterBackend } from "../src/main/updater";

function fakeBackend() {
  const listeners: Record<string, (arg: never) => void> = {};
  const backend = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    logger: console as unknown,
    checks: 0,
    installs: 0,
    fail: false,
    async checkForUpdates() {
      backend.checks++;
      if (backend.fail) {
        // Like electron-updater: emit "error", then reject.
        const err = new Error("offline");
        listeners.error!(err as never);
        throw err;
      }
    },
    quitAndInstall() {
      backend.installs++;
    },
    on(event: string, listener: (arg: never) => void) {
      listeners[event] = listener;
    },
    emit(event: string, arg: unknown) {
      listeners[event]!(arg as never);
    },
  };
  return backend;
}

describe("Updater", () => {
  it("does nothing where updates aren't supported", () => {
    const u = new Updater(null, "0.1.0", () => true, () => {});
    u.start();
    u.install();
    expect(u.status()).toEqual({ current: "0.1.0", ready: null, supported: false });
  });

  it("checks when enabled, reports a downloaded update, and installs it on request", async () => {
    const backend = fakeBackend();
    const seen: AppUpdateStatus[] = [];
    const u = new Updater(backend as UpdaterBackend, "0.1.0", () => true, (s) => seen.push(s));
    expect(backend).toMatchObject({ autoDownload: true, autoInstallOnAppQuit: true, logger: null });
    u.install(); // nothing downloaded yet
    expect(backend.installs).toBe(0);
    await u.check();
    expect(backend.checks).toBe(1);
    backend.emit("update-downloaded", { version: "0.2.0" });
    expect(seen).toEqual([{ current: "0.1.0", ready: "0.2.0", supported: true }]);
    await u.check(); // an update is already waiting
    expect(backend.checks).toBe(1);
    u.install();
    expect(backend.installs).toBe(1);
  });

  it("follows the setting, and logs failures instead of throwing", async () => {
    const backend = fakeBackend();
    let enabled = false;
    const logs: string[] = [];
    const u = new Updater(backend as UpdaterBackend, "0.1.0", () => enabled, () => {}, (m) => logs.push(m));
    expect(backend.autoInstallOnAppQuit).toBe(false);
    await u.check();
    expect(backend.checks).toBe(0);
    enabled = true;
    backend.fail = true;
    u.refresh();
    await new Promise((r) => setTimeout(r, 0));
    expect(backend.autoInstallOnAppQuit).toBe(true);
    expect(logs).toEqual(["update: offline"]);
    backend.emit("error", new Error("unsigned"));
    expect(logs.at(-1)).toBe("update: unsigned");
  });
});
