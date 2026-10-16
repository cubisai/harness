/**
 * The shared channel of an expert-team thread: one thread workspace folder
 * holding result files (Markdown), notes (JSON lines) and read cursors
 * (JSON), with the same four harness tools on every engine.
 */
import { z } from "zod";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HarnessTool, ToolOutput } from "../agents/types";

/** The harness tool a member calls to save a result file (Markdown). */
export const TEAM_WRITE_TOOL = "team_write";

/** The harness tool a member calls to read a result file from the workspace. */
export const TEAM_READ_TOOL = "team_read";

/** The harness tool a member calls to send a short note to the lead, a member, or all. */
export const TEAM_POST_TOOL = "team_post";

/** The harness tool a member calls to see its unread notes, the workspace files and the roster. */
export const TEAM_BOARD_TOOL = "team_board";

/** Direct member-to-member notes allowed since the lead's last note. */
export const PEER_NOTE_CAP = 6;

/** A note one team member sends to the lead, to a member, or to all. */
export interface TeamNote {
  /** ISO timestamp of the send. */
  at: string;
  /** Sender: "lead" or a member id. */
  from: string;
  /** Recipient: "lead", "all", or a member id. */
  to: string;
  /** The note, at most 600 characters. */
  text: string;
}

/** Options for the four team-channel tools. */
export interface TeamToolsOptions {
  /** The thread's workspace folder (created on first write). */
  dir: string;
  /** Member ids of the team; "lead" is always valid too. */
  members: string[];
  /** Called after each accepted note (the app shows it in the thread). */
  onNote?: (note: TeamNote) => void;
  /** Clock, for tests. */
  now?: () => Date;
}

/** Budgets, in characters, for results, reads and notes. */
const WRITE_MAX = 60000;
const READ_MAX = 20000;
const NOTE_MAX = 600;

/** A workspace file name: short, lowercase, no extension, no slashes. */
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const WRITE_SHAPE = {
  from: z.string().describe("Your member id (or lead)"),
  name: z.string().describe("Short lowercase file name, e.g. findings-step-1"),
  content: z.string().describe("The full result, in Markdown"),
};

const READ_SHAPE = {
  name: z.string().describe("The file name from team_board, without .md"),
};

const POST_SHAPE = {
  from: z.string().describe("Your member id (or lead)"),
  to: z.string().describe('"lead", "all", or a member id'),
  text: z.string().describe("The note; keep it short and point to team_write files for anything longer"),
};

const BOARD_SHAPE = {
  for: z.string().describe("Your member id (or lead)"),
};

function define<S extends z.ZodRawShape>(t: HarnessTool<S>): HarnessTool {
  return t as unknown as HarnessTool;
}

/** A failed tool reply. */
function fail(text: string): ToolOutput {
  return { text, isError: true };
}

/** Whether an id names the lead or one of the team's members. */
function isOnTeam(id: string, members: string[]): boolean {
  return id === "lead" || members.includes(id);
}

/** The roster line every tool shares. */
function roster(members: string[]): string {
  return ["lead", ...members].join(", ");
}

/** The unknown-agent-id error every tool shares. */
function memberError(id: string, members: string[]): ToolOutput {
  return fail(`Unknown team member "${id}". Team: ${roster(members)}.`);
}

/** The invalid-file-name error the write and read tools share. */
function badName(): ToolOutput {
  return fail("Use a short lowercase name like researcher-1 (letters, digits, hyphens).");
}

/** The path of a result file. */
function filePath(dir: string, name: string): string {
  return join(dir, `${name}.md`);
}

/** Makes the workspace folder exist before any write into it. */
function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/** Every well-formed note in notes.jsonl; a missing file or corrupt line is skipped. */
function readNotes(dir: string): TeamNote[] {
  const path = join(dir, "notes.jsonl");
  if (!existsSync(path)) return [];
  const notes: TeamNote[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<TeamNote>;
      if (typeof parsed.at === "string" && typeof parsed.from === "string" && typeof parsed.to === "string" && typeof parsed.text === "string") {
        notes.push({ at: parsed.at, from: parsed.from, to: parsed.to, text: parsed.text });
      }
    } catch {
      // A corrupt line is skipped; the rest of the log stays usable.
    }
  }
  return notes;
}

/** The read cursors, or {} when the file is missing or corrupt. */
function readCursors(dir: string): Record<string, number> {
  const path = join(dir, "cursors.json");
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const cursors: Record<string, number> = {};
    for (const [id, count] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof count === "number" && Number.isFinite(count)) cursors[id] = count;
    }
    return cursors;
  } catch {
    return {};
  }
}

/** Peer notes since the lead's last note; every peer note when the lead never posted. */
function peerNotes(notes: TeamNote[]): TeamNote[] {
  let start = 0;
  for (let i = notes.length - 1; i >= 0; i--) {
    if (notes[i]!.from === "lead") {
      start = i + 1;
      break;
    }
  }
  return notes.slice(start).filter((n) => n.from !== "lead" && n.to !== "lead");
}

