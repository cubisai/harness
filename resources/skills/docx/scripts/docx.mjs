#!/usr/bin/env node
// Markdown -> .docx with one opinionated, already-correct layout.
// Usage:
//   node docx.mjs init <draft.md>
//   node docx.mjs build <input.md> <output.docx>
//   node docx.mjs check <file.docx>

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
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

const PINNED = { docx: "9.11.0", mammoth: "1.13.0" };

const PAPER = {
  a4: { width: 11906, height: 16838 },
  letter: { width: 12240, height: 15840 },
};
const THEMES = { clean: "2F5597", navy: "1F3864", warm: "8A4B2A" };
const MARGIN = 1440;

const MOJIBAKE = ["â€", "â†", "Ã", "Â ", "\uFFFD"];
const PLACEHOLDERS = [/\bTODO\b/i, /\bTBD\b/i, /\blorem\b/i, /\bipsum\b/i, /\[insert/i, /\bXXX\b/i];

function usage() {
  console.error(`Usage:
  node docx.mjs init <draft.md>
  node docx.mjs build <input.md> <output.docx>
  node docx.mjs check <file.docx>`);
  process.exit(2);
}

function snippet(text, index) {
  return text.slice(Math.max(0, index - 20), index + 30).replace(/\s+/g, " ").trim();
}

function lineAt(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}

function findTextProblem(text) {
  let best = null;
  for (const bad of MOJIBAKE) {
    const at = text.indexOf(bad);
    if (at >= 0 && (!best || at < best.index)) {
      best = { index: at, message: `the text contains broken characters ("${bad}"); save the file as UTF-8 and retype that word` };
    }
  }
  for (const re of PLACEHOLDERS) {
    const m = re.exec(text);
    if (m && (!best || m.index < best.index)) {
      best = { index: m.index, message: `the text still has the placeholder "${m[0]}"; replace it with real content` };
    }
  }
  if (best) best.message += ` (near: "${snippet(text, best.index)}")`;
  return best;
}

function readTextFile(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    fail(`can't read ${file}; check the path`);
  }
}

function writeFile(file, data) {
  try {
    writeFileSync(file, data);
  } catch {
    fail(`can't write ${file}; check that the folder exists`);
  }
}

