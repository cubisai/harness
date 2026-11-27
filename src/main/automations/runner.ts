// The automation runner: claims due runs, runs them one at a time behind
// interactive turns, and reconciles in-flight deliveries before any retry.

import { z } from "zod";
import type { TurnOutcome } from "../../shared/types";
import type { DeliveryCheck, Destination, Source } from "./io";
import { dueTimes, runKey } from "./schedule";
import type { Automation, AutomationRun, AutomationStore, Delivery } from "./store";
import type { PluginOwner } from "../../shared/plugin-parts";

export interface RunnerDeps {
  store: AutomationStore;
  /** Start a fresh thread for the run; resolves with its id. */
  createThread(a: Automation): Promise<string>;
  /** Start a turn; resolves with the final answer at turn end, rejects on turn error. */
  send(threadId: string, text: string): Promise<TurnOutcome | { status?: "succeeded"; text: string }>;
  /** Stop an in-flight turn when a mid-run budget check trips. */
  interrupt?(threadId: string): void;
  totals(threadId: string): { costUsd: number | null; inputTokens: number; outputTokens: number };
  /** A user's own turn is running, so background runs wait for it. */
  interactiveBusy(): boolean;
  /** The run's turn is blocked on a user question or approval. */
  waitingInput(threadId: string): boolean;
  /** Source ids for this automation, in the order they appear in the prompt. */
  sourcesFor(a: Automation): string[];
  sources: Map<string, Source>;
  cwdOf(projectId: string): string;
  destination: Destination;
  notify(run: AutomationRun, a: Automation): void;
  now(): number;
  leaseMs: number;
  /** How often a pending run renews its lease and checks waitingInput; default 1000. */
  pollMs?: number;
  /** Main-owned plugin availability. Schedule Off and owner Off are different gates. */
  owner?(id: string): PluginOwner | null;
}

export interface RecoverCounts {
  interrupted: number;
  requeued: number;
  confirmed: number;
  republished: number;
  unknown: number;
}

/** What a run keeps before delivering, so a restart can finish the delivery and the cursor advance. */
const checkpointSchema = z.object({
  text: z.string(),
  advances: z.array(z.object({ source: z.string(), expected: z.string().nullable().optional(), next: z.string() })),
  final: z.object({ status: z.enum(["succeeded", "paused-budget"]), inputTokens: z.number(), outputTokens: z.number(), costUsd: z.number().nullable() }).optional(),
  owner: z.object({ key: z.string(), revision: z.string().optional() }).nullable().optional(),
  title: z.string().optional(),
});
type Checkpoint = z.infer<typeof checkpointSchema>;

function ownerMatches(expected: Checkpoint["owner"], live: PluginOwner | null | undefined): boolean {
  return live?.enabled !== false && live?.key === expected?.key && live?.revision === expected?.revision;
}

function outcome(run: AutomationRun, cp: Checkpoint | null) {
  return cp?.final?.status ?? (run.status === "succeeded" || run.status === "paused-budget" ? run.status : null);
}

function savedResult(run: AutomationRun, cp: Checkpoint | null) {
  const { inputTokens, outputTokens, costUsd } = cp?.final ?? run;
  // Even an incomplete legacy checkpoint may have readable text. Keep it for display;
  // it is not evidence of a successful turn or permission to retry a publish.
  const saved = run.checkpoint;
  const text = saved && typeof saved === "object" && "text" in saved && typeof saved.text === "string" ? saved.text : null;
  return { inputTokens, outputTokens, costUsd, result: cp?.text ?? run.result ?? text };
}

/** A reason string safe to show a user. */
function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Claimed-but-not-yet-run run ids, drained one at a time. */
/**
 * Scheduled runs stay parked while the newest settled run (cancelled and queued ones skipped) is
 * paused-budget on the current config. A config change or a manual run that settles lifts it.
 */
function budgetPaused(store: RunnerDeps["store"], a: { id: string; configVersion: number }, exceptRunId?: number): boolean {
  const latest = store.runs(a.id, 20).find((r) => r.id !== exceptRunId && r.status !== "cancelled" && r.status !== "queued");
  return latest?.status === "paused-budget" && latest.configVersion === a.configVersion;
}

export class AutomationRunner {
  private queue: number[] = [];
  private draining = false;
  private stopped = false;

  constructor(private deps: RunnerDeps) {}

  private allowed(id: string): boolean { return this.deps.owner?.(id)?.enabled !== false; }
  private cancel(run: AutomationRun, a: Automation): void {
    const current = this.deps.store.run(run.id);
    if (!current || !["queued", "running", "waiting-input"].includes(current.status)) return;
    if (current.threadId) this.deps.interrupt?.(current.threadId);
    this.notify(this.deps.store.finishRun(run.id, { status: "cancelled", error: "The owning plugin is Off, unavailable or changed." }), a);
  }

