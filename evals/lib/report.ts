// Local eval report (roadmap 13 §7.6): per-case outcome, cost, latency,
// repetitions, coverage and trace links, and a candidate-vs-baseline
// comparison on the tasks both runs share. One self-contained HTML file.

import { costPerSuccess, formatCost, passed, spend, statusOf } from "./accounting";
import type { RunResult, TaskResult } from "./types";

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i]!;
}

export interface CaseRow {
  id: string;
  trials: number;
  requested: number;
  passRate: number;
  statuses: Record<string, number>;
  /** Mean attempt cost; null when any attempt's cost is unknown. */
  meanCost: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  cached: number;
  traces: string[];
}

export function caseRow(task: TaskResult): CaseRow {
  const statuses: Record<string, number> = {};
  for (const t of task.trials) statuses[statusOf(t)] = (statuses[statusOf(t)] ?? 0) + 1;
  const costs = task.trials.map((t) => t.costUsd);
  const durations = task.trials.map((t) => t.durationMs);
  return {
    id: task.id,
    trials: task.trials.length,
    requested: task.requestedTrials ?? task.trials.length,
    passRate: task.trials.length ? task.trials.filter(passed).length / task.trials.length : 0,
    statuses,
    meanCost: costs.length && costs.every((c) => c !== null) ? (costs as number[]).reduce((a, b) => a + b, 0) / costs.length : null,
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    cached: task.cached ? task.trials.length : task.trials.filter((t) => t.cached).length,
    traces: task.trials.flatMap((t) => (t.trace ? [t.trace] : [])),
  };
}

export interface Comparison {
  /** Tasks both runs have: the only fair comparison set. */
  shared: string[];
  onlyBase: string[];
  onlyCandidate: string[];
  cases: { id: string; base: CaseRow; candidate: CaseRow }[];
  base: { passRate: number; costPerSuccess: number | null; p50Ms: number | null; harnessErrors: number };
  candidate: { passRate: number; costPerSuccess: number | null; p50Ms: number | null; harnessErrors: number };
  /** Settings that differ between the runs, so a change isn't credited to the wrong cause. */
  differences: string[];
}

const harnessErrors = (tasks: TaskResult[]) => tasks.flatMap((t) => t.trials).filter((t) => statusOf(t) === "harness-error").length;

function sideStats(tasks: TaskResult[]) {
  const cps = costPerSuccess(tasks);
  return { passRate: cps.passRate, costPerSuccess: cps.usd, p50Ms: percentile(tasks.flatMap((t) => t.trials.map((x) => x.durationMs)), 50), harnessErrors: harnessErrors(tasks) };
}

/** What changed between two runs' settings: model, effort, harness/grader/guide versions, price. */
export function settingDifferences(base: RunResult, cand: RunResult): string[] {
  const out: string[] = [];
  const pair = (name: string, a: unknown, b: unknown) => {
    const x = JSON.stringify(a ?? null);
    const y = JSON.stringify(b ?? null);
    if (x !== y) out.push(`${name}: ${x} → ${y}`);
  };
  pair("model", base.meta.model, cand.meta.model);
  pair("protocol", base.meta.protocol, cand.meta.protocol);
  pair("effort", base.meta.effort, cand.meta.effort);
  pair("harness", base.meta.harnessHash, cand.meta.harnessHash);
  const bv = base.meta.manifest?.versions ?? {};
  const cv = cand.meta.manifest?.versions ?? {};
  for (const key of [...new Set([...Object.keys(bv), ...Object.keys(cv)])].sort()) if (key !== "harness") pair(key, bv[key], cv[key]);
  pair("price", base.meta.manifest?.price, cand.meta.manifest?.price);
  return out;
}

