// Wires the automation runner to the app: threads come from Service, results go to the Message Center.

import { randomUUID } from "node:crypto";
import type { Store } from "../db";
import type { Service } from "../service";
import type { AutomationInput, AutomationNotice, AutomationPermissions, AutomationsOverview, AutomationView } from "../../shared/automations";
import type { LiveUpdate } from "../../shared/types";
import { messageCenterDestination } from "./destinations";
import type { Source } from "./io";
import { AutomationRunner } from "./runner";
import { describeSchedule, nextDue, validSchedule } from "./schedule";
import { defaultSources } from "./sources";
import { AutomationStore, type Automation, type AutomationRun } from "./store";
import { templates } from "./templates";

const TICK_MS = 60_000;
const LEASE_MS = 10 * 60_000;
/** How long a finished send must stay idle before the run counts as done (a check fix round restarts it). */
const SETTLE_MS = 1500;

/** The sources a template reads; templates without one only run their prompt. */
export function sourcesForTemplate(template: string): string[] {
  return template === "project-brief" ? ["git"] : [];
}

export function noticeOf(run: AutomationRun, a: Automation): AutomationNotice {
  return { automationId: a.id, name: a.name, runId: run.id, threadId: run.threadId, status: run.status, costUsd: run.costUsd, endedAt: run.endedAt, error: run.error };
}

