// Wires the automation runner to the app: threads come from Service, results go to the Message Center.

import type { Store } from "../db";
import type { Service } from "../service";
import type { AutomationNotice } from "../../shared/automations";
import type { LiveUpdate } from "../../shared/types";
import { messageCenterDestination } from "./destinations";
import type { Source } from "./io";
import { AutomationRunner } from "./runner";
import { defaultSources } from "./sources";
import { AutomationStore, type Automation, type AutomationRun } from "./store";

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
      const thread = o.store.updateThread(t.id, { title: `Automation · ${a.name}`, ...(a.model ? { model: a.model } : {}) });
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
  return {
    store: automations,
    runner,
    tick,
    dispose: () => {
      clearInterval(timer);
      runner.stop();
    },
  };
}
