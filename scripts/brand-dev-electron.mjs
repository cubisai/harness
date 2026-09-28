// A dev run boots the stock Electron.app from node_modules, and macOS names the
// menu bar and Dock after that bundle's file name ("Electron.app"), whatever the
// app sets at runtime. So make a branded clone, CubiQ.app, next to the stock
// bundle and run it via ELECTRON_EXEC_PATH; Electron.app itself stays stock
// because electron's install check compares path.txt to "Electron.app/..." and
// would re-download it on every dev run. Packaged builds are named by
// electron-builder instead.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

if (process.platform === "darwin") {
  const require = createRequire(import.meta.url);
  const app = join(dirname(require.resolve("electron/package.json")), "dist", "Electron.app");
  const { productName } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  if (existsSync(join(app, "Contents", "Info.plist")) && productName) {
    // Brand a fresh clone each time so it always mirrors the current Electron.app.
    const copy = join(dirname(app), `${productName}.app`);
    rmSync(copy, { recursive: true, force: true });
    try {
      execFileSync("cp", ["-Rc", app, copy]); // APFS clone: a full copy that costs no extra disk.
    } catch {
      execFileSync("cp", ["-R", app, copy]); // Non-APFS volumes can't clone.
    }
    const plist = join(copy, "Contents", "Info.plist");
    const set = (key, value) => {
      try {
        execFileSync("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${value}`, plist], { stdio: "ignore" });
      } catch {
        execFileSync("/usr/libexec/PlistBuddy", ["-c", `Add :${key} string ${value}`, plist], { stdio: "ignore" });
      }
    };
    set("CFBundleName", productName);
    set("CFBundleDisplayName", productName);
    const icon = new URL("../build/icon.icns", import.meta.url);
    if (existsSync(icon)) copyFileSync(icon, join(copy, "Contents", "Resources", "electron.icns"));
    // Editing Info.plist breaks the bundle's signature; re-sign ad hoc so macOS still launches it.
    execFileSync("codesign", ["--force", "--deep", "--sign", "-", copy], { stdio: "ignore" });
    // Tell Launch Services the bundle changed, so the Dock and menu bar pick up the new name and icon.
    try {
      execFileSync("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", ["-f", copy], { stdio: "ignore" });
    } catch {
      // Only a cache refresh; the next launch reads the plist either way.
    }
  }
}
