// Daily harness bench: drives the real app (its own dev copy over CDP) through
// a fixed task set per agent and model, then grades and measures each run.
//   bun run bench [--agents a,b] [--tasks x,y] [--k 3] [--serial] [--port 9466]
//                 [--attach <port> --user-data-dir <dir>] [--dry]
// Committed: bench/results/history.csv (a row per run), <YYYY-MM-DD>.md and README.md.
// Local: bench/.state/runs/<YYYY-MM-DD>/<agent>--<task>--t<n>.json (the full record).
// Plan: .ai/plans/bench-daily.md.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { grade, score } from "../evals/lib/graders";
import { compact } from "../evals/lib/runner";
import type { CompactEvent, Task } from "../evals/lib/types";
import { runCheck } from "../src/main/check";
import { execCommandSync } from "../src/main/winspawn";
import { launchApp, registerProject, threadEvents, threadRow, type App } from "./lib/app";
import { Cdp } from "./lib/cdp";
import { runMetrics, todoOk, type BenchEvent } from "./lib/metrics";
import { appendHistory, toRow, writeReports } from "./lib/results";
import type { BenchAgent, BenchTask, RunResult } from "./lib/types";

const ROOT = join(import.meta.dirname, "..");
const BENCH = join(ROOT, "bench");
const STATE = join(BENCH, ".state");
const RESULTS = join(BENCH, "results");
const POLL_MS = 5_000;
const TIMEOUT_MS = 15 * 60_000;
/** No new event for this long = stalled (free tiers sometimes never answer): interrupt and retry once. */
const STALL_MS = 5 * 60_000;
/** Free or rate-limited providers: at least this long between two of their runs. */
const SPACING_MS = 90_000;
/** After a rate-limit error: wait, then retry the run once. */
const RATE_LIMIT_WAIT_MS = 180_000;
const RATE_LIMIT = /rate.?limit|429|quota|allowance|exhausted/i;

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name: string): boolean => argv.includes(`--${name}`);
const list = (name: string): string[] | undefined => flag(name)?.split(",").map((s) => s.trim()).filter(Boolean);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (msg: string) => console.log(`[${new Date().toTimeString().slice(0, 8)}] ${msg}`);

/** Today in local time, YYYY-MM-DD. */
function localDate(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function loadTasks(only?: string[]): BenchTask[] {
  const all = readdirSync(join(BENCH, "tasks"))
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(BENCH, "tasks", f), "utf8")) as BenchTask);
  const unknown = only?.filter((id) => !all.some((t) => t.id === id)) ?? [];
  if (unknown.length) throw new Error(`unknown task ${unknown.join(", ")}; have ${all.map((t) => t.id).join(", ")}`);
  return only ? all.filter((t) => only.includes(t.id)) : all;
}

function loadAgents(only?: string[]): BenchAgent[] {
  const all = JSON.parse(readFileSync(join(BENCH, "agents.json"), "utf8")) as BenchAgent[];
  const unknown = only?.filter((id) => !all.some((a) => a.id === id)) ?? [];
  if (unknown.length) throw new Error(`unknown agent ${unknown.join(", ")}; have ${all.map((a) => a.id).join(", ")}`);
  return only ? all.filter((a) => only.includes(a.id)) : all;
}

function tryRun(command: string, args: string[], cwd = ROOT): string | null {
  try {
    return execCommandSync(command, args, { cwd, timeout: 20_000 }).trim();
  } catch {
    return null;
  }
}

function harnessInfo(): RunResult["harness"] {
  const commit = tryRun("git", ["rev-parse", "HEAD"]) ?? "unknown";
  // Bench output itself never counts as a harness change.
  const dirty = (tryRun("git", ["status", "--porcelain", "--", ".", ":(exclude)bench/results"]) ?? "") !== "";
  const versions: Record<string, string> = {};
  for (const cli of ["claude", "codex", "opencode"]) {
    const v = tryRun(cli, ["--version"])?.match(/\d+\.\d+\.\d+/)?.[0];
    if (v) versions[cli] = v;
  }
  return { commit, dirty, versions };
}

