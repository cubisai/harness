// Daily harness bench: drives the real app (its own dev copy over CDP) through
// a fixed task set per agent and model, then grades and measures each run.
//   bun run bench [--suite core|full|behaviour|solve|memory|context] [--agents a,b] [--tasks x,y]
//                 [--k 3] [--parallel 3] [--serial] [--background-agent <id>] [--port 9488] [--attach <port> --user-data-dir <dir>] [--dry] [--scratch]
// Local reports: bench/results/history.csv (a row per run), <YYYY-MM-DD>.md and README.md.
// Local: bench/.state/runs/<YYYY-MM-DD>/<agent>--<task>--t<n>.json (the full record).

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { grade, score } from "../evals/lib/graders";
import { compact } from "../evals/lib/runner";
import type { CompactEvent, Task } from "../evals/lib/types";
import { runCheck } from "../src/main/check";
import { execCommandSync } from "../src/main/winspawn";
import type { Health, LearnOverview, TurnScore } from "../src/shared/learn";
import type { MemoryOverview } from "../src/shared/types";
import { launchApp, registerProject, threadEvents, threadRow, type App } from "./lib/app";
import { Cdp } from "./lib/cdp";
import { runMetrics, todoOk, type BenchEvent } from "./lib/metrics";
import { resetProject, revealHidden, sourceOf } from "./lib/project";
import { appendHistory, toRow, writeReports } from "./lib/results";
import type { BenchAgent, BenchTask, RunResult } from "./lib/types";

const ROOT = join(import.meta.dirname, "..");
const BENCH = join(ROOT, "bench");
const STATE = join(BENCH, ".state");
const POLL_MS = 5_000;
const TIMEOUT_MS = 15 * 60_000;
/** No new event for this long = stalled (free tiers sometimes never answer): interrupt and retry once. */
const STALL_MS = 5 * 60_000;
/** A thread is idle once its turns have all ended, no check is running and nothing new arrived for this long (a check's fix round starts within it). */
const QUIET_MS = 10_000;
/** How long a follow-up waits for the memory note the previous message asked for. */
const MEMORY_WAIT_MS = 120_000;
/** Free or rate-limited providers: at least this long between two of their runs. */
const SPACING_MS = 90_000;
/** After a rate-limit error or a stall: wait, then retry the run once. */
const RETRY_WAIT_MS = 180_000;
const RATE_LIMIT = /rate.?limit|429|quota|allowance|exhausted/i;
/** Lesson drafts start 30 s after a failed turn, and only while no turn runs: give the last one this long before checking. */
const DRAFT_SETTLE_MS = 35_000;
/** Longest wait for the learner's queue to drain after the last run. */
const DRAIN_MS = 10 * 60_000;

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name: string): boolean => argv.includes(`--${name}`);
const list = (name: string): string[] | undefined => flag(name)?.split(",").map((s) => s.trim()).filter(Boolean);
/** --scratch keeps trial results separate from the local day-by-day history. */
const RESULTS = has("scratch") ? join(STATE, "scratch-results") : join(BENCH, "results");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (msg: string) => console.log(`[${new Date().toTimeString().slice(0, 8)}] ${msg}`);

/** Today in local time, YYYY-MM-DD. */
function localDate(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function loadTasks(suite: string, only?: string[]): BenchTask[] {
  const all = readdirSync(join(BENCH, "tasks"))
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(BENCH, "tasks", f), "utf8")) as BenchTask);
  const unknown = only?.filter((id) => !all.some((t) => t.id === id)) ?? [];
  if (unknown.length) throw new Error(`unknown task ${unknown.join(", ")}; have ${all.map((t) => t.id).join(", ")}`);
  if (only) return all.filter((t) => only.includes(t.id));
  if (suite === "full") return all;
  if (suite === "core") return all.filter((t) => t.core);
  const picked = all.filter((t) => t.suite === suite);
  if (!picked.length) throw new Error(`unknown suite ${suite}; use core, full, behaviour, solve, memory or context`);
  return picked;
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
  /** Self-improve on per project id, applied before each run. */
  learnFor(projectId: string, on: boolean): Promise<void>;
}

const projectKey = (task: BenchTask, agent: BenchAgent) => `${task.id}/${agent.id}`;

type WaitEnd = "ended" | "stalled" | "timeout";

