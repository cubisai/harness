#!/usr/bin/env node
// Builds a clean 16:9 deck from a JSON outline, so a model only writes content:
// every layout, font size, colour and bound is decided here, and the deck is
// checked (shapes on the slide, no empty slides, no garbled text) before OK.

import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const PINNED = { pptxgenjs: "4.0.1", jszip: "3.10.2" };
const TOOLS = process.env.CUBIQ_DOC_TOOLS || join(tmpdir(), "harness-doc-tools");
function fail(message) { console.error(`ERROR: ${message}`); process.exit(1); }
function need(...names) {
  const req = createRequire(join(TOOLS, "noop.js"));
  const missing = names.filter((n) => { try { req.resolve(n); return false; } catch { return true; } });
  if (missing.length) {
    mkdirSync(TOOLS, { recursive: true });
    const win = process.platform === "win32";
    const r = spawnSync(win ? "npm.cmd" : "npm", ["install", "--prefix", TOOLS, "--ignore-scripts", "--no-audit", "--no-fund", ...missing.map((n) => `${n}@${PINNED[n]}`)], { stdio: "inherit", shell: win });
    if (r.status !== 0) fail(`couldn't install ${missing.join(", ")} into ${TOOLS}; check the network and try again`);
  }
  return names.map((n) => req(n));
}

const USAGE = `usage: node deck.mjs init <deck.json> | build <deck.json> <out.pptx> | check <deck.pptx>`;
const W = 13.333, H = 7.5, M = 0.6;
const BODY = { x: M, y: 1.7, w: W - 2 * M, h: 6.9 - 1.7 };
const FONT = "Calibri";
const THEMES = {
  clean: { bg: "FFFFFF", text: "1B1B1B", accent: "2F5597", muted: "5B6573", series: ["2F5597", "7FA7D9", "C55A11", "70AD47", "8E7CC3"] },
  navy: { bg: "FFFFFF", text: "1B1B1B", accent: "1F3864", muted: "5B6573", series: ["1F3864", "5B7DB1", "BF9000", "A9D18E", "C9C9C9"] },
  warm: { bg: "FFF8F1", text: "2B2118", accent: "8A4B2A", muted: "6E5B4C", series: ["8A4B2A", "D4A373", "6B705C", "A5A58D", "CB997E"] },
  dark: { bg: "14171C", text: "F2F4F7", accent: "6EA8FE", muted: "A7B0BE", series: ["6EA8FE", "F4A261", "8BD3A0", "C9A7F5", "E9C46A"] },
};
const LAYOUTS = ["title", "section", "bullets", "two-column", "chart", "image", "quote"];
const MOJIBAKE = /â€|â†|Ã|Â |�/;
const PLACEHOLDER = /\b(TODO|TBD|lorem|ipsum|XXX)\b|\[insert/i;

/** The first garbled or placeholder snippet in `text`, or null. */
function badText(text) {
  for (const re of [MOJIBAKE, PLACEHOLDER]) {
    const m = re.exec(text);
    if (m) return text.slice(Math.max(0, m.index - 20), m.index + 30).replace(/\s+/g, " ");
  }
  return null;
}

/** Pixel width and height of a PNG or JPEG, from its header; null for anything else. */
function imageSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
      i += 2 + len;
    }
  }
  return null;
}

/** The largest body font size (22 down to 16) whose estimated lines fit `boxH` inches; null when even 16 doesn't. */
function fitSize(lines, boxW, boxH, gapLines = 0.3) {
  for (let size = 22; size >= 16; size--) {
    const perLine = Math.max(8, Math.floor((boxW * 72) / (size * 0.5)));
    const count = lines.reduce((n, l) => n + Math.max(1, Math.ceil(l.length / perLine)) + gapLines, 0);
    if ((count * size * 1.25) / 72 <= boxH) return size;
  }
  return null;
}

const strings = (v) => Array.isArray(v) && v.every((s) => typeof s === "string");

