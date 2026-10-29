// The committed reports: results/<date>.md (one day, deltas against the
// previous day) and results/README.md (every day per agent). A change is
// flagged only when a verdict flips or a value leaves the recent day-to-day
// spread, since single runs are noisy. Pure, so it is unit-tested.

import type { RunRow } from "./results";

export interface DayRuns {
  date: string;
  runs: RunRow[];
}

/** One task × agent × model on one day, trials folded (medians, or counts over trials). */
export interface Cell {
  task: string;
  suite: string;
  tier: string;
  agent: string;
  model: string;
  trials: number;
  passes: number;
  /** Mean share of grader weight passed. */
  score: number;
  /** Trials whose behaviour checks (todo, run_code, skills, memory) all held; null when the task sets none. */
  checksOk: number | null;
  timeMs: number;
  costUsd: number | null;
  /** Input + cache read + cache write. */
  tokensIn: number;
  tokensOut: number;
  /** Cache reads as a share of tokens in. */
  cacheShare: number;
  tools: number;
  runCode: number;
  look: number;
  shell: number;
  edit: number;
  todo: string;
  skills: string;
  memReads: number;
  memWrites: number;
  /** The app's project check: trials where it passed first time / ran at all, the most fix rounds, trials where it passed in the end. */
  checkFirst: number;
  checkRan: number;
  fixRounds: number;
  checkFinal: number;
  /** Trials where the agent ran tests or a typecheck itself. */
  verified: number;
  evidence: number;
  health: string;
  lessons: number;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

const checksOf = (r: RunRow) => [r.todoOk, r.runCodeOk, r.skillsOk, r.memoryOk];
const hasChecks = (r: RunRow) => checksOf(r).some((c) => c !== null);
const checksHeld = (r: RunRow) => checksOf(r).every((c) => c !== false);
const tokensIn = (r: RunRow) => r.tokensIn + r.cacheRead + r.cacheWrite;
const HEALTH = ["fail", "warn", "ok"];

export const cellKey = (r: { task: string; agent: string; model: string }): string => `${r.task}|${r.agent}|${r.model}`;

export function cells(runs: RunRow[]): Map<string, Cell> {
  const groups = new Map<string, RunRow[]>();
  for (const r of runs) groups.set(cellKey(r), [...(groups.get(cellKey(r)) ?? []), r]);
  const out = new Map<string, Cell>();
  for (const [key, rs] of groups) {
    const r0 = rs[0]!;
    const checked = rs.filter(hasChecks);
    const costs = rs.map((r) => r.costUsd);
    const m = (f: (r: RunRow) => number) => median(rs.map(f));
    const n = (f: (r: RunRow) => boolean) => rs.filter(f).length;
    const healths = rs.map((r) => r.health).filter(Boolean).sort((a, b) => HEALTH.indexOf(a) - HEALTH.indexOf(b));
    out.set(key, {
      task: r0.task,
      suite: r0.suite,
      tier: r0.tier,
      agent: r0.agent,
      model: r0.model,
      trials: rs.length,
      passes: n((r) => r.pass),
      score: rs.reduce((s, r) => s + r.score, 0) / rs.length,
      checksOk: checked.length ? checked.filter(checksHeld).length : null,
      timeMs: m((r) => r.durationMs),
      costUsd: costs.every((c) => c !== null) ? median(costs as number[]) : null,
      tokensIn: m(tokensIn),
      tokensOut: m((r) => r.tokensOut),
      cacheShare: m((r) => (tokensIn(r) ? r.cacheRead / tokensIn(r) : 0)),
      tools: m((r) => r.tools),
      runCode: m((r) => r.runCode),
      look: m((r) => r.look),
      shell: m((r) => r.shell),
      edit: m((r) => r.edit),
      todo: todoLabel(rs),
      skills: [...new Set(rs.flatMap((r) => r.skills.split(" ").filter(Boolean)))].join(", ") || "–",
      memReads: m((r) => r.memReads),
      memWrites: m((r) => r.memWrites),
      checkFirst: n((r) => r.checkFirstOk === true),
      checkRan: n((r) => r.checkFirstOk !== null),
      fixRounds: Math.max(...rs.map((r) => r.fixRounds)),
      checkFinal: n((r) => r.checkFinalOk === true),
      verified: n((r) => r.verifyRuns > 0),
      evidence: m((r) => r.evidence),
      health: healths[0] ?? "",
      lessons: Math.max(...rs.map((r) => r.lessons)),
    });
  }
  return out;
}

function todoLabel(rs: RunRow[]): string {
  const listed = rs.filter((r) => r.todoUpdates > 0);
  if (!listed.length) return "none";
  const one = (r: RunRow) => `${r.todoUpdates} upd${r.todoBeforeEdit === false ? ", after 1st edit" : ""}${r.todoClosed === false ? ", left open" : ""}`;
  return rs.length === 1 ? one(listed[0]!) : `${listed.length}/${rs.length} listed`;
}

/** Metrics compared day to day. */
const TRACKED: { label: string; get: (c: Cell) => number | null; fmt: (n: number) => string }[] = [
  { label: "time", get: (c) => c.timeMs, fmt: (n) => secs(n) },
  { label: "cost", get: (c) => c.costUsd, fmt: (n) => usd(n) },
  { label: "tokens in", get: (c) => c.tokensIn, fmt: (n) => kTok(n) },
  { label: "tokens out", get: (c) => c.tokensOut, fmt: (n) => kTok(n) },
  { label: "tool calls", get: (c) => c.tools, fmt: (n) => String(n) },
];
/** Prior days needed before a metric can flag, the window, and the slack around its min..max. */
export const BAND = { minDays: 3, days: 7, slack: 0.1 };

const kTok = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));
const secs = (ms: number): string => `${Math.round(ms / 1000)} s`;
const usd = (n: number): string => (n === 0 ? "$0" : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(3)}`);
const pct = (now: number, before: number): string => (before === 0 ? (now === 0 ? "±0%" : "new") : `${now >= before ? "+" : ""}${Math.round(((now - before) / before) * 100)}%`);
const share = (n: number): string => `${Math.round(n * 100)}%`;

/** Flags for one cell against earlier days (oldest first). */
export function flags(cell: Cell, earlier: Cell[]): string[] {
  const out: string[] = [];
  const prev = earlier.at(-1);
  if (prev) {
    const was = prev.passes === prev.trials;
    const is = cell.passes === cell.trials;
    if (was !== is) out.push(`verdict ${was ? "pass → fail" : "fail → pass"} (${cell.passes}/${cell.trials})`);
    if (prev.checksOk !== null && cell.checksOk !== null) {
      const wasOk = prev.checksOk === prev.trials;
      const isOk = cell.checksOk === cell.trials;
      if (wasOk !== isOk) out.push(`behaviour checks ${wasOk ? "held → broke" : "broke → held"}`);
    }
  }
  const window = earlier.slice(-BAND.days);
  if (window.length >= BAND.minDays) {
    for (const t of TRACKED) {
      const now = t.get(cell);
      const past = window.map(t.get).filter((v): v is number => v !== null);
      if (now === null || past.length < BAND.minDays) continue;
      const lo = Math.min(...past) * (1 - BAND.slack);
      const hi = Math.max(...past) * (1 + BAND.slack);
      if (now > hi || now < lo) out.push(`${t.label} ${t.fmt(now)} is outside the last ${past.length} days (${t.fmt(Math.min(...past))}–${t.fmt(Math.max(...past))})`);
    }
  }
  return out;
}

const sum = (rs: RunRow[], f: (r: RunRow) => number) => rs.reduce((n, r) => n + f(r), 0);
const costSum = (rs: RunRow[]): string => (rs.some((r) => r.costUsd === null) ? "–" : usd(sum(rs, (r) => r.costUsd ?? 0)));
const ratio = (n: number, of: number) => `${n}/${of}`;
const ratioOrDash = (n: number, of: number) => (of ? ratio(n, of) : "–");

function harnessLine(runs: RunRow[]): string {
  const commits = [...new Set(runs.map((r) => `${r.commit}${r.dirty ? " (uncommitted changes)" : ""}`))].join(", ");
  const versions = [...new Set(runs.map((r) => r.versions))].join("; ");
  return `Harness ${commits}${versions ? ` · ${versions}` : ""}`;
}

/** Every flag of `day` against the days before it. */
function dayFlags(day: DayRuns, history: DayRuns[]): string[] {
  const before = history.filter((d) => d.date < day.date).map((d) => cells(d.runs));
  const out: string[] = [];
  for (const [key, c] of [...cells(day.runs).entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const earlier = before.map((b) => b.get(key)).filter((x): x is Cell => x !== undefined);
    for (const f of flags(c, earlier)) out.push(`- **${c.task} · ${c.agent}**: ${f}`);
  }
  return out;
}

const SUITES: { id: string; title: string; about: string }[] = [
  { id: "solve", title: "Solve: real changes to this repo", about: "Each task starts from a real commit's parent, given as a user request; graded by that commit's own tests (hidden until the turn ends). Typecheck is scored, not required." },
  { id: "memory", title: "Memory", about: "CubiQ memory on every agent: notes seeded before the task, or a convention told in one thread and needed in a new one." },
  { id: "context", title: "Context", about: "Several turns in one thread; a later turn needs what an earlier one found." },
  { id: "behaviour", title: "Behaviour", about: "Todo lists, run_code and skills on small tasks." },
];
const TIERS = ["easy", "medium", "hard"];

type Column = { head: string; cell: (c: Cell, prev: Cell | undefined) => string };
const delta = (now: number | null, was: number | null | undefined) => (now !== null && was !== null && was !== undefined ? ` (${pct(now, was)})` : "");
const COMMON_TAIL: Column[] = [
  { head: "Time", cell: (c, p) => `${secs(c.timeMs)}${delta(c.timeMs, p?.timeMs)}` },
  { head: "Cost", cell: (c, p) => `${c.costUsd === null ? "–" : usd(c.costUsd)}${delta(c.costUsd, p?.costUsd)}` },
  { head: "Tokens in", cell: (c, p) => `${kTok(c.tokensIn)}${delta(c.tokensIn, p?.tokensIn)}` },
  { head: "Out", cell: (c, p) => `${kTok(c.tokensOut)}${delta(c.tokensOut, p?.tokensOut)}` },
];
const passCol: Column = { head: "Pass", cell: (c) => `${c.passes === c.trials ? "✓" : "✗"}${c.trials > 1 ? ` ${ratio(c.passes, c.trials)}` : ""}` };
const checksCol: Column = { head: "Checks", cell: (c) => (c.checksOk === null ? "–" : c.checksOk === c.trials ? "✓" : `✗${c.trials > 1 ? ` ${ratio(c.checksOk, c.trials)}` : ""}`) };
const toolsCol: Column = { head: "Tools: code / look / shell / edit", cell: (c) => `${c.runCode} / ${c.look} / ${c.shell} / ${c.edit}` };
const COLUMNS: Record<string, Column[]> = {
  solve: [
    passCol,
    { head: "Score", cell: (c) => share(c.score) },
    { head: "Check gate", cell: (c) => (c.checkRan ? `${c.checkFinal === c.trials ? "✓" : "✗"} first ${ratio(c.checkFirst, c.checkRan)}${c.fixRounds ? `, ${c.fixRounds} fix` : ""}` : "–") },
    { head: "Ran tests", cell: (c) => ratio(c.verified, c.trials) },
    { head: "Evidence flags", cell: (c) => String(c.evidence) },
    { head: "Todo", cell: (c) => c.todo },
    toolsCol,
    { head: "Learn", cell: (c) => (c.health ? `${c.health}, ${c.lessons} lessons` : "–") },
    ...COMMON_TAIL,
  ],
  memory: [passCol, checksCol, { head: "Memory read / write", cell: (c) => `${c.memReads} / ${c.memWrites}` }, toolsCol, ...COMMON_TAIL],
  context: [passCol, { head: "Cache read", cell: (c) => share(c.cacheShare) }, toolsCol, ...COMMON_TAIL],
  behaviour: [passCol, checksCol, { head: "Todo", cell: (c) => c.todo }, toolsCol, { head: "Skill", cell: (c) => c.skills }, ...COMMON_TAIL],
};

/** Solved / attempted per tier for one agent's solve runs. */
function tierCells(rs: RunRow[]): string[] {
  return TIERS.map((t) => {
    const of = rs.filter((r) => r.suite === "solve" && r.tier === t);
    return ratioOrDash(of.filter((r) => r.pass).length, of.length);
  });
}

export function summarize(day: DayRuns, history: DayRuns[]): string {
  const today = cells(day.runs);
  const before = history.filter((d) => d.date < day.date).map((d) => cells(d.runs));
  const prevOf = (key: string): Cell | undefined => before.map((b) => b.get(key)).filter((x): x is Cell => x !== undefined).at(-1);
  const checked = day.runs.filter(hasChecks);
  const agents = [...new Set(day.runs.map((r) => r.agent))].sort();
  const flagged = dayFlags(day, history);
  const solve = day.runs.filter((r) => r.suite === "solve");

  const lines = [
    `# Bench ${day.date}`,
    "",
    harnessLine(day.runs),
    "",
    `**${ratio(day.runs.filter((r) => r.pass).length, day.runs.length)} runs passed**${solve.length ? ` · **${ratio(solve.filter((r) => r.pass).length, solve.length)} real changes solved**` : ""} · **${ratio(checked.filter(checksHeld).length, checked.length)} behaviour checks held** · ${secs(sum(day.runs, (r) => r.durationMs))} of agent time · ${costSum(day.runs)} reported cost`,
    "",
    "## At a glance",
    "",
    `| Agent | Solved${TIERS.map((t) => ` ${t}`).join(" /")} | Passed (all) | Checks held | Time | Cost | Tokens in | run_code calls |`,
    "|---|---|---|---|---|---|---|---|",
    ...agents.map((a) => {
      const rs = day.runs.filter((r) => r.agent === a);
      const ch = rs.filter(hasChecks);
      return `| ${a} | ${tierCells(rs).join(" / ")} | ${ratio(rs.filter((r) => r.pass).length, rs.length)} | ${ratioOrDash(ch.filter(checksHeld).length, ch.length)} | ${secs(sum(rs, (r) => r.durationMs))} | ${costSum(rs)} | ${kTok(sum(rs, tokensIn))} | ${sum(rs, (r) => r.runCode)} |`;
    }),
    "",
    "## Flags",
    "",
    `A flag needs a pass/fail flip against the previous day, or a value outside the last ${BAND.days} days' range (±${BAND.slack * 100}%, once ${BAND.minDays} days exist).`,
    "",
    ...(flagged.length ? flagged : ["None."]),
    "",
  ];

  for (const suite of SUITES) {
    const tasks = [...new Set(day.runs.filter((r) => r.suite === suite.id).map((r) => `${TIERS.indexOf(r.tier)}|${r.task}`))].sort().map((k) => k.split("|")[1]!);
    if (!tasks.length) continue;
    const cols = COLUMNS[suite.id]!;
    lines.push(`## ${suite.title}`, "", suite.about, "");
    for (const task of tasks) {
      const tier = day.runs.find((r) => r.task === task)?.tier;
      lines.push(`### ${task}${tier ? ` (${tier})` : ""}`, "", `| Agent | ${cols.map((c) => c.head).join(" | ")} |`, `|---|${cols.map(() => "---").join("|")}|`);
      for (const c of [...today.values()].filter((c) => c.task === task).sort((a, b) => a.agent.localeCompare(b.agent))) {
        const prev = prevOf(cellKey(c));
        lines.push(`| ${c.agent} | ${cols.map((col) => col.cell(c, prev)).join(" | ")} |`);
      }
      lines.push("");
    }
  }

  const notes = day.runs.filter((r) => !r.pass || (hasChecks(r) && !checksHeld(r)));
  if (notes.length) {
    lines.push("## Why runs missed", "");
    for (const r of notes.sort((a, b) => `${a.suite}${a.task}${a.agent}`.localeCompare(`${b.suite}${b.task}${b.agent}`))) {
      const missed = [
        !r.pass ? `${r.status}${r.why ? `: ${r.why}` : ""}` : "",
        r.todoOk === false ? `todo check broke (${r.todoUpdates} updates, before first edit: ${r.todoBeforeEdit ?? "–"}, closed: ${r.todoClosed ?? "–"})` : "",
        r.runCodeOk === false ? "run_code expected, not used" : "",
        r.skillsOk === false ? `skill not seen loaded${r.skills ? ` (saw ${r.skills})` : ""}` : "",
        r.memoryOk === false ? `no CubiQ memory note written (${r.memWrites} memory_write calls)` : "",
      ].filter(Boolean);
      lines.push(`- **${r.task} · ${r.agent}**${r.trial > 1 ? ` t${r.trial}` : ""}: ${missed.join("; ")}`);
    }
    lines.push("");
  }
  lines.push(
    "Columns: Pass = the task's required graders; Score = share of all graders (typecheck included). Check gate = the app's project check after the turn (first try, fix rounds). Ran tests = the agent ran tests or a typecheck itself. Evidence flags = the app's \"worth a second look\" notices. Tools are top-level calls (look = read, grep, glob). Tokens in = input + cache read + cache write. (±%) = against the previous day. Full per-run records stay local in `bench/.state/runs/`.",
    "",
  );
  return lines.join("\n");
}

