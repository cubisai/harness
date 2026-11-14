// Design live run: the same design prompts on each agent, one new design thread (Auto, Full) per prompt, in the
// bench's own app copy. Records per turn the style picked, pages written, tools used, the agent's last lint and
// usage; `bench/design-score.ts` lints and screenshots the pages afterwards.
//
//   bun bench/design-live.ts --out <dir> [--root <app checkout>] [--agents claude,codex] [--prompts 1-10 | 1,3,4] [--port 9490]

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { designDirName } from "../src/shared/design";
import { launchApp, registerProject, threadEvents, threadRow } from "./lib/app";
import { Cdp } from "./lib/cdp";
import type { BenchEvent } from "./lib/metrics";
import type { BenchAgent } from "./lib/types";

const ROOT = join(import.meta.dirname, "..");
const POLL_MS = 5_000;
const QUIET_MS = 10_000;
const TURN_MS = 12 * 60_000;
const STALL_MS = 5 * 60_000;

export const DESIGN_PROMPTS = [
  "Landing page, note-taking app",
  "Pricing card, pro plan",
  "Mobile login",
  "Analytics dashboard",
  "Docs page, CLI install",
  "Photographer portfolio",
  "Pitch deck, coffee",
  "Settings, team chat",
  "Game main menu",
  "Finance app home",
];