function tint(hex, whiteRatio) {
  const value = parseInt(hex, 16);
  const mix = (channel) => Math.round(channel + (255 - channel) * whiteRatio);
  return [mix((value >> 16) & 255), mix((value >> 8) & 255), mix(value & 255)]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

function plainLength(text) {
  return text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*`]/g, "").length;
}

function splitRow(line) {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);
  const cells = [];
  let current = "";
  for (let k = 0; k < text.length; k++) {
    if (text[k] === "\\" && text[k + 1] === "|") {
      current += "|";
      k++;
      continue;
    }
    if (text[k] === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += text[k];
  }
  cells.push(current.trim());
  return cells;
}

function separatorAligns(line) {
  const text = line.trim();
  if (!text.startsWith("|")) return null;
  const cells = splitRow(text);
  if (!cells.length) return null;
  for (const cell of cells) if (!/^:?-+:?$/.test(cell)) return null;
  return cells.map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    return right ? "right" : "left";
  });
}

function isBlockStart(lines, index) {
  const text = lines[index].trim();
  if (!text) return true;
  if (text.toLowerCase() === "<!-- pagebreak -->") return true;
  if (text === "---") return true;
  if (/^#{1,3}\s+/.test(text)) return true;
  if (/^>\s?/.test(text)) return true;
  if (/^([-*]|\d+[.)])\s+/.test(text)) return true;
  if (/^!\[[^\]]*\]\([^)]*\)\s*$/.test(text)) return true;
  if (text.startsWith("|") && index + 1 < lines.length && separatorAligns(lines[index + 1])) return true;
  return false;
}

function pngSize(buffer) {
  if (buffer.length < 24 || buffer[0] !== 0x89 || buffer.toString("ascii", 1, 4) !== "PNG") throw new Error("not a PNG");
  if (buffer.toString("ascii", 12, 16) !== "IHDR") throw new Error("no IHDR");
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function jpegSize(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) throw new Error("not a JPEG");
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xff) {
      offset++;
      continue;
    }
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = buffer.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  throw new Error("no size header");
}

function readImage(src, baseDir, line, textWidth) {
  const ext = extname(src).toLowerCase();
  let type;
  if (ext === ".png") type = "png";
  else if (ext === ".jpg" || ext === ".jpeg") type = "jpg";
  else fail(`line ${line}: images must be .png, .jpg or .jpeg files; "${src}" is not`);
  const file = resolve(baseDir, src);
  if (!existsSync(file)) fail(`line ${line}: image not found: ${src}`);
  const data = readFileSync(file);
  let size;
  try {
    size = type === "png" ? pngSize(data) : jpegSize(data);
  } catch {
    fail(`line ${line}: "${src}" is not a valid ${type.toUpperCase()} image`);
  }
  if (!size.width || !size.height) fail(`line ${line}: "${src}" has no usable pixel size`);
  const maxWidth = Math.round((textWidth / 1440) * 96);
  const width = Math.min(size.width, maxWidth);
  const height = Math.max(1, Math.round((width * size.height) / size.width));
  return { type, data, width, height };
}

function columnWidths(header, rows, total) {
  const columns = header.length;
  if (!columns) return [];
  if (columns * 0.12 > 1) {
    const widths = Array.from({ length: columns }, () => Math.floor(total / columns));
    widths[widths.length - 1] += total - widths.reduce((a, b) => a + b, 0);
    return widths;
  }
  const weights = header.map((_, column) => {
    let longest = 4;
    for (const row of [header, ...rows]) longest = Math.max(longest, plainLength(row[column] || ""));
    return longest;
  });
  const sum = weights.reduce((a, b) => a + b, 0);
  const shares = weights.map((weight) => weight / sum);
  const min = 0.12;
  for (let pass = 0; pass < columns; pass++) {
    const under = shares.map((share, i) => (share < min - 1e-9 ? i : -1)).filter((i) => i >= 0);
    if (!under.length) break;
    let deficit = 0;
    for (const i of under) {
      deficit += min - shares[i];
      shares[i] = min;
    }
    const over = shares.map((share, i) => (share > min + 1e-9 ? i : -1)).filter((i) => i >= 0);
    const overSum = over.reduce((a, i) => a + shares[i], 0);
    if (!overSum) break;
    for (const i of over) shares[i] -= deficit * (shares[i] / overSum);
  }
  const totalShare = shares.reduce((a, b) => a + b, 0) || 1;
  const widths = shares.map((share) => Math.round((share / totalShare) * total));
  widths[widths.length - 1] += total - widths.reduce((a, b) => a + b, 0);
  return widths;
}

function bulletDefinition(D) {
  return {
    reference: "bullets",
    levels: [0, 1, 2].map((level) => ({
      level,
      format: D.LevelFormat.BULLET,
      text: ["•", "◦", "▪"][level],
      alignment: D.AlignmentType.LEFT,
      style: {
        paragraph: { indent: { left: 720 + level * 360, hanging: 360 } },
        run: { font: "Calibri" },
      },
    })),
  };
}

function orderedDefinition(D, reference) {
  return {
    reference,
    levels: [0, 1, 2].map((level) => ({
      level,
      format: D.LevelFormat.DECIMAL,
      text: `%${level + 1}.`,
      start: 1,
      alignment: D.AlignmentType.LEFT,
      style: {
        paragraph: { indent: { left: 720 + level * 360, hanging: 360 } },
      },
    })),
  };
}

function parseMarkdown(source, D) {
  const lines = source.split(/\r?\n/);
  const blocks = [];
  const meta = { paper: "a4", theme: "clean" };
  const numbering = [bulletDefinition(D)];
  let orderedCount = 0;
  let firstH1 = null;
  let i = 0;

  if (lines.length && lines[0].trim() === "---") {
    let closed = false;
    i = 1;
    for (; i < lines.length; i++) {
      const text = lines[i].trim();
      if (text === "---") {
        i++;
        closed = true;
        break;
      }
      if (!text) continue;
      const match = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(text);
      if (!match) fail(`line ${i + 1}: front matter needs "key: value", but this line is "${text}"`);
      const key = match[1].toLowerCase();
      const value = match[2].trim().replace(/^["']|["']$/g, "");
      if (key === "title") meta.title = value;
      else if (key === "header") meta.header = value;
      else if (key === "paper") {
        const paper = value.toLowerCase();
        if (paper !== "a4" && paper !== "letter") fail(`line ${i + 1}: paper must be A4 or Letter, not "${value}"`);
        meta.paper = paper;
      } else if (key === "theme") {
        const theme = value.toLowerCase();
        if (!(theme in THEMES)) fail(`line ${i + 1}: unknown theme "${value}"; use clean, navy or warm`);
        meta.theme = theme;
      } else {
        fail(`line ${i + 1}: unknown front matter key "${match[1]}"; use title, paper, theme or header`);
      }
    }
    if (!closed) fail("front matter is not closed; add a --- line after it");
  }

  while (i < lines.length) {
    const raw = lines[i];
    const text = raw.trim();
    if (!text) {
      i++;
      continue;
    }

    if (text.toLowerCase() === "<!-- pagebreak -->") {
      blocks.push({ type: "pagebreak", line: i + 1 });
      i++;
      continue;
    }

    if (text === "---") {
      blocks.push({ type: "rule", line: i + 1 });
      i++;
      continue;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(text);
    if (heading) {
      const level = heading[1].length;
      if (level === 1 && firstH1 === null) firstH1 = heading[2].trim();
      blocks.push({ type: "heading", level, text: heading[2].trim(), line: i + 1 });
      i++;
      continue;
    }

    if (text.startsWith("|") && i + 1 < lines.length && separatorAligns(lines[i + 1])) {
      const startLine = i + 1;
      const header = splitRow(lines[i]);
      const aligns = separatorAligns(lines[i + 1]);
      if (aligns.length !== header.length) {
        fail(`line ${i + 2}: the table separator has ${aligns.length} columns but the header has ${header.length}; make both match`);
      }
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        if (separatorAligns(lines[i])) fail(`line ${i + 1}: this table has a second "|---|---|" separator row; remove it`);
        const cells = splitRow(lines[i]);
        if (cells.length !== header.length) {
          fail(`line ${i + 1}: this table row has ${cells.length} cells but the header has ${header.length}; give every row ${header.length} cells`);
        }
        rows.push({ cells, line: i + 1 });
        i++;
      }
      blocks.push({ type: "table", header, aligns, rows, line: startLine });
      continue;
    }

    if (/^>\s?/.test(text)) {
      const start = i;
      const parts = [];
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        parts.push(lines[i].trim().replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({ type: "callout", text: parts.filter(Boolean).join(" "), line: start + 1 });
      continue;
    }

    const listItem = /^([ \t]*)([-*]|\d+[.)])\s+(.*)$/.exec(raw);
    if (listItem) {
      const start = i;
      const items = [];
      while (i < lines.length) {
        const match = /^([ \t]*)([-*]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (!match) break;
        const indent = match[1].replace(/\t/g, "  ").length;
        items.push({
          level: Math.min(Math.floor(indent / 2), 2),
          ordered: /^\d/.test(match[2]),
          text: match[3],
          line: i + 1,
        });
        i++;
      }
      let reference = null;
      for (const item of items) {
        if (item.ordered && !reference) {
          reference = `ordered-${++orderedCount}`;
          numbering.push(orderedDefinition(D, reference));
        }
        item.reference = item.ordered ? reference : "bullets";
      }
      blocks.push({ type: "list", items, line: start + 1 });
      continue;
    }

    const image = /^!\[([^\]]*)\]\(([^)\s]+)\)\s*$/.exec(text);
    if (image) {
      blocks.push({ type: "image", alt: image[1], src: image[2], line: i + 1 });
      i++;
      continue;
    }

    const start = i;
    const parts = [];
    while (i < lines.length) {
      const current = lines[i].trim();
      if (!current) break;
      if (i > start && isBlockStart(lines, i)) break;
      parts.push(current);
      i++;
    }
    blocks.push({ type: "paragraph", text: parts.join(" "), line: start + 1 });
  }

  return { meta, blocks, numbering, firstH1 };
}

function inline(text, D, accent, options = {}) {
  const runs = [];
  const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let match;
  while ((match = pattern.exec(text))) {
    if (match.index > last) {
      runs.push(new D.TextRun({ text: text.slice(last, match.index), bold: options.bold || undefined }));
    }
    const token = match[0];
    if (token.startsWith("**")) {
      runs.push(new D.TextRun({ text: token.slice(2, -2), bold: true }));
    } else if (token.startsWith("`")) {
      runs.push(new D.TextRun({ text: token.slice(1, -1), font: "Consolas", size: 20, bold: options.bold || undefined }));
    } else if (token.startsWith("[")) {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      runs.push(new D.ExternalHyperlink({
        link: link[2],
        children: [new D.TextRun({
          text: link[1],
          color: accent,
          underline: { type: D.UnderlineType.SINGLE },
          bold: options.bold || undefined,
        })],
      }));
    } else {
      runs.push(new D.TextRun({ text: token.slice(1, -1), italics: true, bold: options.bold || undefined }));
    }
    last = match.index + token.length;
  }
  if (last < text.length) {
    runs.push(new D.TextRun({ text: text.slice(last), bold: options.bold || undefined }));
  }
  if (!runs.length) runs.push(new D.TextRun({ text: "" }));
  return runs;
}