export function compareRuns(base: RunResult, cand: RunResult): Comparison {
  const baseIds = new Set(base.tasks.map((t) => t.id));
  const candIds = new Set(cand.tasks.map((t) => t.id));
  const shared = [...candIds].filter((id) => baseIds.has(id)).sort();
  const pick = (run: RunResult) => run.tasks.filter((t) => shared.includes(t.id));
  return {
    shared,
    onlyBase: [...baseIds].filter((id) => !candIds.has(id)).sort(),
    onlyCandidate: [...candIds].filter((id) => !baseIds.has(id)).sort(),
    cases: shared.map((id) => ({ id, base: caseRow(base.tasks.find((t) => t.id === id)!), candidate: caseRow(cand.tasks.find((t) => t.id === id)!) })),
    base: sideStats(pick(base)),
    candidate: sideStats(pick(cand)),
    differences: settingDifferences(base, cand),
  };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const money = (n: number | null) => (n === null ? "unknown" : `$${n.toFixed(4)}`);
const ms = (n: number | null) => (n === null ? "–" : n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${n} ms`);
const pct = (n: number) => `${Math.round(n * 100)}%`;

/** A self-contained HTML report; trace links are relative to the results folder (`../` from reports/). */
export function renderReport(run: RunResult, cmp?: Comparison, baseLabel?: string): string {
  const s = spend(run.tasks);
  const cps = costPerSuccess(run.tasks);
  const m = run.meta;
  const rows = run.tasks
    .map(caseRow)
    .map(
      (r) =>
        `<tr><td>${esc(r.id)}</td><td class="${r.passRate === 1 ? "ok" : r.passRate === 0 ? "bad" : "mid"}">${pct(r.passRate)}</td>` +
        `<td>${r.trials}/${r.requested}${r.cached ? ` (${r.cached} cached)` : ""}</td>` +
        `<td>${esc(Object.entries(r.statuses).map(([k, v]) => `${k} ${v}`).join(", "))}</td>` +
        `<td>${money(r.meanCost)}</td><td>${ms(r.p50Ms)}</td><td>${ms(r.p95Ms)}</td>` +
        `<td>${r.traces.map((t, i) => `<a href="../${esc(t)}">${i + 1}</a>`).join(" ")}</td></tr>`,
    )
    .join("\n");
  const cmpHtml = cmp
    ? `<h2>Compared with ${esc(baseLabel ?? "baseline")}</h2>
<p>${cmp.shared.length} shared tasks${cmp.onlyBase.length ? `; only in baseline: ${esc(cmp.onlyBase.join(", "))}` : ""}${cmp.onlyCandidate.length ? `; only in this run: ${esc(cmp.onlyCandidate.join(", "))}` : ""}.</p>
<table><tr><th></th><th>pass rate</th><th>cost/success</th><th>p50 latency</th><th>harness errors</th></tr>
<tr><td>baseline</td><td>${pct(cmp.base.passRate)}</td><td>${money(cmp.base.costPerSuccess)}</td><td>${ms(cmp.base.p50Ms)}</td><td>${cmp.base.harnessErrors}</td></tr>
<tr><td>this run</td><td>${pct(cmp.candidate.passRate)}</td><td>${money(cmp.candidate.costPerSuccess)}</td><td>${ms(cmp.candidate.p50Ms)}</td><td>${cmp.candidate.harnessErrors}</td></tr></table>
<p>${cmp.differences.length ? `Settings that differ: ${esc(cmp.differences.join("; "))}` : "Same settings: differences come from the agent's own variance."}</p>
<table><tr><th>task</th><th>baseline pass</th><th>this run pass</th><th>baseline cost</th><th>this run cost</th></tr>
${cmp.cases.map((c) => `<tr><td>${esc(c.id)}</td><td>${pct(c.base.passRate)}</td><td class="${c.candidate.passRate < c.base.passRate ? "bad" : c.candidate.passRate > c.base.passRate ? "ok" : ""}">${pct(c.candidate.passRate)}</td><td>${money(c.base.meanCost)}</td><td>${money(c.candidate.meanCost)}</td></tr>`).join("\n")}</table>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>Eval ${esc(m.tier)} ${esc(m.model)}</title>
<style>
:root{--bg:#fff;--fg:#1c1c1e;--muted:#6b6b70;--line:#e3e3e6;--ok:#1a7f37;--bad:#c62828;--mid:#9a6700}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--fg:#ececef;--muted:#9a9aa1;--line:#2c2c30;--ok:#4ac26b;--bad:#ff6b6b;--mid:#d4a72c}}
body{background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif;margin:24px;max-width:1100px}
table{border-collapse:collapse;width:100%;margin:12px 0}td,th{border-bottom:1px solid var(--line);padding:4px 8px;text-align:left}
th{color:var(--muted);font-weight:500}.ok{color:var(--ok)}.bad{color:var(--bad)}.mid{color:var(--mid)}a{color:inherit}
</style></head><body>
<h1>${esc(m.tier)} · ${esc(m.model)}</h1>
<p>${esc(m.agent)} · ${esc(m.protocol)} · effort ${esc(m.effort ?? "?")} · harness ${esc(m.harnessHash.slice(0, 7))} · ${esc(m.startedAt)} · ${ms(m.durationMs)}</p>
<p>Pass rate ${pct(cps.passRate)} · cost/success ${money(cps.usd)} (${cps.covered}/${cps.cases} cases costed) · measured ${esc(formatCost(s.measured))} over ${s.measured.trials} attempts · spent this run ${esc(formatCost(s.spent))}</p>
${m.manifest ? `<p>Trace fidelity: ${esc(m.manifest.fidelity)}</p>` : ""}
<table><tr><th>task</th><th>pass</th><th>trials</th><th>statuses</th><th>mean cost</th><th>p50</th><th>p95</th><th>traces</th></tr>
${rows}</table>
${cmpHtml}
</body></html>
`;
}