/** A clean copy of this repo at `sha`, extracted once; agent guide files left out so every agent starts equal. */
function pinnedTree(sha: string): string {
  const dir = join(STATE, "pinned", sha);
  if (existsSync(join(dir, ".bench-ready"))) return dir;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const tar = join(STATE, "pinned", `${sha}.tar`);
  execFileSync("git", ["archive", "-o", tar, sha], { cwd: ROOT });
  execFileSync("tar", ["-xf", tar, "-C", dir]);
  rmSync(tar, { force: true });
  for (const p of ["CLAUDE.md", "AGENTS.md", ".claude", ".ai", ".agents", ".cubiq", ".opencode"]) rmSync(join(dir, p), { recursive: true, force: true });
  writeFileSync(join(dir, ".bench-ready"), "");
  return dir;
}

/** Empties the run's project folder and lays the task's starting state into it. */
function resetProject(task: BenchTask, dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const from = task.pinned ? pinnedTree(task.pinned) : join(BENCH, "fixtures", task.fixture!);
  cpSync(from, dir, { recursive: true, filter: (src) => !src.endsWith(".bench-ready") });
  if (task.git) {
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=bench", "-c", "user.email=bench@localhost", "-c", "core.autocrlf=false", ...args], { cwd: dir, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-q", "-m", "start");
  }
}

/** The text after the last top-level tool call: the agent's final answer, not its working notes. */
function finalAnswerEvents(events: BenchEvent[]): CompactEvent[] {
  const top = events.filter((e) => !e.parentId);
  const lastTool = top.findLastIndex((e) => e.kind === "tool-use" || e.kind === "tool-result");
  return top
    .map((e, i) => (e.kind === "assistant-text" && i < lastTool ? null : compact(e)))
    .filter((e): e is CompactEvent => e !== null);
}

interface Ctx {
  cdp: Cdp;
  userDataDir: string;
  date: string;
  harness: RunResult["harness"];
  projects: Map<string, { id: string; dir: string }>;
}

const projectKey = (task: BenchTask, agent: BenchAgent) => `${task.id}/${agent.id}`;

