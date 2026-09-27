// T9.7: the release gate on Phase 6's one-way sessionId → bindings transform.
// An M3 build must still open what M4 wrote, a pre-migration export must
// import with its cursor, and nothing may write sessionId except the mirror.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Store } from "../src/main/db";
import { exportThread, importThread } from "../src/main/handoff";
import { Store as M3Store } from "./fixtures/m3-store";
import { closeAfter, tempDir } from "./helpers";

function m4(file: string): Store {
  const s = new Store(file);
  closeAfter(() => s.close());
  return s;
}

describe("bindings rollback", () => {
  it("an M3 Store opens a database the M4 Store wrote, threads, cursors and events intact", () => {
    const file = join(tempDir(), "unskilled.db");
    const s = new Store(file); // closed below, before the M3 Store opens the file
    const project = s.addProject(tempDir());
    const thread = s.createThread(project.id, "claude", "opus", "ask");
    s.appendEvent(thread.id, { kind: "user", text: "hello" });
    s.updateThread(thread.id, { sessionId: "sess-claude" });
    // A switch to Codex and back: the Claude cursor survives in bindings and the column.
    s.updateThread(thread.id, { agent: "codex", sessionId: "sess-codex" });
    s.updateThread(thread.id, { agent: "claude" });
    s.appendEvent(thread.id, { kind: "assistant-text", text: "hi" });
    s.close();

    const old = new M3Store(file);
    try {
      expect(old.listProjects().map((p) => p.id)).toEqual([project.id]);
      const [t] = old.listThreads(project.id);
      expect(t).toMatchObject({ id: thread.id, agent: "claude", sessionId: "sess-claude" });
      expect(old.listEvents(thread.id).map((e) => e.event.kind)).toEqual(["user", "assistant-text"]);
      // And it can keep going: M3 writes the column M4 mirrors from.
      old.updateThread(thread.id, { sessionId: "sess-m3" });
      old.appendEvent(thread.id, { kind: "user", text: "after the downgrade" });
    } finally {
      old.close();
    }

    // Upgrading again resumes the session M3 used, not the stale binding.
    const again = m4(file);
    expect(again.getThread(thread.id).sessionId).toBe("sess-m3");
    expect(again.getThread(thread.id).bindings["codex:default"]?.resumeCursor).toBe("sess-codex");
    expect(again.listEvents(thread.id).map((e) => e.event.kind)).toEqual(["user", "assistant-text", "user"]);
  });

  it("an M3 database migrates forward with sessionId as the read-only projection of bindings", () => {
    const file = join(tempDir(), "unskilled.db");
    const old = new M3Store(file);
    const project = old.addProject(tempDir());
    const t = old.createThread(project.id, "codex", "gpt", "ask");
    old.updateThread(t.id, { sessionId: "legacy-cursor" });
    old.close();

    const s = m4(file);
    const thread = s.getThread(t.id);
    expect(thread.sessionId).toBe("legacy-cursor");
    expect(thread.bindings["codex:default"]).toMatchObject({ agent: "codex", resumeCursor: "legacy-cursor", status: "active" });
  });

  it("imports a pre-migration thread export (sessionId, no bindings) with its cursor", () => {
    const s = m4(join(tempDir(), "unskilled.db"));
    const project = s.addProject(tempDir());
    const source = s.createThread(project.id, "claude", "opus", "ask");
    s.appendEvent(source.id, { kind: "user", text: "old" });
    s.updateThread(source.id, { sessionId: "pre-m4" });
    const exported = exportThread(s, source.id);
    // What an export looked like before bindings existed.
    const { bindings: _dropped, ...oldShape } = exported.thread;
    const restored = importThread(s, project.id, { ...exported, thread: oldShape });
    expect(restored.sessionId).toBe("pre-m4");
    expect(restored.bindings["claude:default"]).toMatchObject({ agent: "claude", resumeCursor: "pre-m4" });
    expect(s.listEvents(restored.id).map((e) => e.event.kind)).toEqual(["user"]);
  });

  it("writes session_id only as the mirror of the current agent's binding", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".ts")) {
          readFileSync(path, "utf-8")
            .split("\n")
            .forEach((line, i) => {
              // SQL that sets the column, or code assigning a thread's sessionId field.
              if (/SET[^;]*\bsession_id\s*=/.test(line) || /\bthread\.sessionId\s*=[^=]/.test(line)) offenders.push(`${path}:${i + 1}`);
            });
        }
      }
    };
    walk(join(__dirname, "..", "src", "main"));
    // db.ts's updateThread mirrors bindings[current agent] into the column; that is the one writer.
    expect(offenders.map((o) => o.replace(/\\/g, "/").replace(/^.*src\/main\//, "src/main/").replace(/:\d+$/, ""))).toEqual(["src/main/db.ts"]);
  });
});
