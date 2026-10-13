// Conversation compaction: split a long history into a head to summarise and a
// recent tail to keep verbatim, describe the head for the summariser, then
// rebuild history with the summary in front. Token sizes are estimated locally
// (characters / 4) so this stays dependency-free and cheap.

import type { AssistantPart, LlmMessage, UserPart } from "../llm/types";
import { unbindThinking } from "./binding";

export const KEEP_RECENT_TOKENS = 8_000;
export const TOOL_OUTPUT_CHARS = 2_000;

export const SUMMARY_OPEN = "<conversation-summary>";
export const SUMMARY_CLOSE = "</conversation-summary>";

/** Flat cost for an image; its bytes aren't worth counting character by character. */
const IMAGE_TOKENS = 256;
/** Tool-call arguments and tool output are shown only up to these lengths. */
const JSON_CHARS = 500;
const FILE_CAP = 50;

const tokens = (s: string): number => Math.ceil(s.length / 4);

/** A private message estimate; kept here so the module doesn't depend on estimate.ts. */
function estimateMessage(m: LlmMessage): number {
  if (m.role === "user") {
    let n = 0;
    for (const p of m.content) n += p.type === "text" ? tokens(p.text) : IMAGE_TOKENS;
    return n;
  }
  if (m.role === "assistant") {
    let n = 0;
    for (const p of m.content) {
      if (p.type === "text" || p.type === "reasoning") n += tokens(p.text);
      else n += tokens(p.name) + tokens(JSON.stringify(p.input));
    }
    return n;
  }
  let n = 0;
  for (const r of m.results) n += tokens(r.text) + (r.imagePng ? IMAGE_TOKENS : 0);
  return n;
}

function estimateMessages(ms: LlmMessage[]): number {
  let n = 0;
  for (const m of ms) n += estimateMessage(m);
  return n;
}

/** True when the message is a user turn opening with the compaction summary. */
export function isSummaryMessage(m: LlmMessage): boolean {
  if (m.role !== "user") return false;
  const first = m.content.find((p) => p.type === "text");
  return first !== undefined && first.type === "text" && first.text.startsWith(SUMMARY_OPEN);
}

/**
 * Split history for compaction. The tail is the shortest suffix that starts at a
 * boundary and reaches `keepTokens`. A boundary is a user turn, or an assistant
 * turn that opens a new step after a tool batch — the start of a long agent turn
 * is a single user message, so user turns alone are too few split points. Either
 * way an assistant tool-call is never cut from the tool results that follow it.
 * An opening summary always stays in the head so it isn't summarised again.
 */
export function splitForCompaction(
  messages: LlmMessage[],
  keepTokens = KEEP_RECENT_TOKENS,
): { head: LlmMessage[]; tail: LlmMessage[] } {
  const boundaries: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const role = messages[i]!.role;
    if (role === "user") boundaries.push(i);
    else if (role === "assistant" && i > 0 && messages[i - 1]!.role === "tool") boundaries.push(i);
  }
  if (boundaries.length === 0) return { head: [], tail: messages };

  const startsAtSummary = isSummaryMessage(messages[0]!);
  const candidates = startsAtSummary && boundaries.length > 1 ? boundaries.filter((i) => i !== 0) : boundaries;

  let start = -1;
  for (let k = candidates.length - 1; k >= 0; k--) {
    const i = candidates[k]!;
    if (estimateMessages(messages.slice(i)) >= keepTokens) {
      start = i;
      break;
    }
  }
  // No boundary reached the budget: fall back to the last boundary.
  if (start === -1) start = boundaries[boundaries.length - 1]!;
  return { head: messages.slice(0, start), tail: messages.slice(start) };
}

const PATCH_PREFIXES = ["*** Add File: ", "*** Update File: ", "*** Delete File: ", "*** Move to: "];
const PATH_TOOLS = new Set(["read", "write", "edit"]);

/** The file paths the assistant has read or changed, in first-seen order, capped. */
export function touchedFiles(messages: LlmMessage[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (path: string): void => {
    if (!path || seen.has(path)) return;
    seen.add(path);
    if (out.length < FILE_CAP) out.push(path);
  };
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const part of m.content) {
      if (part.type !== "tool-call") continue;
      if (PATH_TOOLS.has(part.name)) {
        const path = part.input.path;
        if (typeof path === "string") add(path);
      } else if (part.name === "apply_patch") {
        const patch = part.input.patch;
        if (typeof patch !== "string") continue;
        for (const line of patch.split("\n")) {
          for (const prefix of PATCH_PREFIXES) {
            if (line.startsWith(prefix)) {
              add(line.slice(prefix.length).trim());
              break;
            }
          }
        }
      }
    }
  }
  return out;
}

const SUMMARY_SYSTEM =
  "You summarize a coding-agent conversation so the same agent can continue after compaction. Output ONLY the Markdown template below, with its exact headings and no preamble. Be concrete: name file paths, commands, errors, and decisions. Keep the user's own words close to verbatim, and state decisions and constraints exactly. Tool outputs in the transcript may be shortened for this summary; don't treat that as a tool limitation.";