/** The workspace's result files, sorted by name, without the .md suffix. */
function workspaceFiles(dir: string): { name: string; chars: number }[] {
  if (!existsSync(dir)) return [];
  const files: { name: string; chars: number }[] = [];
  for (const file of readdirSync(dir).filter((n) => n.endsWith(".md")).sort()) {
    try {
      files.push({ name: file.slice(0, -3), chars: readFileSync(join(dir, file), "utf8").length });
    } catch {
      // Unreadable or gone since the listing: leave it out.
    }
  }
  return files;
}

/**
 * The four team-channel harness tools for one thread: the workspace folder,
 * the roster and the note callback come from the caller, so a mixed team
 * (Claude, Codex, ACP engines) acts through one channel that works the same
 * for everyone.
 */
export function teamTools(opts: TeamToolsOptions): HarnessTool[] {
  const { dir, members } = opts;
  const now = opts.now ?? (() => new Date());

  return [
    define({
      name: TEAM_WRITE_TOOL,
      description:
        "Save your full result (Markdown) to the team workspace so the lead and other members can read it with team_read. Use a name like <your-id>-<step>. Overwrites a file of the same name.",
      input: WRITE_SHAPE,
      autoAllow: true,
      run: async (args) => {
        if (!isOnTeam(args.from, members)) return memberError(args.from, members);
        if (!NAME_RE.test(args.name)) return badName();
        if (args.content.length > WRITE_MAX) return fail(`Too long: ${args.content.length} chars; keep a result under ${WRITE_MAX} (split it).`);
        ensureDir(dir);
        writeFileSync(filePath(dir, args.name), args.content, "utf8");
        return { text: `Saved ${args.name} (${args.content.length} chars) at ${filePath(dir, args.name)}.` };
      },
    }),
    define({
      name: TEAM_READ_TOOL,
      description: "Read a file from the team workspace (a member's result or a brief).",
      input: READ_SHAPE,
      autoAllow: true,
      run: async (args) => {
        if (!NAME_RE.test(args.name)) return badName();
        const path = filePath(dir, args.name);
        if (!existsSync(path)) return fail(`No file named ${args.name}. Call team_board to list the workspace.`);
        const content = readFileSync(path, "utf8");
        return {
          text: content.length > READ_MAX ? `${content.slice(0, READ_MAX)}\n\n[truncated: ${content.length} chars total]` : content,
        };
      },
    }),
    define({
      name: TEAM_POST_TOOL,
      description:
        "Send a short note to the lead, one member, or all. Keep it under 600 characters and point to files for anything longer. Members: prefer reporting to the lead.",
      input: POST_SHAPE,
      autoAllow: true,
      run: async (args) => {
        if (!isOnTeam(args.from, members)) return memberError(args.from, members);
        if (!isOnTeam(args.to, members) && args.to !== "all") return memberError(args.to, members);
        if (args.from === args.to) return fail("You can't post to yourself.");
        const text = args.text.trim();
        if (!text || text.length > NOTE_MAX) {
          return fail("Keep a note under 600 characters; save longer text with team_write and point to it.");
        }
        if (args.from !== "lead" && args.to !== "lead" && peerNotes(readNotes(dir)).length >= PEER_NOTE_CAP) {
          return fail("Direct-note limit reached for this round; report to the lead instead.");
        }
        const note: TeamNote = { at: now().toISOString(), from: args.from, to: args.to, text };
        ensureDir(dir);
        appendFileSync(join(dir, "notes.jsonl"), `${JSON.stringify(note)}\n`, "utf8");
        opts.onNote?.(note);
        return { text: `Sent to ${args.to}.` };
      },
    }),
    define({
      name: TEAM_BOARD_TOOL,
      description: "Your inbox and the team workspace: unread notes for you (marked read), the workspace files and the team roster.",
      input: BOARD_SHAPE,
      autoAllow: true,
      run: async (args) => {
        if (!isOnTeam(args.for, members)) return memberError(args.for, members);
        const notes = readNotes(dir);
        const cursors = readCursors(dir);
        const cursor = cursors[args.for] ?? 0;
        const unread = notes.filter((n, i) => i >= cursor && (n.to === args.for || n.to === "all") && n.from !== args.for);
        if ((cursors[args.for] ?? 0) !== notes.length) {
          cursors[args.for] = notes.length;
          ensureDir(dir);
          writeFileSync(join(dir, "cursors.json"), `${JSON.stringify(cursors)}\n`, "utf8");
        }
        const lines = [`Workspace: ${dir}`, `Team: ${roster(members)}`, `Unread notes (${unread.length}):`];
        if (unread.length) {
          for (const n of unread) lines.push(`- ${n.from} → ${n.to}: ${n.text}`);
        } else {
          lines.push("- none");
        }
        lines.push("Files:");
        const files = workspaceFiles(dir);
        if (files.length) {
          for (const f of files) lines.push(`- ${f.name} (${f.chars} chars)`);
        } else {
          lines.push("- none");
        }
        return { text: lines.join("\n") };
      },
    }),
  ];
}
