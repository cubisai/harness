/**
 * The `--smoke` release checks that don't need a window: the provider
 * registry answers, a legacy install migrates, handoff keeps its invariants,
 * and Claude's adapter produces the canonical event set. Each works in a temp
 * folder of its own and never touches the user's data. Also run by vitest.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ThreadEvent } from "../shared/types";
import { codexCompatible } from "../shared/provider-rules";
import { handleMessage, newTurnState } from "./agents/claude";
import type { TurnInput } from "./agents/types";
import { CANONICAL, claudeCanonicalMessages, shape, visible } from "./canonical-events";
import { Store } from "./db";
import { buildCheckpoint, exportThread, importThread, renderCheckpoint } from "./handoff";
import { injectionFor } from "./inject";
import { FALLBACK_INSTRUCTIONS } from "./inject/codex";
import { SettingsStore, type SecretBox } from "./settings";

export interface SmokeResult {
  ok: boolean;
  detail?: string;
}

/** Stands in for the keychain: reversible, never plaintext on disk. */
const box: SecretBox = {
  available: true,
  encrypt: (s) => Buffer.from([...s].reverse().join("")).toString("base64"),
  decrypt: (b) => [...Buffer.from(b, "base64").toString()].reverse().join(""),
};

const fail = (detail: string): SmokeResult => ({ ok: false, detail });

/** Providers resolve into each agent's plan: Claude's key env, Codex's Responses-only overrides, subscription stays keyless. */
export function smokeProviders(dir: string): SmokeResult {
  const settings = new SettingsStore(join(dir, "settings.json"), box);
  const model = { id: "smoke-model", capabilities: { tools: true, vision: false, reasoning: true }, contextWindow: 128_000, maxOutput: 8_000 };
  settings.saveProvider({ id: "smoke-anthropic", label: "Smoke Anthropic", wireProtocol: "anthropic-messages", baseURL: "https://api.anthropic.com", models: [model] }, "smoke-key-a");
  settings.saveProvider({ id: "smoke-responses", label: "Smoke Responses", wireProtocol: "openai-responses", baseURL: "https://gw.example.com/v1", models: [model] }, "smoke-key-b");
  settings.saveProvider({ id: "smoke-chat", label: "Smoke Chat", wireProtocol: "openai-chat", baseURL: "https://gw.example.com/v1", models: [model] }, "smoke-key-c");
  settings.setCredential("claude", { kind: "byok", providerId: "smoke-anthropic" });
  settings.setCredential("codex", { kind: "byok", providerId: "smoke-responses" });

  const claude = injectionFor(settings, "claude", process.env, { injector: "claude" });
  if (!claude.byok || claude.error || claude.env.ANTHROPIC_API_KEY !== "smoke-key-a") return fail(`claude plan: ${claude.error ?? "key not injected"}`);
  const codex = injectionFor(settings, "codex", process.env, { injector: "codex", codexCatalogDir: join(dir, "catalogs"), codexInstructions: () => FALLBACK_INSTRUCTIONS });
  if (!codex.byok || codex.error || !codex.args?.some((a) => a.includes("unskilled-smoke-responses"))) return fail(`codex plan: ${codex.error ?? "provider not in args"}`);
  if (codexCompatible(settings.providers().find((p) => p.id === "smoke-chat")!).ok) return fail("codex accepted a chat-completions provider");
  settings.setCredential("claude", { kind: "subscription" });
  const sub = injectionFor(settings, "claude", process.env, { injector: "claude" });
  if (sub.byok || "ANTHROPIC_API_KEY" in sub.env) return fail("subscription plan carries a key");
  return { ok: true };
}