/** Every problem in the outline, as "slide N: ..." lines. */
function validate(deck, base) {
  const errs = [];
  if (!deck || typeof deck !== "object" || !Array.isArray(deck.slides) || !deck.slides.length) return ["the JSON needs a non-empty \"slides\" array"];
  if (deck.theme !== undefined && !THEMES[deck.theme]) errs.push(`unknown theme "${deck.theme}": use ${Object.keys(THEMES).join(", ")}`);
  deck.slides.forEach((s, i) => {
    const at = `slide ${i + 1}`;
    if (!s || typeof s !== "object") return errs.push(`${at}: not an object`);
    if (!LAYOUTS.includes(s.layout)) return errs.push(`${at}: unknown layout "${s.layout}": use ${LAYOUTS.join(", ")}`);
    const req = (f) => { if (typeof s[f] !== "string" || !s[f].trim()) errs.push(`${at}: "${f}" is required`); };
    if (s.layout !== "quote") req("title");
    if (s.layout === "bullets") {
      if (!strings(s.bullets) || !s.bullets.length) errs.push(`${at}: "bullets" must be a list of 1 to 6 strings`);
      else if (s.bullets.length > 6) errs.push(`${at}: ${s.bullets.length} bullets; at most 6, split it into two slides`);
      else s.bullets.forEach((b, j) => { if (b.length > 160) errs.push(`${at}: bullet ${j + 1} is ${b.length} characters; shorten it to 160 or less`); });
    }
    if (s.layout === "two-column") {
      for (const side of ["left", "right"]) {
        if (!strings(s[side]) || !s[side].length) errs.push(`${at}: "${side}" must be a list of strings`);
        else if (s[side].length > 6) errs.push(`${at}: "${side}" has ${s[side].length} items; at most 6, split the slide`);
      }
    }
    if (s.layout === "chart") {
      const c = s.chart;
      if (!c || !["bar", "line", "pie"].includes(c.type)) errs.push(`${at}: "chart.type" must be bar, line or pie`);
      else if (!strings(c.labels) || !c.labels.length) errs.push(`${at}: "chart.labels" must be a list of strings`);
      else if (!Array.isArray(c.series) || !c.series.length) errs.push(`${at}: "chart.series" must be a list of { name, values }`);
      else {
        if (c.type === "pie" && c.series.length > 1) errs.push(`${at}: a pie chart takes one series`);
        c.series.forEach((ser, j) => {
          if (!Array.isArray(ser.values) || !ser.values.every((v) => typeof v === "number" && Number.isFinite(v))) errs.push(`${at}: series ${j + 1} values must all be numbers`);
          else if (ser.values.length !== c.labels.length) errs.push(`${at}: series ${j + 1} has ${ser.values.length} values but there are ${c.labels.length} labels`);
        });
      }
    }
    if (s.layout === "image") {
      if (typeof s.image !== "string") errs.push(`${at}: "image" (a png or jpg path) is required`);
      else {
        const p = resolve(base, s.image);
        if (!existsSync(p)) errs.push(`${at}: image file not found: ${s.image}`);
        else if (!imageSize(readFileSync(p))) errs.push(`${at}: ${s.image} isn't a PNG or JPEG`);
      }
    }
    if (s.layout === "quote") req("quote");
    const text = [s.title, s.subtitle, s.quote, s.by, s.caption, s.notes, s.leftTitle, s.rightTitle, ...(s.bullets ?? []), ...(s.left ?? []), ...(s.right ?? [])].filter((t) => typeof t === "string").join("\n");
    const bad = badText(text);
    if (bad) errs.push(`${at}: garbled or placeholder text: "${bad}"`);
  });
  return errs;
}

