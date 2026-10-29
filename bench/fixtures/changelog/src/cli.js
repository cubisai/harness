#!/usr/bin/env node
// tally: counts lines, words and characters of the files given.
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const files = args.filter((a) => a !== "--verbose");

for (const file of files) {
  const text = readFileSync(file, "utf8");
  const counts = [text.split("\n").length, text.split(/\s+/).filter(Boolean).length, text.length];
  if (verbose) console.log(`${file}: ${counts[0]} lines, ${counts[1]} words, ${counts[2]} chars`);
  else console.log(`${counts.join("\t")}\t${file}`);
}
