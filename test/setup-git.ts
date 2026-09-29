// Why: on this Mac `git` on PATH is Apple's /usr/bin/git xcrun shim, which costs
// ~150ms per call inside a vitest worker (the real Xcode binary is ~5ms). Many
// tests shell out to git, so point PATH at the real binary via a temp symlink.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.platform === "darwin") {
  try {
    const onPath = execFileSync("/usr/bin/which", ["git"]).toString().trim();
    if (onPath === "/usr/bin/git") {
      const real = execFileSync("/usr/bin/xcrun", ["-f", "git"]).toString().trim();
      if (existsSync(real)) {
        // Once per worker process: a temp dir with `git` -> real binary, first on PATH.
        const dir = mkdtempSync(join(tmpdir(), "cubiq-git-"));
        symlinkSync(real, join(dir, "git"));
        process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;
      }
    }
  } catch {
    // xcrun/git unavailable — keep whatever PATH node gave us.
  }
}
