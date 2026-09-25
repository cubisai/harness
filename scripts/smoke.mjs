// Launch the packaged app (electron-builder --dir output) with --smoke and
// pass its exit code through. The app checks its window, preload bridge,
// skills catalog, and that the bundled Claude Code binary runs.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const candidates = [];
for (const dir of existsSync(dist) ? readdirSync(dist) : []) {
  if (process.platform === "darwin" && dir.startsWith("mac")) candidates.push(join(dist, dir, "UnSkilled.app", "Contents", "MacOS", "UnSkilled"));
  if (process.platform === "win32" && dir.startsWith("win") && dir.endsWith("unpacked")) candidates.push(join(dist, dir, "UnSkilled.exe"));
  if (process.platform === "linux" && dir.startsWith("linux") && dir.endsWith("unpacked")) candidates.push(join(dist, dir, "unskilled"));
}
const bin = candidates.find((c) => existsSync(c));
if (!bin) {
  console.error(`no packaged app found under ${dist}`);
  process.exit(1);
}
const args = ["--smoke", ...(process.platform === "linux" ? ["--no-sandbox"] : [])];
console.log(`running ${bin} ${args.join(" ")}`);
const res = spawnSync(bin, args, { stdio: "inherit", timeout: 120_000 });
process.exit(res.status ?? 1);