function build(inPath, outPath) {
  if (resolve(inPath) === resolve(outPath)) fail("the output path is the input; pick another name");
  if (!outPath.toLowerCase().endsWith(".pptx")) fail("the output must end in .pptx");
  let deck;
  try { deck = JSON.parse(readFileSync(inPath, "utf8")); } catch (e) { fail(`${inPath} isn't valid JSON: ${e.message}`); }
  const base = dirname(resolve(inPath));
  const errs = validate(deck, base);
  if (errs.length) { for (const e of errs) console.error(`ERROR: ${e}`); process.exit(1); }
  const [mod] = need("pptxgenjs");
  const Pptx = mod.default ?? mod;
  const pptx = new Pptx();
  pptx.layout = "LAYOUT_WIDE";
  const t = THEMES[deck.theme ?? "clean"];
  if (typeof deck.title === "string") pptx.title = deck.title;
  const text = (slide, value, opts) => slide.addText(value, { fontFace: FONT, color: t.text, margin: 0, valign: "top", ...opts });
  const titleOf = (slide, title) => {
    text(slide, title, { x: M, y: 0.5, w: W - 2 * M, h: 1.0, fontSize: 32, bold: true, color: t.text, valign: "middle", fit: "none" });
    slide.addShape(pptx.ShapeType.rect, { x: M, y: 1.45, w: 0.9, h: 0.06, fill: { color: t.accent }, line: { color: t.accent } });
  };
  const bulletBox = (slide, items, box, at) => {
    const size = fitSize(items, box.w, box.h);
    if (!size) fail(`too much text on ${at}: cut bullets or split the slide`);
    text(slide, items.map((b) => ({ text: b, options: { bullet: { indent: 18 }, breakLine: true, paraSpaceAfter: 8 } })), { ...box, fontSize: size });
  };
  deck.slides.forEach((s, i) => {
    const at = `slide ${i + 1}`;
    const slide = pptx.addSlide();
    slide.background = { color: t.bg };
    if (s.layout !== "title") slide.slideNumber = { x: W - M - 0.6, y: H - 0.45, w: 0.6, h: 0.3, fontFace: FONT, fontSize: 10, color: t.muted, align: "right" };
    if (s.layout === "title") {
      slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.18, h: H, fill: { color: t.accent }, line: { color: t.accent } });
      text(slide, s.title, { x: 1.0, y: 2.3, w: W - 2.0, h: 1.6, fontSize: 40, bold: true, valign: "bottom" });
      if (s.subtitle) text(slide, s.subtitle, { x: 1.0, y: 4.1, w: W - 2.0, h: 1.0, fontSize: 22, color: t.muted });
    } else if (s.layout === "section") {
      text(slide, s.title, { x: M, y: 2.8, w: W - 2 * M, h: 1.4, fontSize: 36, bold: true, color: t.accent, valign: "middle" });
    } else if (s.layout === "bullets") {
      titleOf(slide, s.title);
      bulletBox(slide, s.bullets, BODY, at);
    } else if (s.layout === "two-column") {
      titleOf(slide, s.title);
      const colW = (BODY.w - 0.5) / 2;
      [["left", s.leftTitle, BODY.x], ["right", s.rightTitle, BODY.x + colW + 0.5]].forEach(([side, head, x]) => {
        let y = BODY.y;
        if (head) {
          text(slide, head, { x, y, w: colW, h: 0.5, fontSize: 20, bold: true, color: t.accent });
          y += 0.6;
        }
        bulletBox(slide, s[side], { x, y, w: colW, h: BODY.y + BODY.h - y }, at);
      });
    } else if (s.layout === "chart") {
      titleOf(slide, s.title);
      const type = { bar: pptx.ChartType.bar, line: pptx.ChartType.line, pie: pptx.ChartType.pie }[s.chart.type];
      const data = s.chart.series.map((ser) => ({ name: ser.name ?? "Series", labels: s.chart.labels, values: ser.values }));
      slide.addChart(type, data, {
        ...BODY, chartColors: s.chart.type === "pie" ? t.series.concat(t.series).slice(0, s.chart.labels.length) : t.series.slice(0, data.length),
        showLegend: data.length > 1 || s.chart.type === "pie", legendPos: "b", legendFontFace: FONT, legendFontSize: 14, legendColor: t.text,
        catAxisLabelColor: t.text, valAxisLabelColor: t.muted, catAxisLabelFontFace: FONT, valAxisLabelFontFace: FONT, catAxisLabelFontSize: 14, valAxisLabelFontSize: 12,
        valGridLine: { color: t.bg === "14171C" ? "2A2F37" : "E3E7ED", size: 0.5 }, ...(s.chart.type === "pie" ? { showPercent: true, dataLabelColor: "FFFFFF" } : {}),
      });
    } else if (s.layout === "image") {
      titleOf(slide, s.title);
      const p = resolve(base, s.image);
      const px = imageSize(readFileSync(p));
      const boxH = BODY.h - (s.caption ? 0.6 : 0);
      const scale = Math.min(BODY.w / px.w, boxH / px.h);
      const w = px.w * scale, h = px.h * scale;
      slide.addImage({ path: p, x: BODY.x + (BODY.w - w) / 2, y: BODY.y + (boxH - h) / 2, w, h });
      if (s.caption) text(slide, s.caption, { x: BODY.x, y: BODY.y + boxH + 0.1, w: BODY.w, h: 0.45, fontSize: 14, color: t.muted, align: "center" });
    } else if (s.layout === "quote") {
      const size = fitSize([s.quote], W - 3, 3.4) ?? fail(`too much text on ${at}: shorten the quote`);
      text(slide, `“${s.quote.replace(/^["“]|["”]$/g, "")}”`, { x: 1.5, y: 1.6, w: W - 3, h: 3.6, fontSize: Math.min(32, size + 8), italic: true, valign: "middle" });
      if (s.by) text(slide, `— ${s.by}`, { x: 1.5, y: 5.4, w: W - 3, h: 0.6, fontSize: 18, color: t.muted });
    }
    if (typeof s.notes === "string" && s.notes.trim()) slide.addNotes(s.notes);
  });
  return pptx.writeFile({ fileName: outPath }).then(() => check(outPath));
}