  /**
   * Reconcile what was in flight before anything retries: stale runs are
   * interrupted; a confirmed check confirms; a missing one is re-published
   * only from intent/published; unknown is always left alone, never re-posted.
   * A confirmed delivery moves its run's source cursors. Runs claimed before a
   * quit but never started go back on the queue. Call once, at startup.
   */
  async recover(): Promise<RecoverCounts> {
    const store = this.deps.store;
    const counts: RecoverCounts = { interrupted: store.interruptStale(true), requeued: 0, confirmed: 0, republished: 0, unknown: 0 };
    for (const r of store.queuedRuns()) {
      const a = store.get(r.automationId);
      if (!this.allowed(r.automationId)) { if (a) this.cancel(r, a); continue; }
      if (this.queue.includes(r.id)) continue;
      this.queue.push(r.id);
      counts.requeued++;
    }
    for (const delivery of store.pendingDeliveries(true)) counts[await this.reconcile(delivery)]++;
    return counts;
  }

  private async reconcile(d: Delivery): Promise<"confirmed" | "republished" | "unknown"> {
    const { store, destination } = this.deps;
    const run = store.run(d.runId);
    const a = run && store.get(run.automationId);
    if (!run || !a) return "unknown";
    const parsed = checkpointSchema.safeParse(run.checkpoint);
    const cp = parsed.success ? parsed.data : null;
    const key = d.idempotencyKey;
    // Recovery spans external awaits. Off/On changes the owner's revision even if the run
    // was already interrupted at startup and the plugin no longer lists it as active work.
    const permitted = () => {
      const live = store.run(run.id);
      if (!live || live.status === "failed" || live.status === "cancelled") return false;
      if (ownerMatches(cp?.owner, this.deps.owner?.(a.id))) return true;
      this.notify(store.finishRun(run.id, { ...savedResult(live, cp), status: "cancelled", error: "Delivery recovery stopped: the owning plugin is Off or changed." }), a);
      return false;
    };
    if (!permitted()) return "unknown";

    let check: DeliveryCheck = "unknown";
    if (d.state === "confirmed") check = "confirmed";
    else if (destination.id === d.destination) {
      try { check = await destination.check(key); } catch { /* No proof of delivery or absence. */ }
      if (!permitted()) return "unknown";
    }
    if (check === "confirmed" || typeof check === "object") {
      const receipt = typeof check === "object" ? check.receipt : undefined;
      this.notify(store.atomic(() => this.completeDelivery(run, cp, key, receipt)), a);
      return "confirmed";
    }
    const text = cp?.text ?? run.result;
    if (check === "missing" && destination.repeatable && d.state !== "unknown" && text !== null && outcome(run, cp)) {
      const payload = { key, automationId: a.id, runId: run.id, threadId: run.threadId ?? "", title: cp?.title ?? a.name, text };
      let receipt: string | undefined = key;
      if (!destination.afterCommit) {
        try { receipt = await destination.publish(payload); } catch {
          if (permitted()) this.unconfirmed(run, cp, key, a);
          return "unknown";
        }
        if (!permitted()) return "unknown";
      }
      const finished = store.atomic(() => this.completeDelivery(run, cp, key, receipt));
      try { destination.afterCommit?.(payload); } catch { /* Reload reads the committed row. */ }
      this.notify(finished, a);
      return "republished";
    }
    this.unconfirmed(run, cp, key, a);
    return "unknown";
  }

  /** Claim every instant due now onto the queue; one bad automation never stops the tick. */
  tick(now = this.deps.now()): number {
    const store = this.deps.store;
    let claimed = 0;
    for (const a of store.list()) {
      if (!a.enabled || !this.allowed(a.id)) continue;
      try {
        if (budgetPaused(store, a)) continue;
        const last = store.lastScheduled(a.id) ?? a.createdAt;
        for (const t of dueTimes(a.schedule, last, now, a.missed, a.anchor)) {
          const run = store.claimRun(a.id, runKey(a.id, t), t);
          if (run) {
            this.queue.push(run.id);
            claimed++;
          }
        }
      } catch {
        // A broken schedule or row must not block the others.
      }
    }
    return claimed;
  }

  /** Queue one manual run now, outside the schedule; null if it can't be claimed. */
  runNow(id: string): AutomationRun | null {
    const store = this.deps.store;
    if (!store.get(id)) return null;
    if (!this.allowed(id)) throw new Error("The owning plugin is Off or unavailable. Turn it On before running this automation.");
    const at = this.deps.now();
    const run = store.claimRun(id, `${id}@manual-${new Date(at).toISOString()}`, at);
    if (!run) return null;
    this.queue.push(run.id);
    return run;
  }

