import { skillsOf } from "../../shared/skill-list";
import type { StoredEvent } from "../../shared/types";
import { canonicalTool } from "../../shared/tools";

/** One thing the thread draws: an event as is, a folded run of work, or a turn's footer. */
export type Segment =
  | { kind: "event"; stored: StoredEvent }
  /** Consecutive tool calls (and the thinking between them). `done` = something came after, so it folds. */
  | { kind: "work"; key: number; items: StoredEvent[]; startedAt: number; endedAt: number; done: boolean }
  /** A turn's end: its final answer (for Copy), the message that started it (for Retry, and its seq for the turn's score), and what it changed. */
  | { kind: "turn-end"; stored: StoredEvent; answer: string; prompt: { text: string; skills?: string[] } | null; userSeq: number | null; changes: TurnChanges | null };

export interface TurnChanges {
  files: string[];
  /** Line counts, or null when no edit in the turn reported a "+a −d" stat. */
  additions: number | null;
  deletions: number | null;
}

/** A tool call or the thinking between calls: what a "Worked for" fold holds. */
function isWork(e: StoredEvent): boolean {
  const k = e.event.kind;
  return k === "tool-use" || k === "tool-result" || k === "thinking";
}

/**
 * Group a thread's top-level events for display (DESIGN.md §7.4): runs of
 * tool calls become one "Worked for" fold once the turn has moved past them;
 * a run still in progress stays as plain rows. A run of thinking alone stays
 * as its reasoning block. Each turn-end carries its answer, prompt and changes.
 */
export function segmentEvents(events: StoredEvent[], running: boolean): Segment[] {
  const out: Segment[] = [];
  let run: StoredEvent[] = [];
  let answer: string[] = [];
  let prompt: { text: string; skills?: string[] } | null = null;
  let userSeq: number | null = null;
  let edits = new Map<string, { additions: number; deletions: number }>();
  let statKnown = false;
  const results = new Map<string, { summary?: string; isError: boolean }>();
  for (const e of events) if (e.event.kind === "tool-result") results.set(e.event.toolUseId, { summary: e.event.summary, isError: e.event.isError });

  const flush = (done: boolean, endedAt: number) => {
    if (!run.length) return;
    if (run.some((e) => e.event.kind === "tool-use")) {
      out.push({ kind: "work", key: run[0]!.seq, items: run, startedAt: run[0]!.createdAt, endedAt, done });
    } else {
      for (const e of run) if (e.event.kind !== "tool-result") out.push({ kind: "event", stored: e });
    }
    run = [];
  };

  // For each index: is there a tool call later in the same turn? Narration and
  // thinking between calls fold with them; only text after the last call is the answer.
  const moreWork: boolean[] = new Array(events.length).fill(false);
  for (let i = events.length - 1, seen = false; i >= 0; i--) {
    const k = events[i]!.event.kind;
    moreWork[i] = seen;
    if (k === "user" || k === "turn-end") seen = false;
    else if (k === "tool-use") seen = true;
  }

  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    const ev = e.event;
    if (ev.kind === "tool-use" && canonicalTool(ev.name) === "Edit") {
      const r = results.get(ev.toolUseId);
      if (r && !r.isError) {
        const stat = /\+(\d+)\s+[−-](\d+)/.exec(r.summary ?? "");
        if (stat) statKnown = true;
        for (const file of ev.summary.split(", ").filter(Boolean)) {
          const prev = edits.get(file) ?? { additions: 0, deletions: 0 };
          // A multi-file edit reports one stat: count it once, on its first file.
          const first = file === ev.summary.split(", ")[0];
          edits.set(file, { additions: prev.additions + (stat && first ? Number(stat[1]) : 0), deletions: prev.deletions + (stat && first ? Number(stat[2]) : 0) });
        }
      }
    }
    if (isWork(e) || (run.length > 0 && ev.kind === "assistant-text" && moreWork[i])) {
      run.push(e);
      continue;
    }
    flush(true, e.createdAt);
    if (ev.kind === "user") {
      const skills = skillsOf(ev);
      prompt = { text: ev.text, ...(skills.length ? { skills } : {}) };
      userSeq = e.seq;
      answer = [];
      edits = new Map();
      statKnown = false;
    }
    if (ev.kind === "assistant-text") answer.push(ev.text);
    if (ev.kind === "turn-end") {
      const files = [...edits.keys()];
      const changes = files.length
        ? {
            files,
            additions: statKnown ? [...edits.values()].reduce((n, s) => n + s.additions, 0) : null,
            deletions: statKnown ? [...edits.values()].reduce((n, s) => n + s.deletions, 0) : null,
          }
        : null;
      out.push({ kind: "turn-end", stored: e, answer: answer.join("\n\n"), prompt, userSeq, changes });
      answer = [];
      edits = new Map();
      statKnown = false;
      continue;
    }
    out.push({ kind: "event", stored: e });
  }
  const last = run[run.length - 1];
  flush(!running, last?.createdAt ?? 0);
  return out;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The fold's one line after "Worked for …": what kinds of steps it holds. */
export function workSummary(items: StoredEvent[]): string {
  let read = 0;
  let searched = 0;
  let ran = 0;
  let other = 0;
  const edited = new Set<string>();
  for (const e of items) {
    if (e.event.kind !== "tool-use") continue;
    const name = canonicalTool(e.event.name);
    if (name === "Read") read++;
    else if (name === "Search") searched++;
    else if (name === "Run") ran++;
    else if (name === "Edit") for (const f of e.event.summary.split(", ").filter(Boolean)) edited.add(f);
    else other++;
  }
  return [
    read ? `read ${plural(read, "file", "files")}` : "",
    searched ? `searched ${plural(searched, "time", "times")}` : "",
    edited.size ? `edited ${plural(edited.size, "file", "files")}` : "",
    ran ? `ran ${plural(ran, "command", "commands")}` : "",
    other ? plural(other, "other step", "other steps") : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** "41s", "2m 05s", "1h 3m": how long a fold's work took. */
export function workDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
