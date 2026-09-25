import { chmodSync, existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

if (process.platform === "darwin") {
  const require = createRequire(import.meta.url);
  const ptyRoot = dirname(require.resolve("node-pty/package.json"));
  const helpers = [];

  const prebuilds = join(ptyRoot, "prebuilds");
  if (existsSync(prebuilds)) {
    for (const entry of readdirSync(prebuilds, { withFileTypes: true })) {
      if (entry.isDirectory()) helpers.push(join(prebuilds, entry.name, "spawn-helper"));
    }
  }
  for (const release of ["build/Release", "build/Debug"]) {
    helpers.push(join(ptyRoot, release, "spawn-helper"));
  }

  for (const helper of helpers) {
    if (existsSync(helper)) chmodSync(helper, 0o755);
  }
}
