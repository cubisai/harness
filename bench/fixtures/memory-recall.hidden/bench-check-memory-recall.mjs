// The notes went where the memory note says, in its format: docs/releases/2.4.0.md, "# v2.4.0", a "- " line about /codemode.
import { existsSync, readFileSync } from "node:fs";

const file = ["docs/releases/2.4.0.md", "docs/releases/v2.4.0.md"].find((f) => existsSync(f));
const fail = (why) => {
  console.error(`FAIL ${why}`);
  process.exit(1);
};
if (!file) fail("no docs/releases/2.4.0.md");
const text = readFileSync(file, "utf8");
if (!/^#\s*v2\.4\.0\s*$/m.test(text)) fail(`${file} doesn't start with a "# v2.4.0" heading`);
if (!/^\s*-\s+.*codemode/im.test(text)) fail(`${file} has no "- " line about /codemode`);
console.log(`ok ${file}`);
