// The new thread added the channel and, from the remembered rule, its line in docs/ipc.md.
import { existsSync, readFileSync } from "node:fs";

const fail = (why) => {
  console.error(`FAIL ${why}`);
  process.exit(1);
};
const main = readFileSync("src/main/index.ts", "utf8");
if (!main.includes("app:ping")) fail("src/main/index.ts has no app:ping channel");
if (!existsSync("docs/ipc.md")) fail("docs/ipc.md missing: the remembered rule wasn't applied");
// The rule asked for "- `<channel>`: …"; any separator counts, since what's tested is that the rule carried over.
if (!/^\s*-\s*`app:ping`/m.test(readFileSync("docs/ipc.md", "utf8"))) fail("docs/ipc.md has no - `app:ping` line");
console.log("ok");