/** Waits until the thread has ended `sends` turns (plus any check fix rounds) and gone quiet. */
async function waitIdle(ctx: Ctx, threadId: string, sends: number, until: number): Promise<WaitEnd> {
  let count = -1;
  let lastChange = Date.now();
  while (Date.now() < until) {
    await sleep(POLL_MS);
    const events = threadEvents(ctx.userDataDir, threadId);
    if (events.length !== count) {
      count = events.length;
      lastChange = Date.now();
    }
    const top = events.filter((e) => !e.parentId);
    const starts = top.filter((e) => e.kind === "turn-start").length;
    const ends = top.filter((e) => e.kind === "turn-end").length;
    const lastCheck = top.findLast((e) => e.kind === "check");
    const checking = lastCheck?.kind === "check" && lastCheck.ok === null;
    if (ends >= sends && ends >= starts && !checking && Date.now() - lastChange >= QUIET_MS) return "ended";
    if (Date.now() - lastChange > STALL_MS) return "stalled";
  }
  return "timeout";
}

async function newThread(ctx: Ctx, agent: BenchAgent, projectId: string): Promise<string> {
  const thread = await ctx.cdp.call<{ id: string }>("createThread", projectId, agent.agent);
  await ctx.cdp.call("updateThread", thread.id, { agent: agent.agent, model: agent.model, permissionMode: "full" });
  const row = threadRow(ctx.userDataDir, thread.id);
  if (row?.agent !== agent.agent || row.model !== agent.model || row.permission_mode !== "full") {
    throw new Error(`thread ${thread.id} is ${JSON.stringify(row)}, wanted ${agent.agent}/${agent.model}/full`);
  }
  return thread.id;
}

const send = (ctx: Ctx, threadId: string, text: string) =>
  // Not awaited: send can resolve late; the turn's end is read from the database.
  ctx.cdp.evaluate(`(window.unskilled.send(${JSON.stringify({ threadId, text })}).catch((e) => console.error("bench send", e)), true)`);

const projectNotes = async (ctx: Ctx, projectId: string): Promise<MemoryOverview> => ctx.cdp.call<MemoryOverview>("memoryOverview", projectId);

/** Clears the project's own memory notes and writes the task's. */
async function seedMemory(ctx: Ctx, projectId: string, task: BenchTask): Promise<void> {
  const overview = await projectNotes(ctx, projectId);
  if (!overview.projectOn) await ctx.cdp.call("memorySetEnabled", projectId, true);
  for (const n of overview.notes) await ctx.cdp.call("memoryDelete", projectId, n.file, "project");
  for (const note of task.memory ?? []) await ctx.cdp.call("memoryWrite", projectId, note, "project");
}

const HEALTH_ORDER: Health[] = ["fail", "warn", "ok"];

async function runOnce(ctx: Ctx, agent: BenchAgent, task: BenchTask, trial: number): Promise<RunResult> {
  const project = ctx.projects.get(projectKey(task, agent))!;
  resetProject(task, project.dir);
  await ctx.cdp.call("setCheckCommand", project.id, task.check?.command ?? null, task.check?.fixRounds ?? null);
  await ctx.learnFor(project.id, Boolean(task.learn));
  // Memory tasks start from exactly their notes; other projects keep what the harness remembered.
  if (task.suite === "memory") await seedMemory(ctx, project.id, task);
  const notesBefore = (await projectNotes(ctx, project.id)).notes.length;

  const startedAt = new Date().toISOString();
  const timeout = task.timeoutMs ?? TIMEOUT_MS;
  const until = Date.now() + timeout;
  const threadIds: string[] = [];
  let end: WaitEnd = "ended";
  let memoryHeld: boolean | null = null;
  const steps = [{ prompt: task.prompt, newThread: true, afterMemory: false }, ...(task.then ?? [])];
  let sends = 0;
  for (const step of steps) {
    if (step.afterMemory) {
      const wait = Date.now() + MEMORY_WAIT_MS;
      let notes = (await projectNotes(ctx, project.id)).notes.length;
      while (notes <= notesBefore && Date.now() < wait) {
        await sleep(POLL_MS);
        notes = (await projectNotes(ctx, project.id)).notes.length;
      }
      memoryHeld = notes > notesBefore;
    }
    if (step.newThread || !threadIds.length) {
      threadIds.push(await newThread(ctx, agent, project.id));
      sends = 0;
    }
    const threadId = threadIds.at(-1)!;
    await send(ctx, threadId, step.prompt);
    sends++;
    end = await waitIdle(ctx, threadId, sends, until);
    if (end !== "ended") {
      await ctx.cdp.call("interrupt", threadId).catch(() => undefined);
      await sleep(10_000);
      break;
    }
  }

  const events = threadIds.flatMap((id) => threadEvents(ctx.userDataDir, id));
  const fixtureDir = sourceOf(task);
  revealHidden(task, project.dir);
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
  const notesAfter = (await projectNotes(ctx, project.id)).notes.length;
  if (task.expect.memoryWritten && memoryHeld === null) memoryHeld = notesAfter > notesBefore;
  let learn: RunResult["learn"] = null;
  if (task.learn) {
    const scores = (await Promise.all(threadIds.map((id) => ctx.cdp.call<TurnScore[]>("learnScores", id)))).flat();
    const overview = await ctx.cdp.call<LearnOverview>("learnOverview", project.id);
    learn = { health: scores.map((s) => s.health).sort((a, b) => HEALTH_ORDER.indexOf(a) - HEALTH_ORDER.indexOf(b)), lessons: activeLessons(overview) };
  }
  const ended = end === "ended";
  return {
    date: ctx.date,
    startedAt,
    task: task.id,
    suite: task.suite,
    tier: task.tier ?? null,
    agent: agent.id,
    model: agent.model,
    trial,
    harness: ctx.harness,
    threadIds,
    status: end === "stalled" ? "stalled" : end === "timeout" ? "timeout" : metrics.errors.length && !graded.pass ? "error" : graded.pass ? "passed" : "failed",
    pass: ended && graded.pass,
    score: graded.score,
    graders,
    checks: {
      todo: todoOk(metrics, task.expect.todo),
      runCode: task.expect.runCode === undefined ? null : task.expect.runCode === metrics.tools.runCode > 0,
      skills: task.expect.skills ? task.expect.skills.every((s) => metrics.skills.includes(s)) : null,
      memory: task.expect.memoryWritten ? memoryHeld === true : null,
    },
    metrics: { ...metrics, answer: metrics.answer.slice(0, 2000) },
    memoryNotes: { before: notesBefore, after: notesAfter },
    learn,
    ...(ended ? {} : { note: end === "stalled" ? `no activity for ${STALL_MS / 60_000} min` : `not done within ${Math.round(timeout / 60_000)} min` }),
  };
}

