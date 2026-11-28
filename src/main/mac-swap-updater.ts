import { spawn } from "node:child_process";
import type { UpdaterBackend } from "./updater";

/**
 * macOS updates for builds without a Developer ID. Squirrel.Mac (electron-updater's
 * stock path) only installs an update whose signature satisfies the running
 * app's designated requirement; an ad-hoc signature's requirement is its own
 * cdhash, so every new build fails it. This backend keeps electron-updater for
 * finding the update and its notes, but downloads the release .zip itself,
 * checks its sha512 against the update metadata, unpacks it, checks the bundle,
 * and on quit swaps the .app in place from a detached helper.
 */

/** What electron-updater's checkForUpdates() gives back, as far as this module reads it. */
export interface FoundUpdate {
  isUpdateAvailable: boolean;
  updateInfo: {
    version: string;
    files: { url: string; sha512: string; size?: number }[];
    releaseNotes?: unknown;
    /** The GitHub provider adds the release tag. */
    tag?: string;
  };
}

export interface SwapDeps {
  /** electron-updater's check, with its own download turned off. */
  check(): Promise<FoundUpdate | null>;
  /** The full URL of one release file. */
  fileUrl(info: FoundUpdate["updateInfo"], file: string): string;
  download(url: string, dest: string): Promise<void>;
  /** base64 sha512 of a file, the form electron-builder writes into latest-mac.yml. */
  sha512(path: string): Promise<string>;
  /** Runs a command (no shell); rejects on a non-zero exit. */
  run(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }>;
  spawnDetached(cmd: string, args: string[]): Promise<void>;
  writeFile(path: string, text: string): void;
  /** Empties and recreates a directory. */
  resetDir(path: string): void;
  exists(path: string): boolean;
  quit(): void;
  onWillQuit(listener: () => void): void;
  pid: number;
  /** The running bundle, e.g. /Applications/CubiQ.app. */
  appPath: string;
  bundleId: string;
  /** Where downloads and the unpacked bundle wait (under userData). */
  stagingDir: string;
}

/**
 * The helper that runs after the app exits: wait for its pid, move the old
 * bundle aside, move the new one in (or put the old one back), clear the
 * download quarantine, and reopen when asked. POSIX sh, no bashisms.
 */
export const SWAP_SCRIPT = `#!/bin/sh
pid="$1"; target="$2"; staged="$3"; relaunch="$4"
i=0
while kill -0 "$pid" 2>/dev/null; do
  i=$((i + 1))
  [ "$i" -gt 600 ] && exit 1
  sleep 0.1
done
backup="$target.cubiq-old"
rm -rf "$backup"
mv "$target" "$backup" || exit 1
if mv "$staged" "$target"; then
  rm -rf "$backup"
else
  rm -rf "$target"
  mv "$backup" "$target"
fi
xattr -dr com.apple.quarantine "$target" 2>/dev/null
[ "$relaunch" = 1 ] && open "$target"
exit 0
`;

type Listener = (arg: never) => void;

