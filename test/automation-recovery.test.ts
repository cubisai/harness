import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { expect, it } from "vitest";
import { tempDir } from "./helpers";

// Check both the crash image and what two fresh startup reconciliations leave behind.
it.each([
  ["local", "before-commit-1", "none"],
  ["local", "after-commit-1", "settled"],
  ["external", "before-commit-1", "none"],
  ["external", "after-commit-1", "intent"],
  ["external", "before-publish", "intent"],
  ["external", "after-publish", "published"],
  ["external", "before-commit-2", "published"],
  ["external", "after-commit-2", "settled"],
])("recovers %s delivery after %s (%s)", (target, cut, image) => {
  const dir = tempDir();
  const child = (phase: string) => {
    const p = spawnSync(process.execPath, ["--experimental-transform-types", join(__dirname, "fixtures/automation-crash.mjs"), dir, target, phase, ...(phase === "start" ? [cut] : [])], { encoding: "utf8", timeout: 10_000 });
    expect(p.status, p.error?.message ?? p.stderr).toBe(phase === "start" ? 73 : 0);
    return phase === "start" ? null : JSON.parse(p.stdout);
  };
  child("start");
  const before = child("inspect");
  const key = `${before.run.runKey}:${target === "local" ? "message-center" : "external"}`;
  expect(before.run.status).toBe(image === "settled" ? "succeeded" : "running");
  expect(before.run.checkpoint !== null).toBe(image !== "none");
  expect(before.delivery?.state ?? null).toBe(image === "none" ? null : image === "settled" ? "confirmed" : "intent");
  expect(before.bookmark).toBe(image === "settled" ? "next" : "old");
  expect(before.attempts).toHaveLength(target === "external" && ["published", "settled"].includes(image) ? 1 : 0);

  const recovered = child("recover");
  expect(recovered.runCount).toBe(1);
  if (image === "none") {
    expect(recovered).toMatchObject({ delivery: null, bookmark: "old", alerts: 1, finished: 0, attempts: [], run: { status: "interrupted", result: null, inputTokens: null, outputTokens: null, costUsd: null } });
  } else {
    expect(recovered).toMatchObject({ bookmark: "next", alerts: 0, finished: 1, run: { status: "succeeded", result: "one brief", inputTokens: 17, outputTokens: 4, costUsd: 0.25 }, delivery: { state: "confirmed", idempotencyKey: key, runId: recovered.run.id, receipt: target === "local" ? key : "opaque-42" } });
    expect(recovered.attempts).toEqual(target === "local" ? [] : [{ key }]);
    expect(recovered.messages).toEqual(target === "local" ? [] : [{ key, receipt: "opaque-42", body: "one brief" }]);
  }
  expect(child("recover")).toEqual(recovered);
}, 30_000);