async function runWithRetry(ctx: Ctx, agent: BenchAgent, task: BenchTask, trial: number): Promise<RunResult> {
  const first = await runOnce(ctx, agent, task, trial);
  const why = first.status === "stalled" ? "a stall" : !first.pass && first.metrics.errors.some((e) => RATE_LIMIT.test(e)) ? "a rate limit" : null;
  if (!why) return first;
  log(`${agent.id} ${task.id}: ${why}, retrying in ${RETRY_WAIT_MS / 1000} s`);
  await sleep(RETRY_WAIT_MS);
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

/** Self-improve settings: a project-by-project switch, and the cheap background model its drafts and memory extraction run on. */
async function learnSwitch(cdp: Cdp, agents: BenchAgent[]): Promise<Ctx["learnFor"]> {
  const backgroundId = flag("background-agent");
  const bg = agents.find((a) => a.id === backgroundId);
  if (backgroundId && !bg) throw new Error(`background agent ${backgroundId} must be included in the selected agents`);
  const settings = await cdp.call<{ learn?: { enabledProjects: string[]; background: { agent: string; model: string } | null } & Record<string, unknown> }>("getSettings");
  const learn = settings.learn ?? { enabledProjects: [], background: null };
  if (bg) {
    await cdp.call("updateSettings", { learn: { ...learn, background: { agent: bg.agent, model: bg.model } } });
  }
  return async (projectId, on) => {
    const current = (await cdp.call<typeof settings>("getSettings")).learn ?? learn;
    const set = new Set(current.enabledProjects);
    if (on === set.has(projectId)) return;
    if (on) set.add(projectId);
    else set.delete(projectId);
    await cdp.call("updateSettings", { learn: { ...current, enabledProjects: [...set] } });
  };
}

/** Runs `jobs` with at most `limit` going at once. */
async function pool(limit: number, jobs: (() => Promise<void>)[]): Promise<void> {
  const queue = [...jobs];
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    for (let job = queue.shift(); job; job = queue.shift()) await job();
  }));
}

const activeLessons = (o: LearnOverview) => o.lessons.filter((l) => l.status === "active" || l.status === "candidate").length;

/** Waits (capped) until no lesson draft is queued for these projects; true when they all drained. */
async function drainLearner(cdp: Cdp, projectIds: string[], lastEnd: number): Promise<boolean> {
  await sleep(Math.max(0, lastEnd + DRAFT_SETTLE_MS - Date.now()));
  const until = Date.now() + DRAIN_MS;
  for (;;) {
    const waiting = (await Promise.all(projectIds.map((id) => cdp.call<LearnOverview>("learnOverview", id)))).reduce((n, o) => n + o.drafting, 0);
    if (!waiting) return true;
    if (Date.now() >= until) return false;
    log(`self-improve: ${waiting} lesson draft${waiting === 1 ? "" : "s"} still to go`);
    await sleep(POLL_MS);
  }
}

