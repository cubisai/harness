// CLI: write a deterministic mock extension kit to --out.
//   node scripts/mock-extensions.mjs --out <dir> [--preset small|medium|large]
//     [--skills N] [--servers K] [--tools M] [--seed S] [--mcp-out <file>] [--force]
//   --mcp-out writes the MCP JSON to that file instead of <out>/.mcp.json.
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generate, PRESETS } from "./mock-extensions-lib.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const serverScript = resolve(scriptDir, "..", "test", "fixtures", "mock-mcp-many.mjs");

function parseArgs(argv) {
  const value = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const preset = value("--preset") ?? "small";
  if (!PRESETS[preset]) throw new Error(`unknown preset "${preset}"; use small, medium or large`);
  const number = (name, fallback) => {
    const raw = value(name);
    const n = raw === undefined ? fallback : Number(raw);
    if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
    return n;
  };
  return {
    out: value("--out"),
    skills: number("--skills", PRESETS[preset].skills),
    servers: number("--servers", PRESETS[preset].servers),
    tools: number("--tools", PRESETS[preset].tools),
    seed: number("--seed", 1),
    mcpOut: value("--mcp-out"),
    force: argv.includes("--force"),
  };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.out) throw new Error("usage: node scripts/mock-extensions.mjs --out <dir> [--preset small|medium|large] [--mcp-out <file>] [--force]");
  const out = resolve(opts.out);
  const skillsDir = join(out, ".agents", "skills");
  // The MCP JSON goes to --mcp-out when given, otherwise to <out>/.mcp.json.
  const mcpTarget = resolve(opts.mcpOut ?? join(out, ".mcp.json"));
  const manifestPath = join(out, "mock-manifest.json");
  const skillConflict = existsSync(skillsDir) && readdirSync(skillsDir).length > 0;
  const mcpConflict = existsSync(mcpTarget);
  const manifestConflict = existsSync(manifestPath);
  if (skillConflict || mcpConflict || manifestConflict) {
    if (!opts.force) {
      const path = skillConflict ? `${skillsDir} already exists and is not empty` : mcpConflict ? `${mcpTarget} already exists` : `${manifestPath} already exists`;
      throw new Error(`${path}; pass --force to overwrite`);
    }
    for (const path of [skillsDir, mcpTarget, manifestPath]) rmSync(path, { recursive: true, force: true });
  }

  const { files } = generate({ ...opts, serverScript });
  for (const file of files) {
    const target = file.path === ".mcp.json" && opts.mcpOut ? mcpTarget : join(out, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content);
  }
  console.log(`wrote ${opts.skills} skills, ${opts.servers} servers x ${opts.tools} tools to ${out}`);
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
