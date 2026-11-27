// Wires the automation runner to the app: threads come from Service, results go to the Message Center.

import { randomUUID } from "node:crypto";
import type { Store } from "../db";
import type { Service } from "../service";
import type { AutomationInput, AutomationNotice, AutomationPermissions, AutomationsOverview, AutomationView } from "../../shared/automations";
import { newestNoticeFirst } from "../../shared/automations";
import type { LiveUpdate } from "../../shared/types";
import { messageCenterDestination } from "./destinations";
import type { Source } from "./io";
import { AutomationRunner } from "./runner";
import { describeSchedule, nextDue, validSchedule } from "./schedule";
import { defaultSources } from "./sources";
import { AutomationStore, type Automation, type AutomationRun } from "./store";
import { templates } from "./templates";
import type { PluginOwner } from "../../shared/plugin-parts";

const TICK_MS = 60_000;
const LEASE_MS = 10 * 60_000;

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
    anchor: a.anchor,
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
  recentNotices(): AutomationNotice[];
  /** Check what's due and run it (timer, wake from sleep, startup). */
  tick(): void;
  dispose(): void;
}

/** Start automations: reconcile what a crash left behind, then tick every minute. */
export function startAutomations(o: { store: Store; service: Service; broadcast: (u: LiveUpdate) => void; sources?: Map<string, Source>; owner?: (id: string) => PluginOwner | null }): AutomationsApp {
  const automations = new AutomationStore(o.store.sql);
  const own = new Set<string>();
  const runner = new AutomationRunner({
    store: automations,
    owner: o.owner,
    createThread: async (a) => {
      const t = o.service.createThread(a.projectId, a.agent ?? undefined);
      own.add(t.id);
      // Ask means Ask, even when the user's default is Full access. Unattended retains its existing guardrails.
      const thread = o.store.updateThread(t.id, { title: `Automation · ${a.name}`, ...(a.model ? { model: a.model } : {}), permissionMode: a.permissions === "unattended" ? "full" : "ask" });
      o.broadcast({ type: "thread", thread });
      return t.id;
    },
    send: (threadId, text) => o.service.send({ threadId, text, background: true }),
    interrupt: (threadId) => o.service.interrupt(threadId),
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
    destination: messageCenterDestination(automations, (p) => o.broadcast({ type: "automation-delivered", automationId: p.automationId, runId: p.runId, threadId: p.threadId, title: p.title })),
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
  const ownedView = (a: Automation): AutomationView => {
    const view = viewOf(a, automations, Date.now()), owner = o.owner?.(a.id);
    return owner ? { ...view, owner, ...(!owner.enabled ? { nextAt: null, unavailable: "The owning plugin is Off or unavailable." } : {}) } : view;
  };
  const overview = (projectId: string): AutomationsOverview => ({
    templates: templates(),
    automations: automations.list(projectId).map(ownedView),
  });
  const save = (projectId: string, input: AutomationInput, id?: string): AutomationView => {
    if (id) {
      if (automations.get(id)?.projectId !== projectId) throw new Error("Automation does not belong to this project.");
      if (o.owner?.(id)?.enabled === false) throw new Error("The owning plugin is Off or unavailable. Turn it On before changing this automation.");
    }
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
    return ownedView(a);
  };
  return {
    store: automations,
    recentNotices: () => automations.list().flatMap((a) => {
      const run = automations.latestFinished(a.id);
      return run ? [noticeOf(run, a)] : [];
    }).sort(newestNoticeFirst).slice(0, 20),
    runner,
    overview,
    save,
    remove: (id) => {
      if (o.owner?.(id)) throw new Error("This automation is managed by its plugin. Uninstall the plugin to remove its bundled parts.");
      automations.remove(id);
    },
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
