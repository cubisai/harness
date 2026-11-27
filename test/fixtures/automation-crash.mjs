// Each invocation is a separate process. A crash exits without unwinding the runner,
// releasing its savepoint, or closing either database. The destination owns its own file.
import { register } from "node:module";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

register("./ts-resolve-hook.mjs", import.meta.url);
const { Store } = await import("../../src/main/db.ts");
const { AutomationStore } = await import("../../src/main/automations/store.ts");
const { AutomationRunner } = await import("../../src/main/automations/runner.ts");
const { messageCenterDestination } = await import("../../src/main/automations/destinations.ts");
const { noticeOf } = await import("../../src/main/automations/app.ts");
const { inboxRows } = await import("../../src/renderer/src/inbox.ts");

const [dir, target, phase, cut] = process.argv.slice(2);
const store = new Store(join(dir, "app.db"));
const db = new AutomationStore(store.sql);
const remote = new DatabaseSync(join(dir, "destination.db"));
remote.exec("CREATE TABLE IF NOT EXISTS messages (key TEXT PRIMARY KEY, receipt TEXT, body TEXT); CREATE TABLE IF NOT EXISTS attempts (key TEXT)");
const crash = (point) => { if (point === cut) process.exit(73); };
const local = messageCenterDestination(db, () => { throw Error("window closed"); });
const dest = target === "local" ? local : {
  id: "external", repeatable: true,
  async publish(p) {
    crash("before-publish");
    remote.prepare("INSERT INTO attempts VALUES (?)").run(p.key);
    remote.prepare("INSERT OR IGNORE INTO messages VALUES (?, 'opaque-42', ?)").run(p.key, p.text);
    crash("after-publish");
    return "opaque-42";
  },
  async check(key) {
    const row = remote.prepare("SELECT receipt FROM messages WHERE key = ?").get(key);
    return row ? { state: "confirmed", receipt: row.receipt } : "missing";
  },
};
if (phase === "start") {
  db.create({ id: "a", name: "Brief", projectId: "p", prompt: "Summarize", template: "project-brief", schedule: { kind: "interval", everyMinutes: 30 }, missed: "skip", enabled: false, agent: null, model: null, budgetUsd: null, anchor: 0 });
  db.confirmSource("a", "git", "old");
  const atomic = db.atomic.bind(db);
  let transaction = 0;
  db.atomic = (write) => {
    const number = ++transaction;
    const value = atomic(() => { const result = write(); crash(`before-commit-${number}`); return result; });
    crash(`after-commit-${number}`);
    return value;
  };
}
const runner = new AutomationRunner({
  store: db, now: () => 1, leaseMs: 60_000, notify: () => {}, destination: dest,
  sourcesFor: () => ["git"], sources: new Map([["git", { read: async () => ({ items: ["change"], next: "next" }) }]]),
  cwdOf: () => dir, totals: () => ({ inputTokens: 17, outputTokens: 4, costUsd: 0.25 }),
  createThread: async () => "thread", interactiveBusy: () => false, waitingInput: () => false,
  send: async () => { if (phase !== "start") throw Error("replayed turn"); return { status: "succeeded", text: "one brief" }; },
});
if (phase === "start") { runner.runNow("a"); await runner.drain(); }
if (phase === "recover") { await runner.recover(); await runner.drain(); }
const run = db.runs("a")[0];
const key = `${run.runKey}:${dest.id}`;
const latest = db.latestFinished("a");
const rows = inboxRows({ permissions: [], finished: [], threads: {}, selectedThreadId: null, automations: latest ? [noticeOf(latest, db.get("a"))] : [] });
console.log(JSON.stringify({ run, delivery: db.delivery(key), bookmark: db.cursor("a", "git").bookmark,
  attempts: remote.prepare("SELECT key FROM attempts").all(), messages: remote.prepare("SELECT * FROM messages").all(),
  alerts: rows.needsYou.length, finished: rows.finished.length, runCount: db.runs("a").length }));
remote.close();
store.close();
