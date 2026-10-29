import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dayKey } from "../src/day.js";

test("dayKey returns the UTC calendar day", () => {
  assert.equal(dayKey(new Date("2026-03-01T00:30:00Z")), "2026-03-01");
  assert.equal(dayKey(new Date("2026-02-28T23:59:59Z")), "2026-02-28");
  assert.equal(dayKey(new Date("2026-12-31T23:30:00Z")), "2026-12-31");
});

test("dayKey does not depend on the machine timezone", () => {
  const url = new URL("../src/day.js", import.meta.url).href;
  const script = [
    `const { dayKey } = await import(${JSON.stringify(url)});`,
    "process.stdout.write(dayKey(new Date('2026-03-01T00:30:00Z')));",
  ].join("\n");
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { ...process.env, TZ: "America/New_York" },
  });
  assert.equal(out.trim(), "2026-03-01");
});
