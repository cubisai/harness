// The committed reports: results/<date>.md (one day, deltas against the
// previous day) and results/README.md (every day per agent). A change is
// flagged only when a verdict flips or a value leaves the recent day-to-day
// spread, since single runs are noisy. Pure, so it is unit-tested.

import type { RunRow } from "./results";

export interface DayRuns {
  date: string;
  runs: RunRow[];
}

/** One task × agent × model on one day, trials folded (medians). */
export interface Cell {
  task: string;
  agent: string;
  model: string;
  trials: number;
  passes: number;
  /** Trials whose behaviour checks (todo, run_code, skills) all held; null when the task sets none. */
  checksOk: number | null;
  timeMs: number;
  costUsd: number | null;
  /** Input + cache read + cache write. */
  tokensIn: number;
  tokensOut: number;
  tools: number;
  runCode: number;
  look: number;
  shell: number;
  edit: number;
  todo: string;
  skills: string;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

const checksOf = (r: RunRow) => [r.todoOk, r.runCodeOk, r.skillsOk];
const hasChecks = (r: RunRow) => checksOf(r).some((c) => c !== null);
const checksHeld = (r: RunRow) => checksOf(r).every((c) => c !== false);
const tokensIn = (r: RunRow) => r.tokensIn + r.cacheRead + r.cacheWrite;

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
    out.set(key, {
      task: r0.task,
      agent: r0.agent,
      model: r0.model,
      trials: rs.length,
      passes: rs.filter((r) => r.pass).length,
      checksOk: checked.length ? checked.filter(checksHeld).length : null,
      timeMs: m((r) => r.durationMs),
      costUsd: costs.every((c) => c !== null) ? median(costs as number[]) : null,
      tokensIn: m(tokensIn),
      tokensOut: m((r) => r.tokensOut),
      tools: m((r) => r.tools),
      runCode: m((r) => r.runCode),
      look: m((r) => r.look),
      shell: m((r) => r.shell),
      edit: m((r) => r.edit),
      todo: todoLabel(rs),
      skills: [...new Set(rs.flatMap((r) => r.skills.split(" ").filter(Boolean)))].join(", ") || "–",
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

export function summarize(day: DayRuns, history: DayRuns[]): string {
  const today = cells(day.runs);
  const before = history.filter((d) => d.date < day.date).map((d) => cells(d.runs));
  const prevOf = (key: string): Cell | undefined => before.map((b) => b.get(key)).filter((x): x is Cell => x !== undefined).at(-1);
  const checked = day.runs.filter(hasChecks);
  const agents = [...new Set(day.runs.map((r) => r.agent))].sort();
  const tasks = [...new Set(day.runs.map((r) => r.task))].sort();
  const flagged = dayFlags(day, history);

  const lines = [
    `# Bench ${day.date}`,
    "",
    harnessLine(day.runs),
    "",
    `**${ratio(day.runs.filter((r) => r.pass).length, day.runs.length)} runs passed** their graders · **${ratio(checked.filter(checksHeld).length, checked.length)} behaviour checks held** (todo, run_code, skill) · ${secs(sum(day.runs, (r) => r.durationMs))} of agent time · ${costSum(day.runs)} reported cost`,
    "",
    "## At a glance",
    "",
    "| Agent | Passed | Checks held | Time | Cost | Tokens in | run_code calls |",
    "|---|---|---|---|---|---|---|",
    ...agents.map((a) => {
      const rs = day.runs.filter((r) => r.agent === a);
      const ch = rs.filter(hasChecks);
      return `| ${a} | ${ratio(rs.filter((r) => r.pass).length, rs.length)} | ${ratio(ch.filter(checksHeld).length, ch.length)} | ${secs(sum(rs, (r) => r.durationMs))} | ${costSum(rs)} | ${kTok(sum(rs, tokensIn))} | ${sum(rs, (r) => r.runCode)} |`;
    }),
    "",
    "## Flags",
    "",
    `A flag needs a pass/fail flip against the previous day, or a value outside the last ${BAND.days} days' range (±${BAND.slack * 100}%, once ${BAND.minDays} days exist).`,
    "",
    ...(flagged.length ? flagged : ["None."]),
    "",
  ];

  for (const task of tasks) {
    lines.push(
      `## ${task}`,
      "",
      "| Agent | Pass | Checks | Todo | Tools: code / look / shell / edit | Skill | Time | Cost | Tokens in | Out |",
      "|---|---|---|---|---|---|---|---|---|---|",
    );
    for (const c of [...today.values()].filter((c) => c.task === task).sort((a, b) => a.agent.localeCompare(b.agent))) {
      const prev = prevOf(cellKey(c));
      const d = (now: number | null, was: number | null | undefined) => (now !== null && was !== null && was !== undefined ? ` (${pct(now, was)})` : "");
      const pass = `${c.passes === c.trials ? "✓" : "✗"}${c.trials > 1 ? ` ${ratio(c.passes, c.trials)}` : ""}`;
      const checks = c.checksOk === null ? "–" : c.checksOk === c.trials ? "✓" : `✗${c.trials > 1 ? ` ${ratio(c.checksOk, c.trials)}` : ""}`;
      lines.push(
        `| ${c.agent} | ${pass} | ${checks} | ${c.todo} | ${c.runCode} / ${c.look} / ${c.shell} / ${c.edit} | ${c.skills} | ${secs(c.timeMs)}${d(c.timeMs, prev?.timeMs)} | ${c.costUsd === null ? "–" : usd(c.costUsd)}${d(c.costUsd, prev?.costUsd)} | ${kTok(c.tokensIn)}${d(c.tokensIn, prev?.tokensIn)} | ${kTok(c.tokensOut)}${d(c.tokensOut, prev?.tokensOut)} |`,
      );
    }
    lines.push("");
  }

  const notes = day.runs.filter((r) => !r.pass || (hasChecks(r) && !checksHeld(r)));
  if (notes.length) {
    lines.push("## Why runs missed", "");
    for (const r of notes.sort((a, b) => `${a.task}${a.agent}`.localeCompare(`${b.task}${b.agent}`))) {
      const missed = [
        !r.pass ? `${r.status}${r.why ? `: ${r.why}` : ""}` : "",
        r.todoOk === false ? `todo check broke (${r.todoUpdates} updates, before first edit: ${r.todoBeforeEdit ?? "–"}, closed: ${r.todoClosed ?? "–"})` : "",
        r.runCodeOk === false ? "run_code expected, not used" : "",
        r.skillsOk === false ? `skill not seen loaded${r.skills ? ` (saw ${r.skills})` : ""}` : "",
      ].filter(Boolean);
      lines.push(`- **${r.task} · ${r.agent}**${r.trial > 1 ? ` t${r.trial}` : ""}: ${missed.join("; ")}`);
    }
    lines.push("");
  }
  lines.push(
    "Columns: Pass = the task's graders. Checks = its todo / run_code / skill expectations. Tools are top-level calls (look = read, grep, glob). Tokens in = input + cache read + cache write. (±%) = against the previous day. Full per-run records stay local in `bench/.state/runs/`.",
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
    lines.push(`### ${a}`, "", "| Day | Harness | Passed | Checks held | Time | Cost | Tokens in | run_code |", "|---|---|---|---|---|---|---|---|");
    for (const d of [...history].reverse()) {
      const rs = d.runs.filter((r) => r.agent === a);
      if (!rs.length) continue;
      const ch = rs.filter(hasChecks);
      lines.push(
        `| [${d.date}](${d.date}.md) | ${[...new Set(rs.map((r) => r.commit))].join(", ")} | ${ratio(rs.filter((r) => r.pass).length, rs.length)} | ${ratio(ch.filter(checksHeld).length, ch.length)} | ${secs(sum(rs, (r) => r.durationMs))} | ${costSum(rs)} | ${kTok(sum(rs, tokensIn))} | ${sum(rs, (r) => r.runCode)} |`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}
