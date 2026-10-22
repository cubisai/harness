// The skeleton went where the memory note says: test/e2e/<feature>.e2e.test.ts with the it.todo.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join("test", "e2e");
const files = existsSync(dir) ? readdirSync(dir).filter((f) => /\.e2e\.test\.ts$/.test(f)) : [];
const hit = files.find((f) => /it\.todo\(\s*["'`]flips code mode for new threads/.test(readFileSync(join(dir, f), "utf8")));
if (!hit) {
  console.error(`FAIL no test/e2e/*.e2e.test.ts with the it.todo (found: ${files.join(", ") || "none"})`);
  process.exit(1);
}
console.log(`ok ${join(dir, hit)}`);