async function main(): Promise<void> {
  const tasks = loadTasks(flag("suite") ?? "core", list("tasks"));
  let agents = loadAgents(list("agents"));
  const k = Number(flag("k") ?? 1);
  const date = flag("date") ?? localDate();
  const attach = flag("attach");
  const port = Number(attach ?? flag("port") ?? 9488);
  const userDataDir = flag("user-data-dir") ?? join(STATE, "ud");
  const parallel = has("serial") ? 1 : Number(flag("parallel") ?? 3);
  if (attach && !flag("user-data-dir")) throw new Error("--attach needs --user-data-dir <that app's profile folder>");

  log(`${date}: ${tasks.length} tasks × ${agents.length} agents × k=${k} = ${tasks.length * agents.length * k} runs, ${parallel} agents at a time`);
  if (has("dry")) {
    for (const t of tasks) log(`  ${t.suite}${t.tier ? `/${t.tier}` : ""} · ${t.id}`);
    for (const a of agents) log(`  ${a.id} (${a.agent} ${a.model})`);
    return;
  }

  // Trees first (a repo task's install can take a minute), then one project per task × agent.
  for (const t of tasks) sourceOf(t);
  const projects = new Map<string, { id: string; dir: string }>();
  for (const t of tasks) {
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
  const out = join(STATE, has("scratch") ? "scratch-runs" : "runs", date);
  mkdirSync(out, { recursive: true });
  try {
    await cdp.call("updateSettings", { codeMode: "on" });
    agents = await ensureProviders(cdp, agents);
    const ctx: Ctx = { cdp, userDataDir, date, harness: harnessInfo(), projects, learnFor: await learnSwitch(cdp, agents) };

    // Learn tasks' records wait for the learner: it drafts lessons only once no turn runs.
    const held: { result: RunResult; file: string; projectId: string }[] = [];
    let lastEnd = 0;
    const record = (result: RunResult, file: string) => {
      writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
      appendHistory(RESULTS, [toRow(result)]);
    };

    // One chain per agent (each has its own project folders); at most `parallel` chains at once.
    const chain = (agent: BenchAgent) => async () => {
      let lastRun = 0;
      for (let trial = 1; trial <= k; trial++) {
        for (const task of tasks) {
          if (agent.spaced) await sleep(Math.max(0, lastRun + SPACING_MS - Date.now()));
          log(`${agent.id} · ${task.id} · t${trial}: start`);
          let result: RunResult;
          try {
            result = await runWithRetry(ctx, agent, task, trial);
          } catch (err) {
            log(`${agent.id} · ${task.id}: harness error ${err instanceof Error ? err.message : err}`);
            continue;
          }
          lastRun = lastEnd = Date.now();
          const file = join(out, `${agent.id}--${task.id}--t${trial}.json`);
          if (result.learn) held.push({ result, file, projectId: ctx.projects.get(projectKey(task, agent))!.id });
          else record(result, file);
          const m = result.metrics;
          log(`${agent.id} · ${task.id} · t${trial}: ${result.status} in ${Math.round(m.durationMs / 1000)} s, score ${result.score.toFixed(2)}, run_code ${m.tools.runCode}, todo ${m.todo.updates}, checks ${JSON.stringify(result.checks)}`);
        }
      }
    };
    await pool(parallel, agents.map(chain));

    if (held.length) {
      const ids = [...new Set(held.map((h) => h.projectId))];
      log(`self-improve: waiting for lesson drafts on ${ids.length} project${ids.length === 1 ? "" : "s"}`);
      let drained = false;
      let lessons = new Map<string, number>();
      try {
        drained = await drainLearner(cdp, ids, lastEnd);
        if (!drained) log(`self-improve: drafts still queued after ${DRAIN_MS / 60_000} min; recording what is there`);
        lessons = new Map(await Promise.all(ids.map(async (id) => [id, activeLessons(await cdp.call<LearnOverview>("learnOverview", id))] as const)));
      } catch (err) {
        log(`self-improve: couldn't read the learner (${err instanceof Error ? err.message : err}); recording lessons as of each run`);
      }
      for (const h of held) {
        const note = drained ? h.result.note : [h.result.note, "lesson drafts still queued at the end"].filter(Boolean).join("; ");
        record({ ...h.result, learn: { ...h.result.learn!, lessons: lessons.get(h.projectId) ?? h.result.learn!.lessons }, ...(note ? { note } : {}) }, h.file);
      }
    }
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
