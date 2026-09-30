// A stdio MCP server that never answers: for the listServerTools timeout test.
// It writes its own pid to HANG_PID_FILE (from the test's spec.env) so the test
// can check the process tree was stopped after the timeout.
import { writeFileSync } from "node:fs";

if (process.env.HANG_PID_FILE) writeFileSync(process.env.HANG_PID_FILE, String(process.pid));

setInterval(() => {}, 1000);