export interface DesignRun {
  agent: string;
  model: string;
  index: number;
  prompt: string;
  threadId: string;
  /** Folder holding the design, absolute. */
  dir: string;
  end: "ended" | "stalled" | "timeout";
  style: string | null;
  surface: string | null;
  pages: string[];
  tools: Record<string, number>;
  /** The agent's own last design_lint result line, if it ran one. */
  lastLint: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  durationMs: number;
  errors: string[];
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function range(spec: string | undefined): number[] {
  if (!spec) return DESIGN_PROMPTS.map((_, i) => i + 1);
  const out: number[] = [];
  for (const part of spec.split(",")) {
    const [a, b] = part.split("-").map(Number);
    for (let i = a!; i <= (b ?? a!); i++) out.push(i);
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A CDP call that can't hang the run (the app may be busy stopping a turn). */
const within = <T>(p: Promise<T>, ms = 30_000): Promise<T | undefined> => Promise.race([p, sleep(ms).then(() => undefined)]);

async function waitIdle(userDataDir: string, threadId: string, until: number): Promise<DesignRun["end"]> {
  let count = -1;
  let lastChange = Date.now();
  while (Date.now() < until) {
    await sleep(POLL_MS);
    const events = threadEvents(userDataDir, threadId);
    if (events.length !== count) {
      count = events.length;
      lastChange = Date.now();
    }
    const top = events.filter((e) => !e.parentId);
    const starts = top.filter((e) => e.kind === "turn-start").length;
    const ends = top.filter((e) => e.kind === "turn-end").length;
    if (ends >= 1 && ends >= starts && Date.now() - lastChange >= QUIET_MS) return "ended";
    if (Date.now() - lastChange > STALL_MS) return "stalled";
  }
  return "timeout";
}

function summarize(events: BenchEvent[]): Pick<DesignRun, "tools" | "lastLint" | "inputTokens" | "outputTokens" | "costUsd" | "durationMs" | "errors"> {
  const tools: Record<string, number> = {};
  let lastLint: string | null = null;
  const lintIds = new Set<string>();
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd: number | null = null;
  let durationMs = 0;
  const errors: string[] = [];
  for (const e of events as unknown as Array<Record<string, unknown>>) {
    if (e.kind === "tool-use" && !e.parentId) {
      const name = String(e.name);
      tools[name] = (tools[name] ?? 0) + 1;
      if (/design_lint/.test(name)) lintIds.add(String(e.toolUseId));
    } else if (e.kind === "tool-result" && lintIds.has(String(e.toolUseId))) {
      lastLint = String(e.summary).split("\n")[0]!.slice(0, 200);
    } else if (e.kind === "turn-end" && !e.parentId) {
      inputTokens += Number(e.inputTokens) || 0;
      outputTokens += Number(e.outputTokens) || 0;
      if (typeof e.costUsd === "number") costUsd = (costUsd ?? 0) + e.costUsd;
      durationMs += Number(e.durationMs) || 0;
    } else if (e.kind === "error") {
      errors.push(String(e.message).slice(0, 200));
    }
  }
  return { tools, lastLint, inputTokens, outputTokens, costUsd, durationMs, errors };
}

function pagesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /\.html?$/i.test(f)).sort();
}

async function runAgent(cdp: Cdp, userDataDir: string, project: { id: string; dir: string }, agent: BenchAgent, prompts: number[], out: string): Promise<DesignRun[]> {
  const runs: DesignRun[] = [];
  for (const index of prompts) {
    const file = join(out, `${agent.id}-${String(index).padStart(2, "0")}.json`);
    if (existsSync(file)) {
      runs.push(JSON.parse(readFileSync(file, "utf8")) as DesignRun);
      continue;
    }
    const prompt = DESIGN_PROMPTS[index - 1]!;
    const thread = await cdp.call<{ id: string }>("createThread", project.id, agent.agent, { kind: "design", designSystem: "auto" });
    await cdp.call("updateThread", thread.id, { agent: agent.agent, model: agent.model, permissionMode: "full", title: `design-live ${agent.id} ${index}` });
    const row = threadRow(userDataDir, thread.id);
    if (row?.agent !== agent.agent || row.model !== agent.model) throw new Error(`thread ${thread.id} is ${JSON.stringify(row)}, wanted ${agent.agent}/${agent.model}`);
    console.log(`[${agent.id}] #${index} ${prompt} → ${thread.id}`);
    await cdp.evaluate(`(window.unskilled.send(${JSON.stringify({ threadId: thread.id, text: prompt })}).catch((e) => console.error("design-live send", e)), true)`);
    const end = await waitIdle(userDataDir, thread.id, Date.now() + TURN_MS);
    if (end !== "ended") {
      await within(cdp.call("interrupt", thread.id).catch(() => undefined));
      await sleep(10_000);
    }
    const threads = (await within(cdp.call<Array<{ id: string; designDirection?: { style: string; surface: string } }>>("listThreads", project.id).catch(() => []))) ?? [];
    const direction = threads.find((t) => t.id === thread.id)?.designDirection;
    const dir = join(project.dir, designDirName(thread.id));
    const run: DesignRun = {
      agent: agent.id,
      model: agent.model,
      index,
      prompt,
      threadId: thread.id,
      dir,
      end,
      style: direction?.style ?? null,
      surface: direction?.surface ?? null,
      pages: pagesIn(dir),
      ...summarize(threadEvents(userDataDir, thread.id)),
    };
    writeFileSync(file, `${JSON.stringify(run, null, 2)}\n`);
    console.log(`[${agent.id}] #${index} ${end}: style ${run.style}, pages ${run.pages.join(",") || "-"}, ${run.inputTokens} in / ${run.outputTokens} out, $${run.costUsd?.toFixed(3) ?? "?"}, lint ${run.lastLint ?? "-"}`);
    runs.push(run);
  }
  return runs;
}

async function main(): Promise<void> {
  const out = resolve(arg("out") ?? "");
  if (!arg("out")) throw new Error("--out <dir> is required");
  const root = resolve(arg("root") ?? ROOT);
  const port = Number(arg("port") ?? 9490);
  const wanted = (arg("agents") ?? "claude,codex").split(",");
  const all = JSON.parse(readFileSync(join(ROOT, "bench/agents.json"), "utf8")) as BenchAgent[];
  const agents = wanted.map((id) => {
    const agent = all.find((a) => a.id === id);
    if (!agent) throw new Error(`unknown agent ${id}`);
    return agent;
  });
  const prompts = range(arg("prompts"));
  mkdirSync(out, { recursive: true });

  const userDataDir = join(out, "profile");
  const projectDir = join(out, "project");
  if (!existsSync(join(projectDir, ".git"))) {
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "README.md"), "# Design live run\n");
    execFileSync("git", ["init", "-q"], { cwd: projectDir });
    execFileSync("git", ["-c", "user.name=bench", "-c", "user.email=bench@localhost", "commit", "-qam", "start", "--allow-empty"], { cwd: projectDir });
  }
  const project = { id: registerProject(userDataDir, projectDir), dir: projectDir };
  const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  writeFileSync(join(out, "meta.json"), `${JSON.stringify({ root, commit, agents: wanted, prompts, startedAt: new Date().toISOString() }, null, 2)}\n`);

  const app = await launchApp({ root, port, userDataDir, log: join(out, "app.log") });
  try {
    const cdp = await Cdp.connect(port);
    // Agents run side by side; each runs its prompts in order.
    const results = await Promise.all(agents.map((a) => runAgent(cdp, userDataDir, project, a, prompts, out)));
    writeFileSync(join(out, "runs.json"), `${JSON.stringify(results.flat(), null, 2)}\n`);
    cdp.close();
  } finally {
    await app.stop();
  }
}

if (import.meta.main) await main();
