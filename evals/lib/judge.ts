// Model-judge grading (roadmap P8): a judge only counts once its stored
// calibration file shows it agrees with the labelled examples often enough.
// Pure apart from reading that file; every model call goes through `ask`.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CompactEvent } from "./types";

/** A judge's stored calibration: the rubric, the labelled examples, and the measured report. */
export interface Calibration {
  rubric: string;
  examples: { transcript: string; label: boolean }[];
  report?: { accuracy: number; agreement: number; n: number; model?: string; at?: string };
}

export const MIN_ACCURACY = 0.85;
export const MIN_EXAMPLES = 10;

type Ask = (prompt: string) => Promise<string>;

/** The transcript graders read, one labelled line per non-empty event. */
export function transcriptOf(events: CompactEvent[]): string {
  const lines: string[] = [];
  for (const e of events) {
    const body = e.text ?? e.summary ?? "";
    if (!body) continue;
    switch (e.kind) {
      case "assistant-text":
        lines.push(`assistant: ${body}`);
        break;
      case "tool-use":
        lines.push(`tool ${e.name ?? "?"}: ${body}`);
        break;
      case "tool-result":
        lines.push(`tool-result: ${body}`);
        break;
      case "error":
        lines.push(`error: ${body}`);
        break;
      case "notice":
        lines.push(`notice: ${body}`);
        break;
      case "plan-proposal":
        lines.push(`plan: ${body}`);
        break;
      default:
        lines.push(`${e.kind}: ${body}`);
        break;
    }
  }
  return lines.join("\n");
}

/** Every balanced `{...}` in `text` that parses as JSON, in order (strings/escapes respected). */
function objectsIn(text: string): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          try {
            out.push(JSON.parse(text.slice(i, j + 1)));
          } catch {
            // not JSON: keep scanning for the next object
          }
          i = j;
          break;
        }
      }
    }
  }
  return out;
}

/** The first JSON object in the reply with a boolean `pass`; null when there is none. */
export function parseVerdict(reply: string): { pass: boolean; why: string } | null {
  for (const o of objectsIn(reply)) {
    if (!o || typeof o !== "object" || !("pass" in o)) continue;
    const pass = (o as { pass: unknown }).pass;
    if (typeof pass !== "boolean") return null;
    const why = (o as { why?: unknown }).why;
    return { pass, why: typeof why === "string" ? why : "" };
  }
  return null;
}

/** One judge call: rubric, transcript, JSON answer. Unparseable replies are flagged `invalid`. */
export async function judgeOnce(ask: Ask, rubric: string, transcript: string): Promise<{ pass: boolean; why: string; invalid?: boolean }> {
  const prompt = `${rubric}\n\n--- transcript ---\n${transcript}\n--- end transcript ---\n\nReply with only JSON: {"pass": true|false, "why": "one sentence"}`;
  let reply: string;
  try {
    reply = await ask(prompt);
  } catch (err) {
    return { pass: false, why: `judge call failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200), invalid: true };
  }
  const v = parseVerdict(reply);
  if (!v) return { pass: false, why: "judge reply unparseable", invalid: true };
  return v;
}

/** Parses a pairwise reply's winner, or null when it is unreadable. */
function parseWinner(reply: string): { winner: 1 | 2 | "tie"; why: string } | null {
  for (const o of objectsIn(reply)) {
    if (!o || typeof o !== "object" || !("winner" in o)) continue;
    const w = (o as { winner: unknown }).winner;
    const why = (o as { why?: unknown }).why;
    const value = w === 1 || w === "1" ? 1 : w === 2 || w === "2" ? 2 : w === "tie" ? "tie" : null;
    if (value === null) continue;
    return { winner: value, why: typeof why === "string" ? why : "" };
  }
  return null;
}

/**
 * Blinded pairwise comparison: the prompt only shows "Response 1"/"Response 2",
 * in an order picked by `rng`; the swap is undone before mapping back to a/b.
 */
export async function pairwise(ask: Ask, rubric: string, a: string, b: string, rng: () => number = Math.random): Promise<{ winner: "a" | "b" | "tie"; why: string }> {
  const swapped = rng() < 0.5;
  const first = swapped ? b : a;
  const second = swapped ? a : b;
  const prompt = `${rubric}\n\nResponse 1:\n${first}\n\nResponse 2:\n${second}\n\nWhich response better satisfies the rubric? Reply with only JSON: {"winner": 1|2|"tie", "why": "one sentence"}`;
  const parsed = parseWinner(await ask(prompt));
  if (!parsed || parsed.winner === "tie") return { winner: "tie", why: parsed?.why ?? "" };
  const winner = parsed.winner === 1 ? (swapped ? "b" : "a") : swapped ? "a" : "b";
  return { winner, why: parsed.why };
}

/** Judges each example and scores agreement with its label; `agreement` is Cohen's kappa (0 when undefined). */
export async function calibrate(ask: Ask, rubric: string, examples: { transcript: string; label: boolean }[]): Promise<{ accuracy: number; agreement: number; n: number }> {
  const n = examples.length;
  if (n === 0) return { accuracy: 0, agreement: 0, n: 0 };
  // One at a time: a calibration set shouldn't burst a provider's rate limit.
  const verdicts: { pass: boolean; invalid?: boolean }[] = [];
  for (const e of examples) verdicts.push(await judgeOnce(ask, rubric, e.transcript));
  // An unreadable reply is a miss, never a lucky "fail" that matches a negative label.
  const accuracy = verdicts.filter((v, i) => !v.invalid && v.pass === examples[i]!.label).length / n;
  const pLabel = examples.filter((e) => e.label).length / n;
  const pJudge = verdicts.filter((v) => v.pass).length / n;
  const pe = pLabel * pJudge + (1 - pLabel) * (1 - pJudge);
  // pe === 1 means both raters are constant: kappa is undefined, so a perfect match scores 1 and anything else 0.
  const agreement = pe === 1 ? (accuracy === 1 ? 1 : 0) : (accuracy - pe) / (1 - pe);
  return { accuracy, agreement, n };
}

/** Reads `<root>/<name>.json`; null when it is missing or not valid JSON. */
export function loadCalibration(root: string, name: string): Calibration | null {
  try {
    return JSON.parse(readFileSync(join(root, `${name}.json`), "utf8")) as Calibration;
  } catch {
    return null;
  }
}

/** A judge counts only when its report clears the accuracy and example-count floors, for this rubric. */
export function isCalibrated(c: Calibration | null, rubric?: string): boolean {
  if (rubric !== undefined && c?.rubric.trim() !== rubric.trim()) return false;
  return !!c?.report && c.report.n >= MIN_EXAMPLES && c.report.accuracy >= MIN_ACCURACY;
}
