// The capability model exists so code branches on what an agent can do, never
// on which agent it is. This scans src/main (minus the registry that declares
// the ids) and the renderer for equality against a hard-coded agent id and
// fails if any remain.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ACP_PRESETS, BUILT_IN_AGENT_IDS } from "../src/main/agents/registry";

const MAIN = join(__dirname, "..", "src", "main");
const RENDERER = join(__dirname, "..", "src", "renderer", "src");

/** Every .ts/.tsx file under `dir`, except the registry that declares the ids. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(entry.name) && path !== join(MAIN, "agents", "registry.ts")) out.push(path);
  }
  return out;
}

const ids = [...new Set([...BUILT_IN_AGENT_IDS, ...ACP_PRESETS.map((p) => p.id)])];
const alt = ids.join("|");
const forward = new RegExp(`(?<![\\w$])(?:id|agentId|agent)\\s*(?:===|!==|==|!=)\\s*["'\`](?:${alt})["'\`]`);
const reverse = new RegExp(`["'\`](?:${alt})["'\`]\\s*(?:===|!==|==|!=)\\s*(?:[\\w$]+\\.)*(?:id|agentId|agent)(?![\\w$])`);

describe("no agent-id branches in src/main or the renderer", () => {
  it("the scan's regexes flag id comparisons and leave other fields alone", () => {
    for (const sample of [`if (agentId === "claude") {`, `agent.id !== "antigravity"`, `"codex" === thread.agent`]) {
      expect(forward.test(sample) || reverse.test(sample)).toBe(true);
    }
    for (const clean of [`config.injector === "opencode"`, `r.limitId !== "codex"`, `config.guardPlugin === "opencode"`]) {
      expect(forward.test(clean) || reverse.test(clean)).toBe(false);
    }
  });

  it("branches on capabilities, never on an agent id", () => {
    const offenders: string[] = [];
    for (const file of [...sourceFiles(MAIN), ...sourceFiles(RENDERER)]) {
      readFileSync(file, "utf-8")
        .split("\n")
        .forEach((text, i) => {
          if (forward.test(text) || reverse.test(text)) offenders.push(`${file}:${i + 1}: ${text}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});
