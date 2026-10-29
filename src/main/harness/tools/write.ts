// The model's Write tool: create or overwrite a file after the read-before-write
// freshness check, preserving a CRLF file's line endings and returning the diff.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { unifiedDiff } from "../../../shared/diff";
import { assertFresh, noteRead, resolvePath } from "./paths";
import { str, type NativeTool } from "./types";

/** Create a new file or overwrite an existing one for the model. */
export const writeTool: NativeTool = {
  name: "write",
  displayName: "Write",
  access: "edit",
  description:
    "Create a new file or overwrite an existing one in the thread's folder. " +
    "An existing file must have been read earlier in the session and be unchanged since, otherwise the write is refused. " +
    "Missing parent directories are created, text is written as UTF-8, and a file that used CRLF line endings keeps them. " +
    "Paths resolve against the thread's working folder.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to the thread's working folder or absolute." },
      content: { type: "string", description: "The full new contents of the file." },
    },
    required: ["path", "content"],
  },
  summarize: (args) => str(args, "path") ?? "",
  run: async (args, ctx) => {
    const p = resolvePath(ctx.cwd, str(args, "path", true));
    const raw = str(args, "content", true);
    assertFresh(ctx, p);

    let old = "";
    try {
      old = readFileSync(p.abs, "utf8");
    } catch {
      old = "";
    }
    const existed = existsSync(p.abs);
    const text = old.includes("\r\n") && !raw.includes("\r") ? raw.replace(/\n/g, "\r\n") : raw;
    mkdirSync(dirname(p.abs), { recursive: true });
    writeFileSync(p.abs, text, "utf8");
    noteRead(ctx, p.abs);

    const lines = text === "" ? 0 : text.replace(/\r?\n$/, "").split("\n").length;
    const oldWithoutCR = old.replace(/\r\n/g, "\n");
    const newWithoutCR = text.replace(/\r\n/g, "\n");
    return {
      text: `${existed ? "Wrote" : "Created"} ${p.shown} (${lines} lines)`,
      display: { summary: p.shown, result: { diff: [{ path: p.shown, unified: unifiedDiff(p.shown, oldWithoutCR, newWithoutCR) }] } },
    };
  },
};
