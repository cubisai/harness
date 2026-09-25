import type { AppUpdateStatus } from "../shared/types";

/** The part of electron-updater's autoUpdater this module uses, so tests can fake it. */
export interface UpdaterBackend {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  logger: unknown;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(): void;
  on(event: "update-downloaded", listener: (info: { version: string }) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
}

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

/**
 * Background updates from GitHub releases: check at start and every few
 * hours, download quietly, and install on quit, or right away when the user
 * clicks Restart. Nothing is shown until an update is ready.
 */
export class Updater {
  private ready: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private backend: UpdaterBackend | null, // null: not supported here (dev build, smoke run, deb/rpm)
    private current: string,
    private enabled: () => boolean,
    private onReady: (status: AppUpdateStatus) => void,
    private log: (message: string) => void = () => {},
  ) {
    if (!backend) return;
    backend.autoDownload = true;
    backend.autoInstallOnAppQuit = enabled();
    backend.logger = null; // its progress chatter; failures still come through "error"
    backend.on("update-downloaded", (info) => {
      this.ready = info.version;
      this.onReady(this.status());
    });
    // An unsigned macOS build, a network hiccup, or a release without update
    // metadata all land here. None of them is worth interrupting the user for.
    backend.on("error", (err) => this.log(`update: ${err.message}`));
  }

  status(): AppUpdateStatus {
    return { current: this.current, ready: this.ready, supported: this.backend !== null };
  }

  start(): void {
    if (!this.backend || this.timer) return;
    this.refresh();
    this.timer = setInterval(() => void this.check(), CHECK_EVERY_MS);
    this.timer.unref?.();
  }

  /** After the setting changes: follow it for install-on-quit, and check now if it's on. */
  refresh(): void {
    if (!this.backend) return;
    this.backend.autoInstallOnAppQuit = this.enabled();
    void this.check();
  }

  async check(): Promise<void> {
    if (!this.backend || !this.enabled() || this.ready) return;
    try {
      await this.backend.checkForUpdates();
    } catch {
      // Already reported through the "error" event.
    }
  }

  install(): void {
    if (this.backend && this.ready) this.backend.quitAndInstall();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
