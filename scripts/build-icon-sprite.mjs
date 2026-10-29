// Builds resources/design-icons/icons.svg: a curated Lucide set (ISC, from the installed lucide-react) as one sprite
// that design turns copy into system/. Re-run after a lucide-react upgrade: node scripts/build-icon-sprite.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const icons = join(root, "node_modules", "lucide-react", "dist", "esm", "icons");

// Everyday product UI. Left out on purpose: sparkles, rocket, wand and the like, the stock "AI magic" icons.
const NAMES = `search x menu chevron-down chevron-up chevron-left chevron-right arrow-left arrow-right arrow-up arrow-down
arrow-up-right check plus minus settings user users user-plus bell house calendar calendar-days clock map-pin map navigation
phone mail message-circle send heart star bookmark share-2 download upload filter sliders-horizontal ellipsis
ellipsis-vertical pencil trash-2 copy external-link link lock lock-open eye eye-off info triangle-alert circle-alert
circle-check circle-x circle-help refresh-cw rotate-ccw play pause skip-forward skip-back volume-2 volume-x camera image
file file-text folder paperclip shopping-cart shopping-bag credit-card wallet tag gift truck package store chart-column
chart-line chart-pie trending-up trending-down activity zap sun moon cloud globe layout-dashboard layout-grid list
columns-3 table square-kanban log-in log-out shield key wifi battery smartphone laptop monitor code terminal git-branch
database server book-open graduation-cap briefcase building-2 car plane utensils coffee dumbbell music headphones mic
video ticket qr-code scan-line thumbs-up smile flag award trophy lightbulb grip-vertical move maximize-2 minimize-2
printer receipt banknote percent hash at-sign inbox archive history timer hourglass leaf droplets thermometer bed bath`
  .split(/\s+/)
  .filter(Boolean);

const STROKE = `fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`;
const esc = (v) => String(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const symbols = [];
for (const name of NAMES) {
  // A renamed icon's old name is an alias module that re-exports the new one: follow it, keep the familiar id.
  let file = join(icons, `${name}.mjs`);
  const alias = /from '\.\/([a-z0-9-]+)\.mjs'/.exec(readFileSync(file, "utf8").split("createLucideIcon").length > 1 ? "" : readFileSync(file, "utf8"));
  if (alias) file = join(icons, `${alias[1]}.mjs`);
  const { __iconData } = await import(pathToFileURL(file).href);
  const body = __iconData.node
    .map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).filter(([k]) => k !== "key").map(([k, v]) => `${k}="${esc(v)}"`).join(" ")}/>`)
    .join("");
  // The stroke attributes go on each symbol: a <use> clone inherits from the symbol, not from this sprite's root.
  symbols.push(`<symbol id="${name}" viewBox="0 0 24 24" ${STROKE}>${body}</symbol>`);
}
const version = JSON.parse(readFileSync(join(root, "node_modules", "lucide-react", "package.json"), "utf8")).version;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" style="display:none">
<!-- ${NAMES.length} line icons from Lucide ${version} (ISC licence, see LICENSE). 24×24, stroke follows currentColor.
Use: copy the <symbol>s a page needs into one hidden <svg style="display:none"> at the top of its <body>, then draw one with <svg width="20" height="20" aria-hidden="true"><use href="#search"/></svg>.
Ids: ${NAMES.join(", ")} -->
${symbols.join("\n")}
</svg>
`;
writeFileSync(join(root, "resources", "design-icons", "icons.svg"), svg);
console.log(`${NAMES.length} icons, ${svg.length} bytes`);
