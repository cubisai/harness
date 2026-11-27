// A native session's history: one JSONL file per session, appended message by
// message, so a thread resumes exactly where it stopped, even after a crash.
// The file is the model's view; the thread's own event log stays in the database.

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LlmMessage } from "./llm/types";

const SESSION_ID = /^[a-zA-Z0-9-]{8,64}$/;

/** What a session keeps beside its history so its prompt prefix stays the same across turns. */
export interface SessionMeta {
  /** The day the session started (YYYY-MM-DD): the prompt's date, frozen so it doesn't change the prefix at midnight. */
  startedOn?: string;
  /** The system + tools fingerprint of the last request (binding.ts prefixKey). */
  prefixKey?: string;
}

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

  /** Open for another turn. Normalize the on-disk append point before returning the model history. */
  resume(id: string): LlmMessage[] | null {
    if (!SESSION_ID.test(id) || !existsSync(this.file(id))) return null;
    const path = this.file(id), original = readFileSync(path, "utf8");
    const parsed: LlmMessage[] = [];
    let corrupt = false, interior = false;
    for (const line of original.split("\n")) {
      if (!line.trim()) continue;
      try {
        parsed.push(JSON.parse(line) as LlmMessage);
        if (corrupt) interior = true;
      } catch { corrupt = true; }
    }
    if (interior) {
      const backup = existsSync(`${path}.original`) ? `${path}.${randomUUID()}.original` : `${path}.original`;
      writeFileSync(backup, original, { flag: "wx", mode: 0o600 });
    }
    const history = repairHistory(parsed);
    if (corrupt || history !== parsed || (original && !original.endsWith("\n"))) this.replace(id, history);
    return history;
  }

  /** The session's sidecar metadata; {} when there is none or it's unreadable. */
  meta(id: string): SessionMeta {
    try {
      const value = JSON.parse(readFileSync(this.metaFile(id), "utf8")) as unknown;
      return value && typeof value === "object" ? (value as SessionMeta) : {};
    } catch {
      return {};
    }
  }

  setMeta(id: string, meta: SessionMeta): void {
    const path = this.metaFile(id);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(meta));
    renameSync(tmp, path);
  }

  private metaFile(id: string): string {
    return this.file(id).replace(/\.jsonl$/, ".meta.json");
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
  const out: LlmMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    if (message.role === "tool") continue; // orphaned result after a damaged record
    if (message.role !== "assistant" || !message.content.some((p) => p.type === "tool-call")) {
      out.push(message);
      continue;
    }
    const batch = messages[i + 1];
    const results = batch?.role === "tool" ? batch.results : [];
    const ids = new Set(results.map((r) => r.callId));
    const content = message.content.filter((p) => p.type !== "tool-call" || ids.has(p.id));
    if (content.length) out.push(content.length === message.content.length ? message : { ...message, content });
    if (batch?.role === "tool") {
      i++;
      const calls = new Set(content.filter((p) => p.type === "tool-call").map((p) => p.id));
      const matched = results.filter((r) => calls.has(r.callId));
      if (matched.length) out.push(matched.length === results.length ? batch : { role: "tool", results: matched });
    }
  }
  return out.length === messages.length && out.every((m, i) => m === messages[i]) ? messages : out;
}
