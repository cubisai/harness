// T9.4: usage, cache and limit figures are computed on the machine and never
// sent anywhere. None of the code that handles them may open a connection.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { cumulativeHitRate } from "../src/main/cache-policy";
import type { Usage } from "../src/shared/types";
// @ts-expect-error: a plain .mjs script without type declarations
import * as rollbackCheck from "../scripts/rollback-check.mjs";
import { tempDir } from "./helpers";

const NETWORK = ["fetch(", "http.request", "https.request", "net.connect", "XMLHttpRequest", "new WebSocket", 'from "node:http"', 'from "node:https"', 'from "node:net"'];
const root = join(__dirname, "..");

describe("no telemetry", () => {
  for (const file of ["src/main/cache-policy.ts", "src/shared/cache-stats.ts", "src/main/usage.ts", "src/main/agents/limits.ts", "scripts/rollback-check.mjs"]) {
    it(`${file} opens no connection`, () => {
      const text = readFileSync(join(root, file), "utf-8");
      for (const call of NETWORK) expect(text, call).not.toContain(call);
    });
  }
});

describe("scripts/rollback-check.mjs", () => {
  const u = (read: number | null, input: number, write = 0): Usage => ({
    inputTokens: input,
    outputTokens: 1,
    reasoningTokens: null,
    cacheReadTokens: read,
    cacheWriteTokens: write,
    cacheTtl: null,
    hitRate: null,
    miss: false,
    provenance: "reported",
  });
  const sample = [u(90, 10), u(0, 1000, 50), u(null, 400), u(5000, 200, 300)];

  it("computes the same cumulative hit rate as the app", () => {
    expect(rollbackCheck.cumulativeHitRate(sample)).toBe(cumulativeHitRate(sample));
    expect(rollbackCheck.cumulativeHitRate([])).toBe(cumulativeHitRate([]));
  });

  it("reads both 7-day windows from a database and gives the verdict", () => {
    const db = new DatabaseSync(join(tempDir(), "unskilled.db"));
    db.exec("CREATE TABLE events (thread_id TEXT, seq INTEGER, payload TEXT, created_at INTEGER)");
    const since = Date.parse("2026-10-01");
    const insert = db.prepare("INSERT INTO events VALUES ('t', ?, ?, ?)");
    const turn = (seq: number, at: number, usage: Usage) => insert.run(seq, JSON.stringify({ kind: "turn-end", usage }), at);
    turn(1, since - 2 * 86_400_000, u(800, 200)); // baseline 0.80
    turn(2, since + 86_400_000, u(740, 260)); // after: 0.74, -6 pp
    insert.run(3, JSON.stringify({ kind: "user", text: "ignored" }), since + 1);
    const r = rollbackCheck.verdict(db, since);
    db.close();
    expect(r.baseline).toBe(0.8);
    expect(r.current).toBe(0.74);
    expect(r.pass).toBe(false);
  });
});
