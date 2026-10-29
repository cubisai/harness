// Writes the design lint as one page expression (what design_lint runs) to a file, for lint-pages.sh.
// bun bench/stitch/lint-script.ts out.js
import { writeFileSync } from "node:fs";
import { lintScript } from "../../src/main/design/lint";

const sel = (el: Element): string => {
  const parts: string[] = [];
  for (let e: Element | null = el; e && e !== document.body && parts.length < 4; e = e.parentElement) {
    parts.unshift(e.tagName.toLowerCase() + (e.className && typeof e.className === "string" ? `.${e.className.trim().split(/\s+/)[0]}` : ""));
  }
  return parts.join(">");
};
writeFileSync(process.argv[2]!, lintScript(sel));
