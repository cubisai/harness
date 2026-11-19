import { readdirSync } from "node:fs";
import { basename, sep } from "node:path";

/**
 * macOS privacy (TCC) for project folders. CubiQ needs no camera, microphone,
 * screen or accessibility access; the one permission users run into is file
 * access: once someone clicks "Don't Allow" for Desktop, Documents, Downloads,
 * iCloud Drive or a removable volume, every read there fails with EPERM until
 * they switch CubiQ on in System Settings. This finds that case and says where.
 */

const FILES_AND_FOLDERS = "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders";
const FULL_DISK_ACCESS = "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";

export interface PrivacyBlock {
  path: string;
  /** The System Settings pane that holds the switch. */
  pane: string;
  paneName: string;
}

/** Which pane lists the folder: Files and Folders covers the home folders and volumes, the rest needs Full Disk Access. */
export function privacyPaneFor(path: string, home: string): Pick<PrivacyBlock, "pane" | "paneName"> {
  const inHome = (name: string) => path === `${home}${sep}${name}` || path.startsWith(`${home}${sep}${name}${sep}`);
  if (["Desktop", "Documents", "Downloads"].some(inHome) || path.startsWith(`${sep}Volumes${sep}`) || inHome(`Library${sep}Mobile Documents`)) {
    return { pane: FILES_AND_FOLDERS, paneName: "Files and Folders" };
  }
  return { pane: FULL_DISK_ACCESS, paneName: "Full Disk Access" };
}

/** A read macOS refused for privacy (EPERM), as opposed to a missing folder or ordinary permissions (EACCES). */
export function isPrivacyDenied(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { code?: unknown }).code === "EPERM");
}

/** Null when the folder reads (or fails for another reason); the block to report when macOS refuses it. */
export function checkFolder(path: string, home: string, list: (p: string) => unknown = readdirSync): PrivacyBlock | null {
  if (process.platform !== "darwin") return null;
  try {
    list(path);
    return null;
  } catch (err) {
    return isPrivacyDenied(err) ? { path, ...privacyPaneFor(path, home) } : null;
  }
}

/** The dialog text for one or more blocked folders. */
export function privacyMessage(blocks: PrivacyBlock[]): { message: string; detail: string } {
  const names = blocks.map((b) => `“${basename(b.path)}”`).join(", ");
  const panes = [...new Set(blocks.map((b) => b.paneName))].join(" or ");
  return {
    message: blocks.length === 1 ? `CubiQ can't open ${names}` : `CubiQ can't open ${blocks.length} project folders`,
    detail: `macOS is blocking CubiQ from ${names}. In System Settings → Privacy & Security → ${panes}, turn on CubiQ, then quit and reopen CubiQ.`,
  };
}