function render(parsed, D, inputDir) {
  const accent = THEMES[parsed.meta.theme];
  const page = PAPER[parsed.meta.paper];
  const textWidth = page.width - MARGIN * 2;
  const children = [];
  let titleUsed = false;

  for (const block of parsed.blocks) {
    if (block.type === "heading") {
      let heading;
      if (block.level === 1) {
        if (!titleUsed) {
          titleUsed = true;
          heading = D.HeadingLevel.TITLE;
        } else {
          heading = D.HeadingLevel.HEADING_1;
        }
      } else {
        heading = block.level === 2 ? D.HeadingLevel.HEADING_2 : D.HeadingLevel.HEADING_3;
      }
      children.push(new D.Paragraph({ heading, children: inline(block.text, D, accent) }));
      continue;
    }

    if (block.type === "paragraph") {
      children.push(new D.Paragraph({ children: inline(block.text, D, accent) }));
      continue;
    }

    if (block.type === "list") {
      for (const item of block.items) {
        children.push(new D.Paragraph({
          children: inline(item.text, D, accent),
          numbering: { reference: item.reference, level: item.level },
          spacing: { after: 60, line: 276 },
        }));
      }
      continue;
    }

    if (block.type === "table") {
      const widths = columnWidths(block.header, block.rows.map((row) => row.cells), textWidth);
      const border = { style: D.BorderStyle.SINGLE, size: 4, color: "BFBFBF" };
      const cell = (value, column, header) => new D.TableCell({
        width: { size: widths[column], type: D.WidthType.DXA },
        shading: header ? { type: D.ShadingType.CLEAR, fill: tint(accent, 0.86), color: "auto" } : undefined,
        children: [new D.Paragraph({
          children: inline(value, D, accent, { bold: header }),
          alignment: block.aligns[column] === "center"
            ? D.AlignmentType.CENTER
            : block.aligns[column] === "right" ? D.AlignmentType.RIGHT : D.AlignmentType.LEFT,
          spacing: { after: 0, line: 264 },
        })],
      });
      const rows = [
        new D.TableRow({
          tableHeader: true,
          children: block.header.map((value, column) => cell(value, column, true)),
        }),
        ...block.rows.map((row) => new D.TableRow({
          children: row.cells.map((value, column) => cell(value, column, false)),
        })),
      ];
      children.push(new D.Table({
        rows,
        width: { size: textWidth, type: D.WidthType.DXA },
        columnWidths: widths,
        layout: D.TableLayoutType.FIXED,
        borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border },
        margins: { top: 80, bottom: 80, left: 120, right: 120 },
      }));
      continue;
    }

    if (block.type === "callout") {
      children.push(new D.Paragraph({
        children: inline(block.text, D, accent),
        shading: { type: D.ShadingType.CLEAR, fill: tint(accent, 0.93), color: "auto" },
        border: { left: { style: D.BorderStyle.SINGLE, size: 18, color: accent, space: 8 } },
        indent: { left: 240 },
        spacing: { before: 120, after: 180, line: 276 },
      }));
      continue;
    }

    if (block.type === "rule") {
      children.push(new D.Paragraph({
        border: { bottom: { style: D.BorderStyle.SINGLE, size: 6, color: "C9C9C9", space: 1 } },
        spacing: { before: 120, after: 180 },
      }));
      continue;
    }

    if (block.type === "pagebreak") {
      children.push(new D.Paragraph({ children: [new D.PageBreak()], spacing: { before: 0, after: 0 } }));
      continue;
    }

    if (block.type === "image") {
      const image = readImage(block.src, inputDir, block.line, textWidth);
      children.push(new D.Paragraph({
        alignment: D.AlignmentType.CENTER,
        spacing: { before: 120, after: 200 },
        children: [new D.ImageRun({
          type: image.type,
          data: image.data,
          transformation: { width: image.width, height: image.height },
          altText: { name: block.alt || "image", description: block.alt || "" },
        })],
      }));
    }
  }

  const title = parsed.meta.title || (parsed.firstH1 && parsed.firstH1.replace(/[*`]/g, "")) || "Document";
  const styles = {
    default: {
      document: {
        run: { font: "Calibri", size: 22, color: "1B1B1B" },
        paragraph: { spacing: { line: 276, lineRule: D.LineRuleType.AUTO, after: 120 } },
      },
      title: {
        run: { font: "Calibri", size: 48, bold: true, color: accent },
        paragraph: { spacing: { before: 0, after: 240 }, keepNext: true },
      },
      heading1: {
        run: { font: "Calibri", size: 32, bold: true, color: accent },
        paragraph: { spacing: { before: 320, after: 140 }, keepNext: true },
      },
      heading2: {
        run: { font: "Calibri", size: 28, bold: true, color: accent },
        paragraph: { spacing: { before: 260, after: 100 }, keepNext: true },
      },
      heading3: {
        run: { font: "Calibri", size: 24, bold: true, color: accent },
        paragraph: { spacing: { before: 220, after: 80 }, keepNext: true },
      },
      hyperlink: { run: { color: accent, underline: { type: D.UnderlineType.SINGLE } } },
    },
  };

  return new D.Document({
    title,
    styles,
    numbering: { config: parsed.numbering },
    sections: [{
      properties: {
        page: {
          size: { width: page.width, height: page.height },
          margin: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN, header: 720, footer: 720 },
        },
      },
      headers: parsed.meta.header
        ? {
          default: new D.Header({
            children: [new D.Paragraph({
              alignment: D.AlignmentType.RIGHT,
              spacing: { after: 0 },
              children: [new D.TextRun({ text: parsed.meta.header, size: 18, color: "6B6B6B" })],
            })],
          }),
        }
        : undefined,
      footers: {
        default: new D.Footer({
          children: [new D.Paragraph({
            alignment: D.AlignmentType.CENTER,
            spacing: { before: 0, after: 0 },
            children: [new D.TextRun({
              children: ["Page ", D.PageNumber.CURRENT, " of ", D.PageNumber.TOTAL_PAGES],
              size: 18,
              color: "6B6B6B",
            })],
          })],
        }),
      },
      children,
    }],
  });
}

async function checkFile(file, mammoth) {
  if (!existsSync(file)) fail(`file not found: ${file}`);
  let raw;
  try {
    raw = await mammoth.extractRawText({ path: file });
  } catch {
    fail(`${basename(file)} is not a valid .docx; build one with "build" first`);
  }
  const text = String(raw.value || "");
  if (!text.trim()) fail(`${basename(file)} has no text; the document body is empty`);
  const problem = findTextProblem(text);
  if (problem) fail(`${basename(file)}: ${problem.message}`);
  let tables = 0;
  try {
    const html = await mammoth.convertToHtml({ path: file });
    tables = (String(html.value || "").match(/<table\b/g) || []).length;
  } catch {
    tables = 0;
  }
  const paragraphs = text.split(/\n{2,}/).filter((part) => part.trim()).length;
  console.log(`OK: ${basename(file)} — ${paragraphs} paragraphs, ${tables} tables`);
}

const SAMPLE = `---
title: Q3 Reliability Review
paper: A4
theme: clean
header: CubiQ — Internal
---

# Q3 Reliability Review

Reliability held at **99.95%** this quarter. We ran *twelve* incidents in total, and every one has a [public write-up](https://example.com/incidents).

## What changed

- Recovery is faster: median time to restore fell to 18 minutes.
- Alerts are clearer:
  - noisy alerts are down 40%
  - every page now names an owner
- Handovers are shorter.

## Next quarter

1. Run the failover drill in every region.
2. Add automated rollback for the checkout service.
3. Trim the on-call rotation to one week.

| Area | Owner | Status |
| :--- | :---: | ---: |
| Checkout | Payments | On track |
| Search | Platform | At risk |
| Billing | Finance | Done |

> **Decision:** ship the rollback tool before the next peak, even if the drill slips by a week.

---

<!-- pagebreak -->

## Appendix

The raw figures live in the warehouse table \`reliability_q3\`.
`;

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command) usage();

  if (command === "init") {
    if (args.length !== 1) usage();
    const target = args[0];
    writeFile(target, SAMPLE);
    console.log(`OK: wrote a sample Markdown draft to ${target}; edit its content, then run "build ${target} <output.docx>"`);
    return;
  }

  if (command === "build") {
    if (args.length !== 2) usage();
    const [input, output] = args;
    if (resolve(input) === resolve(output)) fail("the output path must be different from the input path");
    const source = readTextFile(input);
    const problem = findTextProblem(source);
    if (problem) fail(`line ${lineAt(source, problem.index)}: ${problem.message}`);
    const [docx, mammoth] = need("docx", "mammoth");
    const parsed = parseMarkdown(source, docx);
    if (!parsed.blocks.length) fail(`${basename(input)} is empty; add a heading and some text`);
    const document = render(parsed, docx, dirname(resolve(input)));
    const buffer = await docx.Packer.toBuffer(document);
    writeFile(output, buffer);
    await checkFile(output, mammoth);
    return;
  }

  if (command === "check") {
    if (args.length !== 1) usage();
    const [mammoth] = need("mammoth");
    await checkFile(args[0], mammoth);
    return;
  }

  usage();
}

await main();