/** A Milestone 3 install (v1 settings.json, a pre-bindings database) opens without losing a key or a cursor. */
export function smokeMigration(dir: string): SmokeResult {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "settings.json");
  const legacySecrets = { anthropic: box.encrypt("legacy-key-1") };
  writeFileSync(file, JSON.stringify({ settings: { theme: "dark" }, secrets: legacySecrets }));
  const settings = new SettingsStore(file, box);
  const disk = JSON.parse(readFileSync(file, "utf-8")) as { schemaVersion?: number; secrets?: unknown };
  if (settings.providerSecret("anthropic") !== "legacy-key-1") return fail("legacy key not migrated to a provider");
  if (JSON.stringify(disk.secrets) !== JSON.stringify(legacySecrets)) return fail("secrets.* changed on disk");
  if (settings.get().theme !== "dark") return fail("legacy preference lost");

  // The M3 schema, as that build created it (plus its one migration: threads.agent).
  const dbFile = join(dir, "m3.db");
  const old = new DatabaseSync(dbFile);
  old.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE threads (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, title TEXT NOT NULL,
      session_id TEXT, model TEXT NOT NULL, permission_mode TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      agent TEXT NOT NULL DEFAULT 'claude');
    CREATE TABLE schema_version (version INTEGER NOT NULL);
    INSERT INTO schema_version (version) VALUES (1);
    CREATE TABLE events (thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE, seq INTEGER NOT NULL, payload TEXT NOT NULL,
      created_at INTEGER NOT NULL, PRIMARY KEY (thread_id, seq));
    INSERT INTO projects VALUES ('p', '${join(dir, "project").replace(/'/g, "''")}', 'project', 1);
    INSERT INTO threads VALUES ('t', 'p', 'Legacy', 'm3-cursor', 'opus', 'ask', 1, 2, 'claude');
    INSERT INTO events VALUES ('t', 1, '{"kind":"user","text":"hi"}', 1);
  `);
  old.close();
  const store = new Store(dbFile);
  try {
    const thread = store.getThread("t");
    if (thread.sessionId !== "m3-cursor") return fail(`thread cursor after migration: ${thread.sessionId}`);
    if (store.listEvents("t").length !== 1) return fail("events lost in migration");
  } finally {
    store.close();
  }
  return { ok: true };
}

/** A handoff checkpoint carries no reasoning or conventions, and a thread export round-trips. */
export async function smokeHandoff(dir: string): Promise<SmokeResult> {
  const project = join(dir, "project");
  mkdirSync(project, { recursive: true });
  const store = new Store(join(dir, "handoff.db"));
  try {
    const p = store.addProject(project);
    const t = store.createThread(p.id, "claude", "opus", "ask");
    const events: ThreadEvent[] = [
      { kind: "user", text: "Add rate limiting to login." },
      { kind: "thinking", text: "SECRET-REASONING-MARKER", opaque: false },
      { kind: "tool-use", toolUseId: "c1", name: "Run", summary: "npm test", payload: { command: "npm test" } },
      { kind: "tool-result", toolUseId: "c1", isError: false, summary: "3 passed", payload: { exitCode: 0, output: "3 passed" } },
      { kind: "tool-use", toolUseId: "r1", name: "Read", summary: "CLAUDE.md" },
      { kind: "tool-result", toolUseId: "r1", isError: false, summary: "CONVENTIONS-MARKER", payload: "CONVENTIONS-MARKER" },
      { kind: "assistant-text", text: "Added a limiter in src/rate.ts." },
    ];
    for (const e of events) store.appendEvent(t.id, e);
    // Tier 0 is the fullest rendering: it has to carry the command and still leave these out.
    const text = renderCheckpoint(await buildCheckpoint(store, t.id), 0);
    if (text.includes("SECRET-REASONING-MARKER")) return fail("checkpoint carries reasoning");
    if (text.includes("CONVENTIONS-MARKER")) return fail("checkpoint carries CLAUDE.md output");
    if (!text.includes("rate limiting")) return fail("checkpoint lost the goal");
    if (!text.includes("npm test") || !text.includes("exit 0")) return fail("checkpoint lost the command it ran");
    const copy = importThread(store, p.id, JSON.parse(JSON.stringify(exportThread(store, t.id))));
    if (store.listEvents(copy.id).length !== events.length) return fail("thread export didn't round-trip");
  } finally {
    store.close();
  }
  return { ok: true };
}

/** Claude's adapter, in this build, turns the canonical SDK messages into the canonical event set. */
export function smokeCanonicalEvents(): { ok: boolean; events: ThreadEvent[]; detail?: string } {
  const events: ThreadEvent[] = [];
  const input = { onEvent: (e: ThreadEvent) => events.push(e), onTextDelta: () => {} } as unknown as TurnInput;
  const turn = newTurnState();
  for (const m of claudeCanonicalMessages()) handleMessage(m as SDKMessage, input, turn);
  const got = visible(events);
  const same = JSON.stringify(got.map(shape)) === JSON.stringify(CANONICAL);
  return same ? { ok: true, events: got } : { ok: false, events: got, detail: JSON.stringify(got.map(shape)) };
}