/** One automation as the Library lists it: its settings, a schedule phrase, and its last run. */
export function viewOf(a: Automation, store: Pick<AutomationStore, "runs" | "lastScheduled">, now: number): AutomationView {
  let nextAt: number | null = null;
  if (a.enabled) {
    try {
      nextAt = nextDue(a.schedule, Math.max(now, store.lastScheduled(a.id) ?? a.createdAt), a.anchor);
    } catch {
      // A schedule that can't produce a next instant just shows none.
    }
  }
  const last = store.runs(a.id, 1)[0];
  return {
    id: a.id,
    projectId: a.projectId,
    name: a.name,
    template: a.template,
    prompt: a.prompt,
    schedule: a.schedule,
    missed: a.missed,
    enabled: a.enabled,
    agent: a.agent,
    model: a.model,
    budgetUsd: a.budgetUsd,
    permissions: a.permissions,
    scheduleText: describeSchedule(a.schedule),
    nextAt,
    lastRun: last ? noticeOf(last, a) : null,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Send one message and wait for the thread to go idle, follow-up fix rounds
 * included. Resolves with the last answer; rejects when the turn ended on an error.
 */
export async function sendAndWait(service: Pick<Service, "send" | "isRunning">, store: Pick<Store, "listEvents">, threadId: string, text: string, settleMs = SETTLE_MS): Promise<{ text: string }> {
  await service.send({ threadId, text });
  for (let idle = 0; idle < 2; ) {
    await sleep(settleMs / 2);
    idle = service.isRunning(threadId) ? 0 : idle + 1;
  }
  const events = store.listEvents(threadId);
  const userAt = events.reduce((at, e) => (e.event.kind === "user" ? e.seq : at), -1);
  const after = events.filter((e) => e.seq > userAt);
  const answer = [...after].reverse().find((e) => e.event.kind === "assistant-text");
  const error = [...after].reverse().find((e) => e.event.kind === "error");
  if (!answer && error && error.event.kind === "error") throw new Error(error.event.message);
  return { text: answer && answer.event.kind === "assistant-text" ? answer.event.text : "" };
}

export interface AutomationsApp {
  store: AutomationStore;
  runner: AutomationRunner;
  /** One project's automations plus the templates to start from. */
  overview(projectId: string): AutomationsOverview;
  /** Create (no id) or update one, validating its name, schedule and budget. */
  save(projectId: string, input: AutomationInput, id?: string): AutomationView;
  remove(id: string): void;
  /** Queue one run now, outside the schedule; null when it can't be claimed. */
  runNow(id: string): AutomationNotice | null;
  /** The newest runs first. */
  runs(id: string): AutomationNotice[];
  /** Check what's due and run it (timer, wake from sleep, startup). */
  tick(): void;
  dispose(): void;
}

/** Start automations: reconcile what a crash left behind, then tick every minute. */
export function startAutomations(o: { store: Store; service: Service; broadcast: (u: LiveUpdate) => void; sources?: Map<string, Source> }): AutomationsApp {
  const automations = new AutomationStore(o.store.sql);
  const own = new Set<string>();
  const runner = new AutomationRunner({
    store: automations,
    createThread: async (a) => {
      const t = o.service.createThread(a.projectId, a.agent ?? undefined);
      own.add(t.id);
      // Nobody watches a scheduled run: unattended runs skip approvals (git guardrails still apply); "ask" keeps the user's default and waits.
      const thread = o.store.updateThread(t.id, { title: `Automation · ${a.name}`, ...(a.model ? { model: a.model } : {}), ...(a.permissions === "unattended" ? { permissionMode: "full" as const } : {}) });
      o.broadcast({ type: "thread", thread });
      return t.id;
    },
    send: (threadId, text) => sendAndWait(o.service, o.store, threadId, text),
    totals: (threadId) => {
      const t = o.store.threadTotals(threadId);
      return { costUsd: t.costUsd, inputTokens: t.inputTokens, outputTokens: t.outputTokens };
    },
    // A user's own turn goes first; an automation's thread doesn't count.
    interactiveBusy: () => o.service.pendingState().running.some((id) => !own.has(id)),
    waitingInput: (threadId) => {
      const p = o.service.pendingState();
      return p.permissions.some((r) => r.threadId === threadId) || p.questions.some((q) => q.threadId === threadId) || p.plans.some((r) => r.threadId === threadId);
    },
    sourcesFor: (a) => sourcesForTemplate(a.template),
    sources: o.sources ?? defaultSources(),
    cwdOf: (projectId) => o.store.getProject(projectId).path,
    destination: messageCenterDestination((p) => o.broadcast({ type: "automation-delivered", automationId: p.automationId, runId: p.runId, threadId: p.threadId, title: p.title })),
    notify: (run, a) => o.broadcast({ type: "automation-run", notice: noticeOf(run, a) }),
    now: () => Date.now(),
    leaseMs: LEASE_MS,
  });
  const tick = () => {
    try {
      if (runner.tick() > 0 || runner.queued() > 0) void runner.drain();
    } catch {
      // A bad row never stops the clock.
    }
  };
  void runner.recover().finally(tick);
  const timer = setInterval(tick, TICK_MS);
  const overview = (projectId: string): AutomationsOverview => ({
    templates: templates(),
    automations: automations.list(projectId).map((a) => viewOf(a, automations, Date.now())),
  });
  const save = (projectId: string, input: AutomationInput, id?: string): AutomationView => {
    const name = input.name.trim();
    if (!name) throw new Error("Name the automation.");
    const bad = validSchedule(input.schedule);
    if (bad) throw new Error(bad);
    if (input.budgetUsd !== null && (!Number.isFinite(input.budgetUsd) || input.budgetUsd <= 0)) throw new Error("Budget must be a positive amount.");
    // An unknown agent would quietly fall back to the default one (and its price): refuse it instead.
    if (input.agent !== null && !o.service.allDrivers().some((d) => d.id === input.agent)) throw new Error(`Unknown agent: ${input.agent}`);
    const permissions: AutomationPermissions = input.permissions === "ask" ? "ask" : "unattended";
    const fields = { name, prompt: input.prompt, schedule: input.schedule, missed: input.missed, enabled: input.enabled, agent: input.agent, model: input.model, budgetUsd: input.budgetUsd, permissions };
    const a = id ? automations.update(id, fields) : automations.create({ id: randomUUID(), projectId, template: input.template, anchor: Date.now(), ...fields });
    return viewOf(a, automations, Date.now());
  };
  return {
    store: automations,
    runner,
    overview,
    save,
    remove: (id) => automations.remove(id),
    runNow: (id) => {
      const run = runner.runNow(id);
      void runner.drain();
      const a = run ? automations.get(id) : null;
      return run && a ? noticeOf(run, a) : null;
    },
    runs: (id) => {
      const a = automations.get(id);
      return a ? automations.runs(id, 20).map((r) => noticeOf(r, a)) : [];
    },
    tick,
    dispose: () => {
      clearInterval(timer);
      runner.stop();
    },
  };
}
