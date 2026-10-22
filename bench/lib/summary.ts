// The day's summary.md: one row per task × agent, deltas against the previous
// day, and flags only when a change is bigger than the recent day-to-day spread
// (single runs are noisy) or a verdict flips. Pure, so it is unit-tested.

import type { RunResult } from "./types";

export interface DayRuns {
  date: string;
  runs: RunResult[];
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
  /** Todo use summed over trials, for the row: "listed", "none"… */
  todo: string;
  skills: string;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export const cellKey = (r: { task: string; agent: string; model: string }): string => `${r.task}|${r.agent}|${r.model}`;

export function cells(runs: RunResult[]): Map<string, Cell> {
  const groups = new Map<string, RunResult[]>();
  for (const r of runs) groups.set(cellKey(r), [...(groups.get(cellKey(r)) ?? []), r]);
  const out = new Map<string, Cell>();
  for (const [key, rs] of groups) {
    const r0 = rs[0]!;
    const checked = rs.filter((r) => Object.values(r.checks).some((c) => c !== null));
    const costs = rs.map((r) => r.metrics.costUsd);
    const m = (f: (r: RunResult) => number) => median(rs.map(f));
    out.set(key, {
      task: r0.task,
      agent: r0.agent,
      model: r0.model,
      trials: rs.length,
      passes: rs.filter((r) => r.pass).length,
      checksOk: checked.length ? checked.filter((r) => Object.values(r.checks).every((c) => c !== false)).length : null,
      timeMs: m((r) => r.metrics.durationMs),
      costUsd: costs.every((c) => c !== null) ? median(costs as number[]) : null,
      tokensIn: m((r) => r.metrics.tokens.input + r.metrics.tokens.cacheRead + r.metrics.tokens.cacheWrite),
      tokensOut: m((r) => r.metrics.tokens.output),
      tools: m((r) => r.metrics.tools.total),
      runCode: m((r) => r.metrics.tools.runCode),
      look: m((r) => r.metrics.tools.look),
      shell: m((r) => r.metrics.tools.shell),
      edit: m((r) => r.metrics.tools.edit),
      todo: todoLabel(rs),
      skills: [...new Set(rs.flatMap((r) => r.metrics.skills))].join(", ") || "–",
    });
  }
  return out;
}

function todoLabel(rs: RunResult[]): string {
  const listed = rs.filter((r) => r.metrics.todo.updates > 0);
  if (!listed.length) return "none";
  const early = listed.filter((r) => r.metrics.todo.beforeFirstEdit !== false).length;
  const closed = listed.filter((r) => r.metrics.todo.allCompleted).length;
  const avgUpdates = Math.round(listed.reduce((n, r) => n + r.metrics.todo.updates, 0) / listed.length);
  return `${listed.length}/${rs.length} listed, ${early} early, ${closed} closed, ${avgUpdates} upd`;
}

/** Metrics compared day to day; `slack` widens the band so tiny wobbles never flag. */
const TRACKED: { label: string; get: (c: Cell) => number | null; fmt: (n: number) => string }[] = [
  { label: "time", get: (c) => c.timeMs, fmt: (n) => `${Math.round(n / 1000)} s` },
  { label: "cost", get: (c) => c.costUsd, fmt: (n) => `$${n.toFixed(4)}` },
  { label: "tokens in", get: (c) => c.tokensIn, fmt: (n) => kTok(n) },
  { label: "tokens out", get: (c) => c.tokensOut, fmt: (n) => kTok(n) },
  { label: "tool calls", get: (c) => c.tools, fmt: (n) => String(n) },
];
/** Prior days needed before a metric can flag, the window, and the slack around its min..max. */
export const BAND = { minDays: 3, days: 7, slack: 0.1 };

const kTok = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));
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

export function summarize(day: DayRuns, history: DayRuns[]): string {
  const today = cells(day.runs);
  const before = history.filter((d) => d.date < day.date).sort((a, b) => a.date.localeCompare(b.date)).map((d) => ({ date: d.date, cells: cells(d.runs) }));
  const earlierOf = (key: string): Cell[] => before.map((d) => d.cells.get(key)).filter((c): c is Cell => c !== undefined);

  const first = day.runs[0];
  const versions = first ? Object.entries(first.harness.versions).map(([k, v]) => `${k} ${v}`).join(" · ") : "";
  const commits = [...new Set(day.runs.map((r) => `${r.harness.commit.slice(0, 7)}${r.harness.dirty ? " (uncommitted changes)" : ""}`))].join(", ");
  const passed = day.runs.filter((r) => r.pass).length;
  const checked = day.runs.filter((r) => Object.values(r.checks).some((c) => c !== null));
  const held = checked.filter((r) => Object.values(r.checks).every((c) => c !== false)).length;
  const lines = [
    `# Bench ${day.date}`,
    "",
    `Harness ${commits}${versions ? ` · ${versions}` : ""}`,
    `Runs ${day.runs.length} · graders passed ${passed}/${day.runs.length} · behaviour checks held ${held}/${checked.length}`,
    `Deltas are against the previous day with the same run. A flag needs a verdict flip, or a value outside the last ${BAND.days} days' min–max (±${BAND.slack * 100}%, at least ${BAND.minDays} days).`,
    "",
  ];

  const allFlags: string[] = [];
  const rows: string[] = [];
  const sorted = [...today.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [key, c] of sorted) {
    const earlier = earlierOf(key);
    const prev = earlier.at(-1);
    const delta = (now: number | null, was: number | null | undefined) => (now !== null && was !== null && was !== undefined ? ` (${pct(now, was)})` : "");
    rows.push(
      `| ${c.task} | ${c.agent} | ${c.passes}/${c.trials} | ${c.checksOk === null ? "–" : `${c.checksOk}/${c.trials}`} | ${c.todo} | ${c.runCode} / ${c.look} / ${c.shell} / ${c.edit} | ${c.skills} | ${Math.round(c.timeMs / 1000)} s${delta(c.timeMs, prev?.timeMs)} | ${c.costUsd === null ? "–" : `$${c.costUsd.toFixed(4)}`}${delta(c.costUsd, prev?.costUsd)} | ${kTok(c.tokensIn)}${delta(c.tokensIn, prev?.tokensIn)} | ${kTok(c.tokensOut)}${delta(c.tokensOut, prev?.tokensOut)} |`,
    );
    for (const f of flags(c, earlier)) allFlags.push(`- **${c.task} · ${c.agent}**: ${f}`);
  }

  lines.push("## Flags", "", ...(allFlags.length ? allFlags : ["None."]), "");
  lines.push(
    "## Runs",
    "",
    "Pass = graders; Checks = todo / run_code / skill expectations. Tools = run_code / look (read, grep, glob) / shell / edit, medians. Tokens in = input + cache read + cache write.",
    "",
    "| Task | Agent | Pass | Checks | Todo | Tools | Skill | Time | Cost | Tokens in | Out |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    ...rows,
    "",
  );

  const problems = day.runs.filter((r) => r.status !== "passed");
  if (problems.length) {
    lines.push("## Not passed", "");
    for (const r of problems) {
      const why = r.note ?? r.graders.filter((g) => !g.pass).map((g) => g.why).join("; ");
      lines.push(`- ${r.task} · ${r.agent} t${r.trial}: ${r.status}${why ? `: ${why.slice(0, 300)}` : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