async function runOnce(ctx: Ctx, agent: BenchAgent, task: BenchTask, trial: number): Promise<RunResult> {
  const project = ctx.projects.get(projectKey(task, agent))!;
  resetProject(task, project.dir);
  const startedAt = new Date().toISOString();
  const thread = await ctx.cdp.call<{ id: string }>("createThread", project.id, agent.agent);
  await ctx.cdp.call("updateThread", thread.id, { agent: agent.agent, model: agent.model, permissionMode: "full" });
  const row = threadRow(ctx.userDataDir, thread.id);
  if (row?.agent !== agent.agent || row.model !== agent.model || row.permission_mode !== "full") {
    throw new Error(`thread ${thread.id} is ${JSON.stringify(row)}, wanted ${agent.agent}/${agent.model}/full`);
  }
  // Not awaited: send can resolve late; the turn's end is read from the database.
  await ctx.cdp.evaluate(`(window.unskilled.send(${JSON.stringify({ threadId: thread.id, text: task.prompt })}).catch((e) => console.error("bench send", e)), true)`);

  const timeout = task.timeoutMs ?? TIMEOUT_MS;
  const until = Date.now() + timeout;
  let events: BenchEvent[] = [];
  let ended = false;
  let stalled = false;
  let lastChange = Date.now();
  while (Date.now() < until) {
    await sleep(POLL_MS);
    const now = threadEvents(ctx.userDataDir, thread.id);
    if (now.length !== events.length) lastChange = Date.now();
    events = now;
    if (events.some((e) => e.kind === "turn-end" && !e.parentId)) {
      ended = true;
      break;
    }
    if (Date.now() - lastChange > STALL_MS) {
      stalled = true;
      break;
    }
  }
  if (!ended) {
    await ctx.cdp.call("interrupt", thread.id).catch(() => undefined);
    await sleep(10_000);
    events = threadEvents(ctx.userDataDir, thread.id);
  }

  const fixtureDir = task.pinned ? pinnedTree(task.pinned) : join(BENCH, "fixtures", task.fixture!);
  const hidden = task.fixture ? join(BENCH, "fixtures", `${task.fixture}.hidden`) : null;
  if (hidden && existsSync(hidden)) cpSync(hidden, project.dir, { recursive: true, force: true });
  const evalTask = { id: task.id, tags: ["regression"], tier: "smoke", fixture: task.fixture ?? "", prompt: task.prompt, mode: "full", graders: task.graders, budget: { maxSteps: 0, maxInputTokens: 0, timeoutMs: timeout } } satisfies Task;
  const graders = await grade({
    task: evalTask,
    events: finalAnswerEvents(events),
    dir: project.dir,
    fixtureDir,
    overBudget: false,
    runCommand: async (command, cwd, timeoutMs) => {
      const r = await runCheck(command, cwd, { timeoutMs });
      return { ok: r.ok, exitCode: r.exitCode, tail: r.tail };
    },
  });
  const graded = score(graders);
  const metrics = runMetrics(events, new Map(Object.entries(task.sentinels ?? {})));
  const checks = {
    todo: todoOk(metrics, task.expect.todo),
    runCode: task.expect.runCode === undefined ? null : task.expect.runCode === metrics.tools.runCode > 0,
    skills: task.expect.skills ? task.expect.skills.every((s) => metrics.skills.includes(s)) : null,
  };
  return {
    date: ctx.date,
    startedAt,
    task: task.id,
    agent: agent.id,
    model: agent.model,
    trial,
    harness: ctx.harness,
    threadId: thread.id,
    status: stalled ? "stalled" : !ended ? "timeout" : metrics.errors.length && !graded.pass ? "error" : graded.pass ? "passed" : "failed",
    pass: ended && graded.pass,
    graders,
    checks,
    metrics: { ...metrics, answer: metrics.answer.slice(0, 2000) },
    ...(ended ? {} : { note: stalled ? `no activity for ${STALL_MS / 60_000} min` : `no turn-end within ${Math.round(timeout / 60_000)} min` }),
  };
}

async function runWithRetry(ctx: Ctx, agent: BenchAgent, task: BenchTask, trial: number): Promise<RunResult> {
  const first = await runOnce(ctx, agent, task, trial);
  const why = first.status === "stalled" ? "a stall" : !first.pass && first.metrics.errors.some((e) => RATE_LIMIT.test(e)) ? "a rate limit" : null;
  if (!why) return first;
  log(`${agent.id} ${task.id}: ${why}, retrying in ${RATE_LIMIT_WAIT_MS / 1000} s`);
  await sleep(RATE_LIMIT_WAIT_MS);
  const second = await runOnce(ctx, agent, task, trial);
  return { ...second, note: [second.note, `retried after ${why}`].filter(Boolean).join("; ") };
}

/** Registers each native provider once per bench profile; an agent whose key is missing is dropped. */
async function ensureProviders(cdp: Cdp, agents: BenchAgent[]): Promise<BenchAgent[]> {
  const have = new Set((await cdp.call<{ id: string }[]>("listProviders")).map((p) => p.id));
  const ready: BenchAgent[] = [];
  for (const a of agents) {
    if (!a.provider) {
      ready.push(a);
      continue;
    }
    if (!process.env[a.provider.envVar]) {
      log(`skip ${a.id}: ${a.provider.envVar} is not set (run through \`bun run bench\`, which loads .env)`);
      continue;
    }
    if (!have.has(a.provider.id)) {
      const input = { id: a.provider.id, label: a.provider.label, wireProtocol: "openai-chat", baseURL: a.provider.baseURL, secret: { kind: "envRef", envVar: a.provider.envVar }, models: [] };
      const found = await cdp.call<{ ok: boolean; models?: { id: string }[] }>("discoverProviderModels", input).catch(() => ({ ok: false }) as const);
      const listed = found.ok ? found.models?.find((m) => m.id === a.model) : undefined;
      const model = listed ?? { id: a.model, capabilities: { tools: true, vision: false, reasoning: true }, contextWindow: 128_000, maxOutput: 8_000 };
      await cdp.call("saveProvider", { ...input, models: [model] });
      have.add(a.provider.id);
      log(`registered provider ${a.provider.id} (${listed ? "listed model" : "default limits"})`);
    }
    ready.push(a);
  }
  return ready;
}

