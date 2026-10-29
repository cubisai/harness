// apply_patch: OpenAI Codex's patch format (the shape GPT models are trained on).
// parsePatch turns the text into an ordered plan and run applies every file
// all-or-nothing, so a bad hunk leaves the tree untouched.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { unifiedDiff } from "../../../shared/diff";
import { noteRead, resolvePath } from "./paths";
import { str, ToolError, type NativeTool, type ToolResult, type ToolContext } from "./types";

/** One patch hunk: an optional anchor plus its context/removal/addition lines. */
export interface PatchHunk {
  anchor?: string;
  lines: { op: " " | "-" | "+"; text: string }[];
}

/** One file section of a patch, before it is applied. */
export interface PatchFile {
  kind: "add" | "delete" | "update";
  path: string;
  moveTo?: string;
  content?: string;
  hunks?: PatchHunk[];
}

/** One planned change, fully computed before anything is written. */
interface PatchPlan {
  kind: "add" | "delete" | "update";
  shown: string;
  oldText: string;
  newText: string;
  diffPath: string;
  writeAbs?: string;
  writeContent?: string;
  removeAbs?: string;
  moveOld?: string;
  moveNew?: string;
}

/**
 * Parse Codex apply_patch text into an ordered list of file operations.
 * Tolerates leading/trailing blank lines and a missing final newline.
 */
export function parsePatch(text: string): PatchFile[] {
  const src = text.replace(/\r\n/g, "\n").split("\n");
  let first = 0;
  while (first < src.length && src[first]!.trim() === "") first++;
  let last = src.length;
  while (last > first && src[last - 1]!.trim() === "") last--;
  const lines = src.slice(first, last);
  if (lines[0] !== "*** Begin Patch") throw new ToolError('The patch must start with "*** Begin Patch".');
  if (lines[lines.length - 1] !== "*** End Patch") throw new ToolError('The patch must end with "*** End Patch".');
  const body = lines.slice(1, -1);
  const files: PatchFile[] = [];
  let i = 0;
  while (i < body.length) {
    const line = body[i]!;
    if (line.startsWith("*** Add File:")) {
      const path = line.slice("*** Add File:".length).trim();
      i++;
      const added: string[] = [];
      while (i < body.length && !body[i]!.startsWith("*** ")) {
        const content = body[i]!;
        if (content.startsWith("+")) added.push(content.slice(1));
        else if (content === "") added.push("");
        i++;
      }
      files.push({ kind: "add", path, content: `${added.join("\n")}\n` });
    } else if (line.startsWith("*** Delete File:")) {
      files.push({ kind: "delete", path: line.slice("*** Delete File:".length).trim() });
      i++;
    } else if (line.startsWith("*** Update File:")) {
      const path = line.slice("*** Update File:".length).trim();
      i++;
      let moveTo: string | undefined;
      if (i < body.length && body[i]!.startsWith("*** Move to:")) {
        moveTo = body[i]!.slice("*** Move to:".length).trim();
        i++;
      }
      const hunks: PatchHunk[] = [];
      while (i < body.length && !body[i]!.startsWith("*** ")) {
        const head = body[i]!;
        if (!head.startsWith("@@")) {
          i++;
          continue;
        }
        const anchor = head.slice(2).trim();
        const hunk: PatchHunk = anchor ? { anchor, lines: [] } : { lines: [] };
        i++;
        while (i < body.length && !body[i]!.startsWith("@@") && !body[i]!.startsWith("*** ")) {
          const hl = body[i]!;
          if (hl.startsWith(" ")) hunk.lines.push({ op: " ", text: hl.slice(1) });
          else if (hl.startsWith("-")) hunk.lines.push({ op: "-", text: hl.slice(1) });
          else if (hl.startsWith("+")) hunk.lines.push({ op: "+", text: hl.slice(1) });
          i++;
        }
        hunks.push(hunk);
      }
      files.push({ kind: "update", path, ...(moveTo !== undefined ? { moveTo } : {}), hunks });
    } else {
      i++;
    }
  }
  return files;
}

/** Locate the run of old lines at or after `from`: exact, then trimEnd, then trim. */
function findRun(lines: string[], old: { text: string }[], from: number): number {
  const wanted = old.map((l) => l.text);
  if (!wanted.length) return Math.min(from, lines.length);
  const cmp = (a: string, b: string, mode: number): boolean =>
    mode === 0 ? a === b : mode === 1 ? a.trimEnd() === b.trimEnd() : a.trim() === b.trim();
  for (let mode = 0; mode < 3; mode++) {
    for (let start = from; start + wanted.length <= lines.length; start++) {
      let ok = true;
      for (let k = 0; k < wanted.length; k++) {
        if (!cmp(lines[start + k]!, wanted[k]!, mode)) {
          ok = false;
          break;
        }
      }
      if (ok) return start;
    }
  }
  return -1;
}

