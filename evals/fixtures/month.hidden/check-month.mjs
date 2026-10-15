import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseDate } from "./src/dates.js";
import { monthlyTotals } from "./src/report.js";
import { daysInMonth } from "./src/calendar.js";

const rows = JSON.parse(readFileSync(new URL("./data.json", import.meta.url), "utf8"));
assert.deepEqual(monthlyTotals(rows), { "2026-02": 20, "2026-03": 45 });
assert.equal(daysInMonth("2026-02-10"), 28);
assert.equal(daysInMonth("2024-02-01"), 29);
assert.equal(daysInMonth("2026-04-30"), 30);
assert.deepEqual(parseDate("2026-03-05"), { year: 2026, month: 3, day: 5 });
console.log("ok");