async function main(): Promise<void> {
  const tasks = loadTasks(list("tasks"));
  let agents = loadAgents(list("agents"));
  const k = Number(flag("k") ?? 1);
  const date = flag("date") ?? localDate();
  const attach = flag("attach");
  const port = Number(attach ?? flag("port") ?? 9466);
  const userDataDir = flag("user-data-dir") ?? join(STATE, "ud");
  if (attach && !flag("user-data-dir")) throw new Error("--attach needs --user-data-dir <that app's profile folder>");

  log(`${date}: ${tasks.length} tasks × ${agents.length} agents × k=${k} = ${tasks.length * agents.length * k} runs`);
  if (has("dry")) {
    for (const a of agents) for (const t of tasks) log(`  ${a.id} (${a.agent} ${a.model}) · ${t.id}`);
    return;
  }

  const projects = new Map<string, { id: string; dir: string }>();
  for (const t of tasks) {
    if (t.pinned) pinnedTree(t.pinned);
    for (const a of agents) {
      const dir = join(STATE, "work", t.id, a.id);
      mkdirSync(dir, { recursive: true });
      projects.set(projectKey(t, a), { id: registerProject(userDataDir, dir), dir });
    }
  }

  let app: App | null = null;
  if (!attach) {
    log(`starting the app on port ${port} (log: bench/.state/app.log)`);
    app = await launchApp({ root: ROOT, port, userDataDir, log: join(STATE, "app.log") });
  }
  const cdp = await Cdp.connect(port);
  const out = join(STATE, "runs", date);
  mkdirSync(out, { recursive: true });
  try {
    await cdp.call("updateSettings", { codeMode: "on" });
    agents = await ensureProviders(cdp, agents);
    const ctx: Ctx = { cdp, userDataDir, date, harness: harnessInfo(), projects };

    // One chain per agent; chains run side by side unless --serial (each agent has its own project folders).
    const chain = async (agent: BenchAgent) => {
      let lastEnd = 0;
      for (let trial = 1; trial <= k; trial++) {
        for (const task of tasks) {
          if (agent.spaced) await sleep(Math.max(0, lastEnd + SPACING_MS - Date.now()));
          log(`${agent.id} · ${task.id} · t${trial}: start`);
          let result: RunResult;
          try {
            result = await runWithRetry(ctx, agent, task, trial);
          } catch (err) {
            log(`${agent.id} · ${task.id}: harness error ${err instanceof Error ? err.message : err}`);
            continue;
          }
          lastEnd = Date.now();
          writeFileSync(join(out, `${agent.id}--${task.id}--t${trial}.json`), `${JSON.stringify(result, null, 2)}\n`);
          appendHistory(RESULTS, [toRow(result)]);
          const m = result.metrics;
          log(`${agent.id} · ${task.id} · t${trial}: ${result.status} in ${Math.round(m.durationMs / 1000)} s, run_code ${m.tools.runCode}, todo ${m.todo.updates}, checks ${JSON.stringify(result.checks)}`);
        }
      }
    };
    if (has("serial")) for (const a of agents) await chain(a);
    else await Promise.all(agents.map(chain));
  } finally {
    cdp.close();
    await app?.stop();
  }
  log(`report: ${writeReports(RESULTS, date)}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
