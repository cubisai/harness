import { readFileSync } from "node:fs";

// Loads the JSON config at `path`.
export function loadConfig(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
