import { writeFile } from "node:fs/promises";
import { join } from "node:path";

// Writes each item to <dir>/<item.id>.json and resolves with how many were written.
export async function saveAll(dir, items) {
  await Promise.all(items.map((item) => writeFile(join(dir, `${item.id}.json`), JSON.stringify(item))));
  return items.length;
}