  /** Run queued runs one at a time, only while no interactive turn is running. */
  async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0 && !this.stopped) {
        if (this.deps.interactiveBusy()) break;
        await this.runOne(this.queue.shift()!);
      }
    } finally {
      this.draining = false;
    }
  }

  queued(): number {
    return this.queue.length;
  }

  /** Let the current run finish; drain then returns and leaves the rest queued. */
  stop(): void {
    this.stopped = true;
  }

  private async runOne(id: number): Promise<void> {
    const store = this.deps.store;
    const run = store.run(id);
    if (!run || run.status !== "queued") return;
    const a = store.get(run.automationId);
    // Disabled only stops the schedule: a manual run still goes.
    const manual = run.runKey.startsWith(`${run.automationId}@manual-`);
    if (a && a.configVersion !== run.configVersion) {
      this.notify(store.finishRun(id, { status: "cancelled", error: "Automation settings changed after this run was queued." }), a);
      return;
    }
    if (!a || (!a.enabled && !manual)) {
      store.finishRun(id, { status: "cancelled" });
      return;
    }
    const owner = this.deps.owner?.(a.id);
    const current = () => {
      const live = this.deps.owner?.(a.id);
      return ownerMatches(owner, live) && ["queued", "running", "waiting-input"].includes(store.run(id)?.status ?? "");
    };
    if (!current()) { this.cancel(run, a); return; }
    if (!manual && budgetPaused(store, a, id)) {
      store.finishRun(id, { status: "cancelled" });
      return;
    }
    let threadId: string | null = null;
    try {
      const sections: string[] = [];
      const advances: Checkpoint["advances"] = [];
      for (const sourceId of this.deps.sourcesFor(a)) {
        if (!current()) { this.cancel(run, a); return; }
        const src = this.deps.sources.get(sourceId);
        if (!src) {
          store.failSource(a.id, sourceId, "unknown source");
          sections.push(`### ${sourceId}\nunavailable: unknown source`);
          continue;
        }
        const cur = store.cursor(a.id, sourceId);
        try {
          const read = await src.read(cur.bookmark, { projectId: a.projectId, cwd: this.deps.cwdOf(a.projectId) });
          sections.push(`### ${sourceId}\n${read.items.length === 0 ? "no new items" : read.items.join("\n")}`);
          if (read.next !== null) advances.push({ source: sourceId, expected: cur.bookmark, next: read.next });
        } catch (err) {
          // A failed read is never "no new items": say so and keep the bookmark.
          const msg = reason(err);
          store.failSource(a.id, sourceId, msg);
          sections.push(`### ${sourceId}\nunavailable: ${msg}`);
        }
      }

      let prompt = a.prompt;
      if (sections.length > 0) prompt += `\n\n## Sources\n${sections.join("\n")}`;

      if (!current()) { this.cancel(run, a); return; }
      const tid = await this.deps.createThread(a);
      threadId = tid;
      if (!current()) { this.deps.interrupt?.(tid); this.cancel(run, a); return; }
      if (store.get(a.id)?.configVersion !== run.configVersion) {
        this.notify(store.finishRun(id, { status: "cancelled", error: "Automation settings changed before dispatch." }), a);
        return;
      }
      store.startRun(run.id, tid, this.deps.leaseMs);

      let budgetStopped = false;
      const checkMidBudget = () => {
        if (budgetStopped || a.budgetUsd === null) return;
        const live = this.totalsOrNull(tid);
        if (live?.costUsd !== null && live?.costUsd !== undefined && live.costUsd > a.budgetUsd) {
          budgetStopped = true;
          this.deps.interrupt?.(tid);
        }
      };
      const timer = setInterval(() => {
        if (!current()) { this.cancel(run, a); return; }
        store.renewLease(run.id, this.deps.leaseMs);
        checkMidBudget();
        const wait = this.deps.waitingInput(tid);
        const status = store.run(run.id)?.status;
        if (wait && status === "running") store.setStatus(run.id, "waiting-input");
        else if (!wait && status === "waiting-input") store.setStatus(run.id, "running");
      }, this.deps.pollMs ?? 1000);

      let text = "";
      try {
        const outcome = await this.deps.send(tid, prompt);
        text = outcome.text;
        if (!budgetStopped && current()) {
          if (outcome.status === "failed") throw new Error(outcome.reason);
          if (outcome.status === "cancelled") {
            const totals = this.totalsOrNull(tid);
            this.notify(store.finishRun(id, { ...totals, status: "cancelled", error: "Turn stopped." }), a);
            return;
          }
        }
      } catch (err) {
        if (!budgetStopped) throw err;
      } finally {
        clearInterval(timer);
      }
      // Off/On cannot resurrect a cancelled send or publish its late result.
      if (!current()) { this.cancel(run, a); return; }
      if (store.run(run.id)?.status === "waiting-input") store.setStatus(run.id, "running");

      const totals = this.deps.totals(tid);
      const overBudget = budgetStopped || (a.budgetUsd !== null && totals.costUsd !== null && totals.costUsd > a.budgetUsd);
      const status = overBudget ? "paused-budget" : "succeeded";

      if (budgetStopped && !text.trim()) {
        const finished = store.finishRun(run.id, { status: "paused-budget", costUsd: totals.costUsd, inputTokens: totals.inputTokens, outputTokens: totals.outputTokens, result: "" });
        this.notify(finished, a);
        return;
      }

      const key = `${run.runKey}:${this.deps.destination.id}`;
      const dest = this.deps.destination;
      const payload = { key, automationId: a.id, runId: run.id, threadId: tid, title: a.name, text };
      const cp: Checkpoint = { text, title: a.name, advances, final: { status, ...totals }, owner: owner ? { key: owner.key, revision: owner.revision } : null };
      const prepare = () => {
        store.checkpoint(run.id, cp);
        store.deliveryIntent(key, run.id, dest.id);
      };
      if (dest.afterCommit) {
        const finished = store.atomic(() => { prepare(); return this.completeDelivery(run, cp, key, key); });
        try { dest.afterCommit(payload); } catch { /* The receipt and result are already durable. */ }
        this.notify(finished, a);
        return;
      }
      store.atomic(prepare);
      let receipt: string | undefined;
      try {
        receipt = await dest.publish(payload);
      } catch {
        if (!current()) { this.cancel(run, a); return; }
        this.unconfirmed(run, cp, key, a);
        return;
      }
      if (!current()) { store.markUnknown(key); this.cancel(run, a); return; }
      try {
        this.notify(store.atomic(() => this.completeDelivery(run, cp, key, receipt)), a);
      } catch {
        // The external write already happened. Keep the intent eligible for lookup on restart.
        this.unconfirmed(run, cp, key, a);
      }
    } catch (err) {
      if (!current()) { this.cancel(run, a); return; }
      const totals = threadId ? this.totalsOrNull(threadId) : null;
      const failed = store.finishRun(run.id, {
        status: "failed",
        error: reason(err),
        costUsd: totals?.costUsd,
        inputTokens: totals?.inputTokens,
        outputTokens: totals?.outputTokens,
      });
      this.notify(failed, a);
    }
  }

  private unconfirmed(run: AutomationRun, cp: Checkpoint | null, key: string, a: Automation): void {
    const store = this.deps.store;
    const status = outcome(run, cp) === "paused-budget" ? "paused-budget" : "partial";
    const error = "Delivery could not be confirmed.";
    const finished = store.atomic(() => {
      store.markUnknown(key);
      if (run.status === status && run.error === error) return null;
      return store.finishRun(run.id, { ...savedResult(run, cp), status, error });
    });
    if (finished) this.notify(finished, a);
  }

  /** Called inside the receipt transaction, including when finalizing an older receipt. */
  private completeDelivery(run: AutomationRun, cp: Checkpoint | null, key: string, receipt?: string): AutomationRun {
    const store = this.deps.store;
    store.confirmDelivery(key, receipt, true);
    const status = outcome(run, cp);
    let uncertain = !status || (!cp && run.checkpoint !== null);
    if (status && cp) {
      for (const adv of cp.advances) {
        const previous = store.cursor(run.automationId, adv.source).bookmark;
        if (adv.next === previous) continue;
        if (adv.expected === undefined) uncertain = true;
        else if (adv.expected === previous) store.confirmSource(run.automationId, adv.source, adv.next);
      }
    }
    const finalStatus = status === "paused-budget" ? status : uncertain ? "partial" : "succeeded";
    const error = uncertain ? "Delivery confirmed; the original outcome or source bookmark is uncertain." : undefined;
    return store.finishRun(run.id, { ...savedResult(run, cp), status: finalStatus, error });
  }

  private totalsOrNull(threadId: string): { costUsd: number | null; inputTokens: number; outputTokens: number } | null {
    try {
      return this.deps.totals(threadId);
    } catch {
      return null;
    }
  }

  /** A listener's failure must not corrupt the run it's hearing about. */
  private notify(run: AutomationRun, a: Automation): void {
    try {
      this.deps.notify(run, a);
    } catch {
      /* ignore */
    }
  }
}
