import { createHash } from "node:crypto";
import type { AutomationInput, Schedule } from "../../shared/automations";
import type { Thread } from "../../shared/types";
import { stableStringify } from "../cache-policy";
import { validSchedule } from "../automations/schedule";
import type { AutomationDraft } from "../extensions/manifest";

export interface AutomationAgent { id: string; models: string[] }
function record(v: unknown): v is Record<string, unknown> { return typeof v === "object" && v !== null && !Array.isArray(v); }
function exact(v: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(v).some((k) => !keys.includes(k))) throw new Error("Unexpected automation configuration field.");
}
function text(v: unknown, max: number, singleLine = false): string {
  if (typeof v !== "string" || !v.trim() || Buffer.byteLength(v) > max || v.includes("\0") || (singleLine && /[\r\n]/.test(v))) throw new Error("Invalid automation title or prompt.");
  return v.trim();
}
function scheduleOf(v: unknown): Schedule {
  if (!record(v)) throw new Error("Schedule must be an object.");
  let schedule: Schedule;
  if (v.kind === "interval") {
    exact(v, ["kind", "everyMinutes"]);
    if (typeof v.everyMinutes !== "number") throw new Error("everyMinutes must be a number.");
    schedule = { kind: "interval", everyMinutes: v.everyMinutes };
  } else if (v.kind === "daily") {
    exact(v, ["kind", "at", "days", "timeZone"]);
    if (typeof v.at !== "string" || typeof v.timeZone !== "string" || (v.days !== undefined && (!Array.isArray(v.days) || !v.days.every((d) => typeof d === "number")))) throw new Error("Invalid daily schedule.");
    schedule = { kind: "daily", at: v.at, timeZone: v.timeZone, ...(Array.isArray(v.days) ? { days: [...v.days].sort((a, b) => a - b) } : {}) };
  } else throw new Error("Schedule kind must be interval or daily.");
  const bad = validSchedule(schedule);
  if (bad) throw new Error(bad);
  return schedule;
}

export function checkAutomationAgent(input: Pick<AutomationInput, "agent" | "model">, agents: AutomationAgent[]): void {
  const agent = agents.find((a) => a.id === input.agent);
  if (!agent) throw new Error(`Unknown automation agent: ${input.agent}`);
  if (input.model !== null && !agent.models.includes(input.model)) throw new Error(`Unknown model for ${agent.id}: ${input.model}`);
}

/** Creator cannot select enabled/unattended, templates, sources, presets, or a different project. */
export function prepareAutomation(name: string, config: unknown, thread: Thread, agents: AutomationAgent[]): AutomationDraft {
  if (!record(config)) throw new Error("Automation config must be an object.");
  exact(config, ["title", "prompt", "schedule", "missed", "budgetUsd", "agent", "model"]);
  const agent = config.agent === undefined ? thread.agent : config.agent;
  if (typeof agent !== "string" || !agent.trim() || agent.length > 160) throw new Error("Choose an available automation agent.");
  const rawModel = config.model === undefined ? (agent === thread.agent ? thread.model : null) : config.model;
  const model = rawModel === "default" ? null : rawModel;
  if (model !== null && (typeof model !== "string" || !model.trim() || model.length > 240)) throw new Error("Invalid automation model.");
  const missed = config.missed ?? "skip";
  if (missed !== "skip" && missed !== "coalesce") throw new Error("Missed policy must be skip or coalesce.");
  const budgetUsd = config.budgetUsd ?? null;
  if (budgetUsd !== null && (typeof budgetUsd !== "number" || !Number.isFinite(budgetUsd) || budgetUsd <= 0)) throw new Error("Budget must be a finite positive amount or null.");
  const input: AutomationInput = { name: text(config.title, 120, true), template: "custom", prompt: text(config.prompt, 32 * 1024), schedule: scheduleOf(config.schedule), missed, enabled: false, permissions: "ask", agent, model: model as string | null, budgetUsd: budgetUsd as number | null };
  checkAutomationAgent(input, agents);
  return { kind: "automation", name, input };
}

/** Persisted proposals are rechecked without treating them as editor requests. */
export function validateAutomationDraft(v: Record<string, unknown>): AutomationDraft {
  exact(v, ["kind", "name", "input"]);
  if (typeof v.name !== "string" || !record(v.input)) throw new Error("Invalid automation proposal.");
  const i = v.input;
  exact(i, ["name", "template", "prompt", "schedule", "missed", "enabled", "permissions", "agent", "model", "budgetUsd"]);
  if (i.enabled !== false || i.permissions !== "ask" || i.template !== "custom" || typeof i.agent !== "string" || (i.model !== null && typeof i.model !== "string")) throw new Error("Creator automations must install Off/Ask with a custom prompt.");
  return prepareAutomation(v.name, { title: i.name, prompt: i.prompt, schedule: i.schedule, missed: i.missed, budgetUsd: i.budgetUsd, agent: i.agent, model: i.model }, { agent: i.agent, model: "default" } as Thread, [{ id: i.agent, models: typeof i.model === "string" ? [i.model] : [] }]);
}

/** Ownership fingerprint ignores run history, but includes every editor-controlled setting. */
export function automationDigest(a: AutomationInput): string {
  const input: AutomationInput = { name: a.name, template: a.template, prompt: a.prompt, schedule: a.schedule, missed: a.missed, enabled: a.enabled, agent: a.agent, model: a.model, budgetUsd: a.budgetUsd, permissions: a.permissions };
  return createHash("sha256").update(stableStringify(input)).digest("hex");
}
