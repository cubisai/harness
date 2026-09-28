// A dev run is the stock Electron.app from node_modules, and macOS names the
// menu bar and Dock after that bundle ("Electron"), whatever the app sets at
// runtime. Rebrand the local copy with the product name and icon so dev looks
// like the packaged app. Packaged builds are named by electron-builder instead.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

if (process.platform === "darwin") {
  const require = createRequire(import.meta.url);
  const app = join(dirname(require.resolve("electron/package.json")), "dist", "Electron.app");
  const plist = join(app, "Contents", "Info.plist");
  const { productName } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  if (existsSync(plist) && productName) {
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
    if (existsSync(icon)) copyFileSync(icon, join(app, "Contents", "Resources", "electron.icns"));
    // Editing Info.plist breaks the bundle's signature; re-sign ad hoc so macOS still launches it.
    execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "ignore" });
    // Tell Launch Services the bundle changed, so the Dock and menu bar pick up the new name and icon.
    try {
      execFileSync("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", ["-f", app], { stdio: "ignore" });
    } catch {
      // Only a cache refresh; the next launch reads the plist either way.
    }
  }
}
