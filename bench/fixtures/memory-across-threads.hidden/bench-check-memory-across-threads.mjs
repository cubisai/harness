// The new thread added the channel and, from the remembered rule, documented it in docs/ipc.md.
// --format also wants the rule's exact form, "- `<channel>`: …" (scored, not required: what's tested is that the rule carried over).
import { existsSync, readFileSync } from "node:fs";

const fail = (why) => {
  console.error(`FAIL ${why}`);
  process.exit(1);
};
const main = readFileSync("src/main/index.ts", "utf8");
if (!main.includes("app:ping")) fail("src/main/index.ts has no app:ping channel");
if (!existsSync("docs/ipc.md")) fail("docs/ipc.md missing: the remembered rule wasn't applied");
const doc = readFileSync("docs/ipc.md", "utf8");
if (!doc.includes("app:ping")) fail("docs/ipc.md doesn't mention app:ping");
if (process.argv.includes("--format") && !/^\s*-\s*`app:ping`/m.test(doc)) fail("docs/ipc.md mentions app:ping, but not as a - `app:ping` line");
console.log("ok");