/** A ChildProcess handle alone doesn't mean the OS accepted the launch. */
export function spawnSwapHelper(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export class MacSwapBackend implements UpdaterBackend {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  logger: unknown = null;
  private listeners: { "update-downloaded": Listener[]; error: Listener[] } = { "update-downloaded": [], error: [] };
  /** The unpacked bundle waiting to replace the running one. */
  private staged: string | null = null;
  private busy = false;
  private launching = false;
  private swapped = false;

  constructor(private deps: SwapDeps) {
    deps.onWillQuit(() => {
      if (this.autoInstallOnAppQuit) void this.swap(false).catch((err) => this.emit("error", err));
    });
  }

  on(event: "update-downloaded" | "error", listener: (arg: never) => void): this {
    this.listeners[event].push(listener);
    return this;
  }

  private emit(event: "update-downloaded" | "error", arg: unknown): void {
    for (const l of this.listeners[event]) l(arg as never);
  }

  async checkForUpdates(): Promise<unknown> {
    if (this.busy || this.staged) return null;
    this.busy = true;
    try {
      const found = await this.deps.check();
      if (!found?.isUpdateAvailable) return found;
      const info = found.updateInfo;
      const zip = info.files.find((f) => f.url.endsWith(".zip") && (f.url.includes("arm64") === (process.arch === "arm64")));
      if (!zip) throw new Error(`no ${process.arch} .zip in the ${info.version} update`);
      if (!/^[\w.-]+\.zip$/.test(zip.url)) throw new Error(`unexpected update file name: ${zip.url}`);
      const dir = this.deps.stagingDir;
      this.deps.resetDir(dir);
      const zipPath = `${dir}/${zip.url}`;
      await this.deps.download(this.deps.fileUrl(info, zip.url), zipPath);
      const sum = await this.deps.sha512(zipPath);
      if (sum !== zip.sha512) throw new Error(`the ${info.version} download doesn't match its sha512`);
      const unpacked = `${dir}/unpacked`;
      await this.deps.run("/usr/bin/ditto", ["-x", "-k", zipPath, unpacked]);
      const app = `${unpacked}/${this.deps.appPath.split("/").pop()}`;
      if (!this.deps.exists(app)) throw new Error(`the ${info.version} zip has no ${app.split("/").pop()}`);
      const plist = `${app}/Contents/Info.plist`;
      const id = (await this.deps.run("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", plist])).stdout.trim();
      const version = (await this.deps.run("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", plist])).stdout.trim();
      if (id !== this.deps.bundleId) throw new Error(`the update is ${id}, not ${this.deps.bundleId}`);
      if (version !== info.version) throw new Error(`the update bundle is ${version}, expected ${info.version}`);
      // Ad-hoc signatures still seal the bundle: a damaged or edited one fails here.
      await this.deps.run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
      this.staged = app;
      this.emit("update-downloaded", { version: info.version, releaseNotes: info.releaseNotes });
      return found;
    } catch (err) {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      this.busy = false;
    }
  }

  async quitAndInstall(): Promise<void> {
    if (await this.swap(true)) this.deps.quit();
  }

  /** Starts the helper once; it does the swap after this process exits. */
  private async swap(relaunch: boolean): Promise<boolean> {
    if (!this.staged || this.swapped || this.launching) return false;
    const script = `${this.deps.stagingDir}/swap.sh`;
    this.launching = true;
    try {
      this.deps.writeFile(script, SWAP_SCRIPT);
      await this.deps.spawnDetached("/bin/sh", [script, String(this.deps.pid), this.deps.appPath, this.staged, relaunch ? "1" : "0"]);
      this.swapped = true;
      return true;
    } finally {
      this.launching = false;
    }
  }
}

/**
 * Whether this bundle is signed without a Developer ID (ad-hoc, or not at
 * all): then Squirrel.Mac can't install updates and the swap backend should.
 */
export function isAdHocSigned(codesignOutput: string): boolean {
  return /Signature=adhoc/.test(codesignOutput) || /TeamIdentifier=not set/.test(codesignOutput) || /not signed at all/.test(codesignOutput);
}

/** The .app bundle that holds an executable path, or null outside one. */
export function bundlePath(execPath: string): string | null {
  const m = /^(.*?\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath);
  return m ? m[1]! : null;
}

/** Release notes (electron-updater gives HTML from GitHub) as plain text lines. */
export function notesText(notes: unknown): string | null {
  const raw = Array.isArray(notes)
    ? notes.map((n) => (n && typeof n === "object" && "note" in n ? String((n as { note: unknown }).note ?? "") : "")).join("\n")
    : typeof notes === "string"
      ? notes
      : "";
  const text = raw
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/(p|h[1-6]|ul|ol|li|div)>|<br\s*\/?>/gi, "\n")
    .replace(/<h[1-6][^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .split("\n")
    .map((l) => l.replace(/^#{1,6}\s+/, "").trim())
    .filter(Boolean)
    .join("\n");
  return text ? text.slice(0, 4000) : null;
}
