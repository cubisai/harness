/** One-line, human-readable summaries of tool calls and results. */

import { clipSummary as clip, SUMMARY_MAX as MAX } from "../../shared/tools";

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

export function summarizeToolInput(name: string, input: Record<string, unknown>): string {
  // browser_call (Browser tools on demand) reads as the tool it runs.
  if (/(^|_)browser_call$/.test(name) && typeof input.tool === "string") {
    const args = input.arguments && typeof input.arguments === "object" ? (input.arguments as Record<string, unknown>) : {};
    const inner = summarizeToolInput(input.tool, args);
    return inner === input.tool ? input.tool : clip(`${input.tool} · ${inner}`);
  }
  const pick =
    str(input.command) ??
    str(input.file_path) ??
    str(input.path) ??
    str(input.pattern) ??
    str(input.skill) ??
    str(input.description) ??
    str(input.url) ??
    str(input.query) ??
    str(input.prompt) ??
    // run_code's script, as one line.
    str(input.code);
  if (pick) return clip(pick);
  // Questions and plans read as their text, not as JSON.
  const questions = Array.isArray(input.questions) ? input.questions : null;
  const first = questions?.[0] as { question?: unknown; title?: unknown } | undefined;
  const asked = str(first?.question) ?? str(first?.title);
  if (asked) return clip(questions!.length > 1 ? `${asked} (+${questions!.length - 1} more)` : asked);
  const plan = str(input.plan);
  if (plan) return clip(plan.split(/\r?\n/).find((l) => l.trim())?.replace(/^#+\s*/, "") ?? plan);
  const json = JSON.stringify(input);
  return json === "{}" ? name : clip(json);
}

export function summarizeToolResult(content: unknown): string {
  if (typeof content === "string") return clip(content);
  if (Array.isArray(content)) {
    const text = content
      .map((b) => (b && typeof b === "object" && "text" in b && typeof b.text === "string" ? b.text : ""))
      .join(" ");
    return clip(text) || "(no text output)";
  }
  return "";
}