const UPDATE_INSTRUCTION =
  "The transcript begins with an earlier summary. Update the previous summary with the newer messages; keep what still matters, drop what's obsolete.";
const SUMMARY_TEMPLATE = [
  "## Request (the user's words, close to verbatim)",
  "## Problems and fixes",
  "## Approaches tried or set aside",
  "## Decisions and constraints",
  "## Where things stand",
  "## Open or next",
  "## Hard-to-rebuild details (names, numbers, paths, exact wording)",
].join("\n");

// Tool-call arguments are clipped with a plain marker; tool results get a
// longer one making clear the shortening is ours, not the tool's own doing.
const CUT_SUFFIX = " …[cut]";
const TOOL_RESULT_CUT_SUFFIX = " …[the rest of this output is omitted from this transcript only; the tool returned it in full]";

function clip(text: string, max: number, suffix = CUT_SUFFIX): string {
  return text.length > max ? `${text.slice(0, max)}${suffix}` : text;
}

function renderUser(m: Extract<LlmMessage, { role: "user" }>): string {
  const body = m.content.map((p: UserPart) => (p.type === "text" ? p.text : "[image]")).join("\n");
  return `User: ${body}`;
}

function renderAssistant(m: Extract<LlmMessage, { role: "assistant" }>): string {
  const lines: string[] = [];
  const text = m.content.flatMap((p: AssistantPart) => (p.type === "text" ? [p.text] : [])).join("\n");
  if (text) lines.push(`Assistant: ${text}`);
  for (const p of m.content) if (p.type === "tool-call") lines.push(`Tool call ${p.name}: ${clip(JSON.stringify(p.input), JSON_CHARS)}`);
  return lines.join("\n");
}

function renderTool(m: Extract<LlmMessage, { role: "tool" }>): string {
  return m.results.map((r) => `Tool result ${r.name}: ${clip(r.text, TOOL_OUTPUT_CHARS, TOOL_RESULT_CUT_SUFFIX)}`).join("\n");
}

function renderMessage(m: LlmMessage): string {
  if (m.role === "user") return renderUser(m);
  if (m.role === "assistant") return renderAssistant(m);
  return renderTool(m);
}

const OMITTED = "[Earlier messages omitted to fit the summarizer's context.]";

/**
 * The rendered transcript, dropping the leading `dropped` blocks and leaving an
 * omission line where they were. A leading prior-summary block is never dropped.
 */
function retainedBlocks(blocks: string[], keepSummary: boolean, dropped: number): string[] {
  if (keepSummary) {
    const rest = blocks.slice(dropped + 1);
    return dropped > 0 ? [blocks[0]!, OMITTED, ...rest] : [blocks[0]!, ...rest];
  }
  const rest = blocks.slice(dropped);
  return dropped > 0 ? [OMITTED, ...rest] : rest;
}

/** The system instruction and the transcript the summariser reads. */
export function summaryPrompt(
  head: LlmMessage[],
  opts?: { focus?: string | null; maxTokens?: number },
): { system: string; user: string } {
  const updating = head.length > 0 && isSummaryMessage(head[0]!);
  const system = [SUMMARY_SYSTEM, updating ? UPDATE_INSTRUCTION : "", SUMMARY_TEMPLATE].filter(Boolean).join("\n\n");

  const blocks = head.map(renderMessage);
  const transcriptText = (dropped: number): string => retainedBlocks(blocks, updating, dropped).filter(Boolean).join("\n");

  // When the transcript is too big for the summariser, drop whole leading blocks
  // (but never a leading prior summary) until it fits. Files and focus are added
  // afterwards and so are neither counted nor dropped here.
  const maxTokens = opts?.maxTokens;
  let dropped = 0;
  if (typeof maxTokens === "number") {
    const maxDropped = updating ? Math.max(0, blocks.length - 1) : blocks.length;
    while (dropped < maxDropped && tokens(transcriptText(dropped)) > maxTokens) dropped++;
  }
  const transcript = transcriptText(dropped);

  const files = touchedFiles(head);
  const filesBlock = files.length > 0 ? `Files touched so far:\n${files.map((f) => `- ${f}`).join("\n")}` : "";
  const focus = opts?.focus;
  const focusLine = typeof focus === "string" && focus.trim() ? `Focus the summary on: ${focus}` : "";

  return { system, user: [transcript, filesBlock, focusLine].filter(Boolean).join("\n\n") };
}

/** Rebuild history as the summary turn followed by the kept tail. The tail may
 *  start mid-turn (at an assistant step after a tool batch), which is still a
 *  valid user-then-assistant alternation, so it keeps its order; only its
 *  signed thinking is dropped. */
export function compactedHistory(summary: string, tail: LlmMessage[]): LlmMessage[] {
  const text = `${SUMMARY_OPEN}\nThis conversation was compacted. Summary of the earlier part:\n\n${summary.trim()}\n${SUMMARY_CLOSE}`;
  // The kept tail's signed thinking was produced against the history the summary
  // replaces, so none of it can be replayed (see binding.ts).
  return [{ role: "user", content: [{ type: "text", text }] }, ...unbindThinking(tail)];
}