/** Apply hunks in order, each searched from where the previous one ended; restores CRLF. */
function applyHunks(oldText: string, hunks: PatchHunk[], path: string): string {
  const crlf = oldText.includes("\r\n");
  const text = crlf ? oldText.replace(/\r\n/g, "\n") : oldText;
  const trailing = text.endsWith("\n");
  const lines = text.split("\n");
  if (trailing) lines.pop();
  let from = 0;
  for (const hunk of hunks) {
    if (hunk.anchor !== undefined) {
      let at = -1;
      for (let i = from; i < lines.length; i++) {
        if (lines[i]!.trim() === hunk.anchor) {
          at = i;
          break;
        }
      }
      if (at < 0) throw new ToolError(`Couldn't find in ${path}: ${hunk.anchor}`);
      from = at + 1;
    }
    const oldLines = hunk.lines.filter((l) => l.op !== "+");
    const newLines = hunk.lines.filter((l) => l.op !== "-");
    const at = findRun(lines, oldLines, from);
    if (at < 0) throw new ToolError(`Couldn't find in ${path}: ${oldLines.slice(0, 3).map((l) => l.text).join("\n")}`);
    lines.splice(at, oldLines.length, ...newLines.map((l) => l.text));
    from = at + newLines.length;
  }
  let out = lines.join("\n");
  if (trailing) out += "\n";
  return crlf ? out.replace(/\n/g, "\r\n") : out;
}

/** Codex-format patch tool: add, delete, update, and move files all-or-nothing. */
export const applyPatchTool: NativeTool = {
  name: "apply_patch",
  displayName: "Edit",
  description:
    'Apply a patch in the OpenAI Codex "apply_patch" format to add, delete, update, or move one or more files in a single call. ' +
    'The patch must start with "*** Begin Patch" and end with "*** End Patch"; sections are "*** Add File: <path>" (every following line starts with "+"), ' +
    '"*** Delete File: <path>", and "*** Update File: <path>" optionally followed by "*** Move to: <new path>". ' +
    'In an update, "@@ <optional anchor>" starts a hunk, context lines start with a space, removals with "-", additions with "+", and an optional "*** End of File" marks the last hunk. ' +
    "Hunks are located by surrounding context (tolerating trailing-whitespace differences) and the whole patch is checked before anything is written, so if any file fails no files change.",
  parameters: {
    type: "object",
    properties: {
      patch: { type: "string", description: "The full patch text, from *** Begin Patch to *** End Patch." },
    },
    required: ["patch"],
  },
  access: "edit",
  summarize(args: Record<string, unknown>): string {
    const patch = str(args, "patch");
    if (!patch) return "";
    try {
      return parsePatch(patch).map((f) => f.path).join(", ");
    } catch {
      return "";
    }
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const patch = str(args, "patch", true);
    const files = parsePatch(patch);

    const plans: PatchPlan[] = [];
    for (const file of files) {
      const rp = resolvePath(ctx.cwd, file.path);
      if (file.kind === "add") {
        if (existsSync(rp.abs)) throw new ToolError(`${rp.shown} already exists; use *** Update File to change it.`);
        const content = file.content ?? "";
        plans.push({ kind: "add", shown: rp.shown, oldText: "", newText: content, diffPath: rp.shown, writeAbs: rp.abs, writeContent: content });
      } else if (file.kind === "delete") {
        if (!existsSync(rp.abs)) throw new ToolError(`${rp.shown} does not exist.`);
        plans.push({ kind: "delete", shown: rp.shown, oldText: readFileSync(rp.abs, "utf-8"), newText: "", diffPath: rp.shown, removeAbs: rp.abs });
      } else {
        if (!existsSync(rp.abs)) throw new ToolError(`${rp.shown} does not exist.`);
        const oldText = readFileSync(rp.abs, "utf-8");
        const newText = applyHunks(oldText, file.hunks ?? [], rp.shown);
        if (file.moveTo !== undefined) {
          const mp = resolvePath(ctx.cwd, file.moveTo);
          plans.push({ kind: "update", shown: rp.shown, oldText, newText, diffPath: mp.shown, writeAbs: mp.abs, writeContent: newText, removeAbs: rp.abs, moveOld: rp.shown, moveNew: mp.shown });
        } else {
          plans.push({ kind: "update", shown: rp.shown, oldText, newText, diffPath: rp.shown, writeAbs: rp.abs, writeContent: newText });
        }
      }
    }

    const textLines: string[] = [];
    const diff: { path: string; unified: string }[] = [];
    for (const plan of plans) {
      if (plan.kind === "add") textLines.push(`A ${plan.shown}`);
      else if (plan.kind === "delete") textLines.push(`D ${plan.shown}`);
      else if (plan.moveOld !== undefined && plan.moveNew !== undefined) textLines.push(`R ${plan.moveOld} -> ${plan.moveNew}`);
      else textLines.push(`M ${plan.shown}`);
      diff.push({ path: plan.diffPath, unified: unifiedDiff(plan.diffPath, plan.oldText, plan.newText) });
      if (plan.writeAbs !== undefined && plan.writeContent !== undefined) {
        mkdirSync(dirname(plan.writeAbs), { recursive: true });
        writeFileSync(plan.writeAbs, plan.writeContent);
        noteRead(ctx, plan.writeAbs);
      }
      if (plan.removeAbs !== undefined) {
        unlinkSync(plan.removeAbs);
        noteRead(ctx, plan.removeAbs);
      }
    }

    const summary = plans.map((p) => p.shown).join(", ");
    return {
      text: `${textLines.join("\n")}\nDone.`,
      display: { summary, result: { diff } },
    };
  },
};
