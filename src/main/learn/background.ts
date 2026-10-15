// The background model every self-improve step runs on (plan: "cheap models
// only"): never the thread's own model unless it is already the cheap one.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelOption } from "../../shared/types";
import type { LearnSettings } from "../../shared/learn";
import type { AgentDriver } from "../agents/types";
import { pickExtractorModel } from "../memory/extractor";
import { PROVIDER_AGENT_PREFIX } from "../harness/driver";

export interface BackgroundModel {
  driver: AgentDriver;
  model: string;
  effort: string | null;
  /** "Agent · model", for the Learned tab. */
  label: string;
}

/** Cheapest-first name hints (the extractor's list, without "free": a free tier can be the slowest). */
const CHEAP = ["flash", "haiku", "mini", "nano", "lite", "luna", "small"];
const EFFORTS = ["none", "minimal", "low"];

const cheapest = (models: ModelOption[]): ModelOption | null => {
  for (const hint of CHEAP) {
    const m = models.find((x) => x.id.toLowerCase().includes(hint) || x.label.toLowerCase().includes(hint));
    if (m) return m;
  }
  return null;
};

const lowEffort = (m: ModelOption | undefined): string | null => EFFORTS.find((e) => m?.efforts?.includes(e)) ?? null;

const make = (driver: AgentDriver, model: string): BackgroundModel => {
  const option = driver.models().find((m) => m.id === model);
  return { driver, model, effort: lowEffort(option), label: `${driver.label} · ${option?.label ?? model}` };
};

/**
 * The project's background model: the one picked in Settings (per project, then
 * global); else a native provider's flash/haiku model; else the thread agent's
 * cheap tier; else any agent's cheap model. Null when nothing cheap can run.
 */
export function pickBackground(o: { learn: LearnSettings; projectId: string; drivers: AgentDriver[]; thread?: { agent: string; model: string } | null }): BackgroundModel | null {
  const chosen = o.learn.backgroundByProject[o.projectId] ?? o.learn.background;
  if (chosen) {
    const d = o.drivers.find((x) => x.id === chosen.agent);
    if (d) return make(d, chosen.model);
  }
  for (const d of o.drivers.filter((x) => x.id.startsWith(PROVIDER_AGENT_PREFIX))) {
    const m = cheapest(d.models());
    if (m) return make(d, m.id);
  }
  const own = o.thread ? o.drivers.find((x) => x.id === o.thread!.agent) : undefined;
  if (own && o.thread) {
    const { model } = pickExtractorModel(own.models(), o.thread.model);
    if (cheapest(own.models().filter((m) => m.id === model))) return make(own, model);
  }
  for (const d of o.drivers) {
    const m = cheapest(d.models());
    if (m) return make(d, m.id);
  }
  return null;
}

/** Rough tokens for text a driver doesn't count: 4 characters each. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

/**
 * One hidden prompt on the background model: the driver's own one-shot when it
 * has one, else a plan-mode turn in an empty temp folder with every tool call
 * denied. Returns the reply and the tokens it cost (reported, else estimated).
 */
export async function backgroundShot(bg: BackgroundModel, prompt: string, signal: AbortSignal): Promise<{ text: string; tokens: number }> {
  if (bg.driver.oneShot) {
    const text = await bg.driver.oneShot({ prompt, model: bg.model, effort: bg.effort, signal });
    return { text, tokens: estimateTokens(prompt) + estimateTokens(text) };
  }
  mkdirSync(tmpdir(), { recursive: true });
  const cwd = mkdtempSync(join(tmpdir(), "cubiq-learn-"));
  const parts: string[] = [];
  let tokens = 0;
  try {
    await bg.driver.runTurn({
      threadId: `learn-${Date.now()}`,
      cwd,
      prompt,
      sessionId: null,
      model: bg.model,
      effort: bg.effort,
      permissionMode: "plan",
      signal,
      onEvent: (e) => {
        if (e.kind === "assistant-text") parts.push(e.text);
        if (e.kind === "turn-end") tokens += e.inputTokens + e.outputTokens;
      },
      onTextDelta: () => {},
      onSession: () => {},
      requestPermission: async () => "deny",
      requestPlanDecision: async () => ({ keep: "" }),
      requestUserInput: async () => "dismiss",
      tools: [],
      mcpServers: [],
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
  const text = parts.join("\n");
  return { text, tokens: tokens || estimateTokens(prompt) + estimateTokens(text) };
}