/** results/README.md: the newest day's flags, then each agent day by day (newest first). */
export function overview(history: DayRuns[]): string {
  const latest = history.at(-1);
  const lines = ["# Bench results", "", "Daily runs of `bun run bench` (how it works: [../README.md](../README.md)). One report per day; `history.csv` holds every run.", ""];
  if (!latest) return [...lines, "No runs yet.", ""].join("\n");
  const flagged = dayFlags(latest, history);
  lines.push(`## Latest: [${latest.date}](${latest.date}.md)`, "", harnessLine(latest.runs), "", ...(flagged.length ? flagged : ["No flags."]), "");
  const agents = [...new Set(history.flatMap((d) => d.runs.map((r) => r.agent)))].sort();
  lines.push("## By agent", "");
  for (const a of agents) {
    lines.push(`### ${a}`, "", `| Day | Harness | Solved${TIERS.map((t) => ` ${t}`).join(" /")} | Passed (all) | Checks held | Time | Cost | Tokens in | run_code |`, "|---|---|---|---|---|---|---|---|---|");
    for (const d of [...history].reverse()) {
      const rs = d.runs.filter((r) => r.agent === a);
      if (!rs.length) continue;
      const ch = rs.filter(hasChecks);
      lines.push(
        `| [${d.date}](${d.date}.md) | ${[...new Set(rs.map((r) => r.commit))].join(", ")} | ${tierCells(rs).join(" / ")} | ${ratio(rs.filter((r) => r.pass).length, rs.length)} | ${ratioOrDash(ch.filter(checksHeld).length, ch.length)} | ${secs(sum(rs, (r) => r.durationMs))} | ${costSum(rs)} | ${kTok(sum(rs, tokensIn))} | ${sum(rs, (r) => r.runCode)} |`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}
