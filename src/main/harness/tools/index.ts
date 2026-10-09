// The harness's built-in tool set, shaped per model family: GPT models are
// trained on Codex's apply_patch, everything else edits by string replacement.

import { applyPatchTool } from "./apply-patch";
import { bashTool } from "./bash";
import { editTool } from "./edit";
import { globTool } from "./glob";
import { grepTool } from "./grep";
import { readTool } from "./read";
import { todoTool } from "./todo";
import type { NativeTool } from "./types";
import { writeTool } from "./write";

/** GPT, o-series and Codex models: they get apply_patch instead of edit. */
export function patchesNatively(modelId: string): boolean {
  return /(^|[/:])(gpt-|o\d|codex)/i.test(modelId);
}

/** The built-in tools for a model, in the order they're advertised. */
export function nativeTools(modelId: string): NativeTool[] {
  return [readTool, patchesNatively(modelId) ? applyPatchTool : editTool, writeTool, bashTool, globTool, grepTool, todoTool];
}

export { shellFor } from "./bash";
export { todosOf } from "./todo";
export type { NativeTool, ToolAccess, ToolContext, ToolResult } from "./types";