async function check(path) {
  if (!existsSync(path)) fail(`${path} not found`);
  const [JSZip] = need("jszip");
  let zip;
  try { zip = await JSZip.loadAsync(readFileSync(path)); } catch { fail(`${path} is not a valid .pptx`); }
  const names = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  if (!names.length) fail(`${path} has no slides`);
  const errs = [];
  for (const [i, name] of names.entries()) {
    const xml = await zip.file(name).async("string");
    const at = `slide ${i + 1}`;
    const offs = [...xml.matchAll(/<a:off x="(-?\d+)" y="(-?\d+)"\/>\s*<a:ext cx="(\d+)" cy="(\d+)"\/>/g)];
    if (offs.some(([, x, y, cx, cy]) => +x < 0 || +y < 0 || +x + +cx > 12192000 + 9144 || +y + +cy > 6858000 + 9144)) errs.push(`${at}: a shape is outside the slide`);
    const words = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join(" ");
    if (!words.trim() && !/<p:pic>|<p:graphicFrame>/.test(xml)) errs.push(`${at} is empty`);
    const bad = badText(words.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
    if (bad) errs.push(`${at}: garbled or placeholder text: "${bad}"`);
    const colour = [...xml.matchAll(/srgbClr val="([^"]*)"/g)].find((m) => !/^[0-9A-Fa-f]{6}$/.test(m[1]));
    if (colour) errs.push(`${at}: colour "${colour[1]}" isn't 6 hex digits`);
  }
  if (errs.length) { for (const e of errs) console.error(`ERROR: ${e}`); process.exit(1); }
  console.log(`OK: ${path} — ${names.length} slides`);
}

const SAMPLE_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAEElEQVR4nGPQD50ORww4OQD99Q1F72gZ4wAAAABJRU5ErkJggg==";

function init(path) {
  if (existsSync(path)) fail(`${path} already exists; pick a new name`);
  const img = join(dirname(resolve(path)), "deck-image.png");
  if (!existsSync(img)) writeFileSync(img, Buffer.from(SAMPLE_PNG, "base64"));
  const sample = {
    title: "Checkout reliability",
    theme: "clean",
    slides: [
      { layout: "title", title: "Checkout reliability", subtitle: "Q3 review · Platform team" },
      { layout: "bullets", title: "Where we are", bullets: ["Uptime held at 99.95% this quarter", "Median time to restore fell to 18 minutes", "Two incidents traced to one config change"], notes: "Lead with the uptime number." },
      { layout: "chart", title: "Incidents by month", chart: { type: "bar", labels: ["Jul", "Aug", "Sep"], series: [{ name: "2025", values: [7, 5, 4] }, { name: "2026", values: [5, 4, 3] }] } },
      { layout: "two-column", title: "What changed", leftTitle: "Kept", left: ["Weekly failover drills", "One owner per alert"], rightTitle: "Dropped", right: ["Manual rollbacks", "Shared pager"] },
      { layout: "section", title: "Next quarter" },
      { layout: "image", title: "Target architecture", image: "deck-image.png", caption: "Replace this picture with your own diagram" },
      { layout: "quote", quote: "The rollback button is the best thing we shipped all year.", by: "On-call engineer" },
    ],
  };
  writeFileSync(path, `${JSON.stringify(sample, null, 2)}\n`, "utf8");
  console.log(`OK: wrote a sample deck outline to ${path}; edit its content, then run "build ${path} <output.pptx>"`);
}

const [cmd, a, b] = process.argv.slice(2);
if (cmd === "init" && a) init(a);
else if (cmd === "build" && a && b) await build(a, b);
else if (cmd === "check" && a) await check(a);
else { console.error(USAGE); process.exit(2); }
