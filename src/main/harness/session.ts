// A native session's history: one JSONL file per session, appended message by
// message, so a thread resumes exactly where it stopped, even after a crash.
// The file is the model's view; the thread's own event log stays in the database.

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LlmMessage } from "./llm/types";

const SESSION_ID = /^[a-zA-Z0-9-]{8,64}$/;

export class SessionStore {
  constructor(private readonly dir: string) {}

  private file(id: string): string {
    if (!SESSION_ID.test(id)) throw new Error(`Not a session id: ${id}`);
    return join(this.dir, `${id}.jsonl`);
  }

  /** A new, empty session. */
  create(): string {
    mkdirSync(this.dir, { recursive: true });
    const id = randomUUID();
    writeFileSync(this.file(id), "");
    return id;
  }

  /** The session's messages, or null when it doesn't exist. A torn last line is dropped. */
  load(id: string): LlmMessage[] | null {
    if (!SESSION_ID.test(id)) return null;
    const path = this.file(id);
    if (!existsSync(path)) return null;
    const out: LlmMessage[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as LlmMessage);
      } catch {
        break;
      }
    }
    return out;
  }

  append(id: string, message: LlmMessage): void {
    appendFileSync(this.file(id), `${JSON.stringify(message)}\n`);
  }

  /** Replace the whole history (compaction), atomically. */
  replace(id: string, messages: LlmMessage[]): void {
    const path = this.file(id);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, messages.map((m) => `${JSON.stringify(m)}\n`).join(""));
    renameSync(tmp, path);
  }
}

/**
 * Drop a dangling end a crash can leave: an assistant turn whose tool calls
 * never got results. The conversation then reads on from the last whole step.
 */
export function repairHistory(messages: LlmMessage[]): LlmMessage[] {
  const out = [...messages];
  const last = out.at(-1);
  if (last?.role === "assistant" && last.content.some((p) => p.type === "tool-call")) out.pop();
  return out;
}
