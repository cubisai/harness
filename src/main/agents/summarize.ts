/** One-line, human-readable summaries of tool calls and results. */

const MAX = 160;

function clip(text: string, max = MAX): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

export function summarizeToolInput(name: string, input: Record<string, unknown>): string {
  const pick =
    str(input.command) ??
    str(input.file_path) ??
    str(input.path) ??
    str(input.pattern) ??
    str(input.skill) ??
    str(input.description) ??
    str(input.url) ??
    str(input.query) ??
    str(input.prompt);
  if (pick) return clip(pick);
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
