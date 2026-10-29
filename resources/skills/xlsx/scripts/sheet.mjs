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

import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

const PINNED = { exceljs: "4.4.0" };
const [ExcelJS] = need("exceljs");

const USAGE = [
  "Usage:",
  "  node sheet.mjs init <sheet.json>",
  "  node sheet.mjs build <sheet.json> <book.xlsx>",
  "  node sheet.mjs check <book.xlsx>",
].join("\n");

const FORMATS = ["text", "integer", "decimal", "currency", "percent", "date"];
const NUM_FMTS = {
  text: "@",
  integer: "#,##0",
  decimal: "#,##0.00",
  currency: "$#,##0.00",
  percent: "0.0%",
  date: "yyyy-mm-dd",
};
const FUNCTIONS = [
  "SUM", "AVERAGE", "MIN", "MAX", "COUNT", "COUNTA", "ROUND", "ABS",
  "IF", "AND", "OR", "NOT", "IFERROR", "CONCAT", "CONCATENATE",
];
const FUNC_LIST = FUNCTIONS.join(", ");
const ERROR_CODES = new Set(["#DIV/0!", "#REF!", "#NAME?", "#VALUE!", "#N/A", "#NUM!", "#NULL!"]);
const MOJIBAKE = ["â€", "â†", "Ã", "Â ", "�"];
const PLACEHOLDERS = [/TODO/i, /TBD/i, /lorem/i, /ipsum/i, /\[insert/i, /XXX/i];

const SAMPLE_INPUT = {
  sheets: [
    {
      name: "Budget",
      freeze: true,
      filter: true,
      columns: [
        { header: "Category", format: "text", width: 20 },
        { header: "Planned", format: "currency" },
        { header: "Actual", format: "currency" },
        { header: "Variance %", format: "percent" },
        { header: "Due date", format: "date" },
        { header: "Items", format: "integer" },
        { header: "Daily avg", format: "decimal" },
        { header: "Fixed" },
      ],
      rows: [
        ["Rent", 1200, 1250, "=IF(B2=0,0,ROUND((C2-B2)/B2,3))", "2026-01-15", 4, "=ROUND(C2/30,2)", true],
        ["Groceries", 450, 410, "=IF(B3=0,0,ROUND((C3-B3)/B3,3))", "2026-01-10", 12, "=ROUND(C3/30,2)", false],
        ["Transport", 120, 95, "=IF(B4=0,0,ROUND((C4-B4)/B4,3))", "2026-01-20", 6, "=ROUND(C4/30,2)", false],
        ["Internet", 60, 60, "=IF(B5=0,0,ROUND((C5-B5)/B5,3))", "2026-01-05", 1, "=ROUND(C5/30,2)", true],
        ["Total", "=SUM(B2:B5)", "=SUM(C2:C5)", "=IF(B6=0,0,ROUND((C6-B6)/B6,3))", "2026-01-31", "=SUM(F2:F5)", "=ROUND(C6/30,2)", null],
      ],
    },
    {
      name: "Summary",
      freeze: false,
      filter: false,
      columns: [
        { header: "Measure", format: "text", width: 22 },
        { header: "Value", format: "decimal" },
        { header: "Answer", format: "text" },
      ],
      rows: [
        ["Total planned", "=Budget!B6", null],
        ["Total actual", "=Budget!C6", null],
        ["Variance", "=ROUND((Budget!C6-Budget!B6)/Budget!B6,3)", null],
        ["Over budget?", null, "=IF(Budget!C6>Budget!B6,\"Yes\",\"No\")"],
        ["Categories", "=COUNTA(Budget!A2:A5)", null],
      ],
    },
  ],
};

function usage() {
  console.error(USAGE);
  process.exit(2);
}

function samePath(a, b) {
  const ra = resolve(a);
  const rb = resolve(b);
  return process.platform === "win32" ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

function colLetters(n) {
  let out = "";
  let value = n;
  while (value > 0) {
    const rem = (value - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    value = Math.floor((value - 1) / 26);
  }
  return out;
}

function colNumber(letters) {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function cellAddress(col, row) {
  return `${colLetters(col)}${row}`;
}

function parseISODate(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== mo - 1 ||
    date.getUTCDate() !== d
  ) {
    return null;
  }
  return date;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function textProblem(text) {
  for (const marker of MOJIBAKE) {
    if (text.includes(marker)) return { kind: "mojibake", snippet: marker };
  }
  for (const re of PLACEHOLDERS) {
    const hit = text.match(re);
    if (hit) return { kind: "placeholder", snippet: hit[0] };
  }
  return null;
}

function textMessage(where, problem) {
  if (problem.kind === "mojibake") {
    return `${where} has mojibake ${JSON.stringify(problem.snippet)} — save the input as UTF-8`;
  }
  return `${where} still has placeholder ${JSON.stringify(problem.snippet)} — replace it with real content`;
}

const ERR = (code) => ({ __error: code });
const isErr = (value) => !!(value && typeof value === "object" && typeof value.__error === "string");
const isRange = (value) => !!(value && typeof value === "object" && value.__range === true);

class FormulaError extends Error {
  constructor(message, where) {
    super(message);
    this.name = "FormulaError";
    this.where = where;
  }
}

function readRef(text, start) {
  const m = /^(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})/.exec(text.slice(start));
  if (!m) return null;
  const col = colNumber(m[2]);
  const row = Number(m[4]);
  if (col < 1 || col > 16384 || row < 1 || row > 1048576) return null;
  return { cell: { col, row }, next: start + m[0].length };
}

function skipSpace(text, i) {
  let at = i;
  while (at < text.length && /\s/.test(text[at])) at += 1;
  return at;
}

function tokenize(text) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    if (c === '"') {
      i += 1;
      let value = "";
      let closed = false;
      while (i < text.length) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            value += '"';
            i += 2;
            continue;
          }
          i += 1;
          closed = true;
          break;
        }
        value += text[i];
        i += 1;
      }
      if (!closed) throw new FormulaError(`bad formula "${text}" — close the text with a second "`);
      tokens.push({ type: "str", value });
      continue;
    }
    if (c === "'") {
      i += 1;
      let name = "";
      let closed = false;
      while (i < text.length) {
        if (text[i] === "'") {
          if (text[i + 1] === "'") {
            name += "'";
            i += 2;
            continue;
          }
          i += 1;
          closed = true;
          break;
        }
        name += text[i];
        i += 1;
      }
      if (!closed) throw new FormulaError(`bad formula "${text}" — close the sheet name with a second '`);
      i = skipSpace(text, i);
      if (text[i] !== "!") throw new FormulaError(`bad formula "${text}" — a quoted sheet name must be followed by !`);
      i = skipSpace(text, i + 1);
      const ref = readRef(text, i);
      if (!ref) throw new FormulaError(`bad formula "${text}" — expected a cell like A1 after ${name}!`);
      tokens.push({ type: "ref", sheet: name, col: ref.cell.col, row: ref.cell.row });
      i = ref.next;
      continue;
    }
    if ((c >= "0" && c <= "9") || (c === "." && text[i + 1] >= "0" && text[i + 1] <= "9")) {
      const m = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(text.slice(i));
      tokens.push({ type: "num", value: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const start = i;
      while (i < text.length && /[A-Za-z0-9_.$]/.test(text[i])) i += 1;
      const word = text.slice(start, i);
      if (text[i] === "!") {
        i = skipSpace(text, i + 1);
        const ref = readRef(text, i);
        if (!ref) throw new FormulaError(`bad formula "${text}" — expected a cell like A1 after ${word}!`);
        tokens.push({ type: "ref", sheet: word, col: ref.cell.col, row: ref.cell.row });
        i = ref.next;
        continue;
      }
      const refMatch = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(word);
      if (refMatch) {
        const col = colNumber(refMatch[1]);
        const row = Number(refMatch[2]);
        if (col < 1 || col > 16384 || row < 1 || row > 1048576) {
          throw new FormulaError(`bad formula "${text}" — "${word}" is outside the sheet`);
        }
        tokens.push({ type: "ref", sheet: null, col, row });
        continue;
      }
      if (/^[A-Za-z][A-Za-z0-9_.]*$/.test(word)) {
        tokens.push({ type: "name", value: word });
        continue;
      }
      throw new FormulaError(`bad formula "${text}" — "${word}" is not a cell or function`);
    }
    const two = text.slice(i, i + 2);
    if (two === "<=" || two === ">=" || two === "<>") {
      tokens.push({ type: "op", value: two });
      i += 2;
      continue;
    }
    if ("+-*/^&=<>".includes(c)) {
      tokens.push({ type: "op", value: c });
      i += 1;
      continue;
    }
    if (c === "(" || c === ")" || c === "," || c === ":") {
      tokens.push({ type: c });
      i += 1;
      continue;
    }
    throw new FormulaError(`bad formula "${text}" — unexpected "${c}"`);
  }
  tokens.push({ type: "eof" });
  return tokens;
}

function tokenLabel(token) {
  if (token.type === "eof") return "the end";
  if (token.type === "num") return String(token.value);
  if (token.type === "str") return `"${token.value}"`;
  if (token.type === "ref") return "a cell";
  if (token.type === "name") return token.value;
  if (token.type === "op") return token.value;
  return token.type;
}

function parseFormula(text) {
  const tokens = tokenize(text);
  let pos = 0;
  const peek = () => tokens[pos];
  const at = (type, value) => {
    const t = tokens[pos];
    return t.type === type && (value === undefined || t.value === value);
  };
  const take = () => tokens[pos++];
  const syntax = (message) => {
    throw new FormulaError(`bad formula "${text}" — ${message}`);
  };
  const expect = (type) => {
    if (!at(type)) syntax(`expected "${type}" but found ${tokenLabel(peek())}`);
    return take();
  };

  function parseExpr() {
    return parseComparison();
  }

  function parseComparison() {
    let left = parseConcat();
    while (at("op") && ["=", "<>", "<", ">", "<=", ">="].includes(peek().value)) {
      const op = take().value;
      left = { type: "binary", op, left, right: parseConcat() };
    }
    return left;
  }

  function parseConcat() {
    let left = parseAdd();
    while (at("op", "&")) {
      take();
      left = { type: "binary", op: "&", left, right: parseAdd() };
    }
    return left;
  }

  function parseAdd() {
    let left = parseMul();
    while (at("op", "+") || at("op", "-")) {
      const op = take().value;
      left = { type: "binary", op, left, right: parseMul() };
    }
    return left;
  }

  function parseMul() {
    let left = parsePower();
    while (at("op", "*") || at("op", "/")) {
      const op = take().value;
      left = { type: "binary", op, left, right: parsePower() };
    }
    return left;
  }

  function parsePower() {
    const left = parseUnary();
    if (at("op", "^")) {
      take();
      return { type: "binary", op: "^", left, right: parsePower() };
    }
    return left;
  }

  function parseUnary() {
    if (at("op", "-") || at("op", "+")) {
      const op = take().value;
      return { type: "unary", op, arg: parseUnary() };
    }
    return parsePrimary();
  }

  function parsePrimary() {
    const token = peek();
    if (token.type === "num") {
      take();
      return { type: "num", value: token.value };
    }
    if (token.type === "str") {
      take();
      return { type: "str", value: token.value };
    }
    if (token.type === "ref") {
      take();
      if (at(":")) {
        take();
        const to = peek();
        if (to.type !== "ref") syntax("a range needs two cells like A1:B9");
        take();
        return {
          type: "range",
          sheet: token.sheet,
          from: { col: token.col, row: token.row },
          to: { col: to.col, row: to.row },
          toSheet: to.sheet,
        };
      }
      return { type: "ref", sheet: token.sheet, col: token.col, row: token.row };
    }
    if (token.type === "name") {
      take();
      if (at("(")) {
        take();
        const args = [];
        if (!at(")")) {
          args.push(parseExpr());
          while (at(",")) {
            take();
            args.push(parseExpr());
          }
        }
        expect(")");
        return { type: "call", name: token.value, args };
      }
      if (/^TRUE$/i.test(token.value)) return { type: "bool", value: true };
      if (/^FALSE$/i.test(token.value)) return { type: "bool", value: false };
      syntax(`"${token.value}" is not a cell or function — check the name`);
    }
    if (at("(")) {
      take();
      const node = parseExpr();
      expect(")");
      return node;
    }
    syntax(`expected a value but found ${tokenLabel(token)}`);
  }

  const node = parseExpr();
  if (!at("eof")) syntax(`unexpected ${tokenLabel(peek())}`);
  assertSupported(node);
  return node;
}

function assertSupported(node) {
  if (node.type === "call") {
    if (!FUNCTIONS.includes(node.name.toUpperCase())) {
      throw new FormulaError(`unsupported function ${node.name} — use only: ${FUNC_LIST}`);
    }
    for (const arg of node.args) assertSupported(arg);
  } else if (node.type === "binary") {
    assertSupported(node.left);
    assertSupported(node.right);
  } else if (node.type === "unary") {
    assertSupported(node.arg);
  }
}

function toText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (value instanceof Date) return isoDate(value);
  return String(value);
}

function toNumber(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : ERR("#NUM!");
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const cleaned = value.replace(/,/g, "").trim();
    if (cleaned === "") return 0;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : ERR("#VALUE!");
  }
  return ERR("#VALUE!");
}

function truthy(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value !== "";
  return true;
}

function compareValues(left, right, op) {
  let x = left;
  let y = right;
  if (x === null || x === undefined) {
    x = typeof y === "string" ? "" : typeof y === "boolean" ? false : 0;
  }
  if (y === null || y === undefined) {
    y = typeof x === "string" ? "" : typeof x === "boolean" ? false : 0;
  }
  let cmp;
  if (typeof x === "number" && typeof y === "number") {
    cmp = x - y;
  } else if (typeof x === "string" && typeof y === "string") {
    const xl = x.toLowerCase();
    const yl = y.toLowerCase();
    cmp = xl < yl ? -1 : xl > yl ? 1 : 0;
  } else if (typeof x === "boolean" && typeof y === "boolean") {
    cmp = (x ? 1 : 0) - (y ? 1 : 0);
  } else {
    const rank = (v) => (typeof v === "number" ? 0 : typeof v === "string" ? 1 : 2);
    cmp = rank(x) - rank(y);
  }
  switch (op) {
    case "=": return cmp === 0;
    case "<>": return cmp !== 0;
    case "<": return cmp < 0;
    case ">": return cmp > 0;
    case "<=": return cmp <= 0;
    case ">=": return cmp >= 0;
    default: return ERR("#VALUE!");
  }
}

function roundExcel(value, digits) {
  const d = Math.max(-15, Math.min(15, digits));
  const [mantissa, exponent] = String(value).split("e");
  const shifted = Number(`${mantissa}e${(exponent ? Number(exponent) : 0) + d}`);
  const rounded = shifted >= 0 ? Math.round(shifted) : -Math.round(-shifted);
  return Number(`${rounded}e${-d}`);
}

function createEvaluator(sheets) {
  const byName = new Map(sheets.map((sheet) => [sheet.name.toLowerCase(), sheet]));

  function lookup(sheetName) {
    const sheet = byName.get(String(sheetName).toLowerCase());
    if (!sheet) throw new FormulaError(`no sheet named "${sheetName}" — check the sheet name`);
    return sheet;
  }

  function getCell(sheetName, col, row) {
    const sheet = lookup(sheetName);
    if (row < 1 || col < 1 || col > sheet.colCount) return null;
    const rowCells = sheet.grid[row - 1];
    if (!rowCells) return null;
    const cell = rowCells[col - 1];
    if (!cell) return null;
    if (cell.kind !== "formula") return cell.value;
    if (cell.state === "done") return cell.value;
    if (cell.state === "busy") {
      throw new FormulaError(
        `circular reference — formula ${cell.text} refers back to itself`,
        `${sheet.name}!${cellAddress(col, row)}`,
      );
    }
    cell.state = "busy";
    try {
      if (!cell.ast) cell.ast = parseFormula(cell.formula);
      let value = evalNode(cell.ast, sheet);
      if (isRange(value)) value = ERR("#VALUE!");
      if (value === null || value === undefined) value = 0;
      if (typeof value === "number" && !Number.isFinite(value)) value = ERR("#NUM!");
      cell.value = value;
      cell.state = "done";
      return value;
    } catch (error) {
      cell.state = "idle";
      if (error instanceof FormulaError && !error.where) {
        error.where = `${sheet.name}!${cellAddress(col, row)}`;
        if (!error.message.includes(cell.text)) error.message += ` (formula ${cell.text})`;
      }
      throw error;
    }
  }

  function flatten(values) {
    const out = [];
    for (const value of values) {
      if (isRange(value)) {
        for (let r = value.r1; r <= value.r2; r += 1) {
          for (let c = value.c1; c <= value.c2; c += 1) {
            out.push(getCell(value.sheet, c, r));
          }
        }
      } else {
        out.push(value);
      }
    }
    return out;
  }

  function evalBinary(node, sheet) {
    const left = evalNode(node.left, sheet);
    const right = evalNode(node.right, sheet);
    if (isErr(left)) return left;
    if (isErr(right)) return right;
    if (isRange(left) || isRange(right)) return ERR("#VALUE!");
    if (node.op === "&") return toText(left) + toText(right);
    if (node.op === "+" || node.op === "-" || node.op === "*" || node.op === "/" || node.op === "^") {
      const a = toNumber(left);
      const b = toNumber(right);
      if (isErr(a)) return a;
      if (isErr(b)) return b;
      if (node.op === "+") return a + b;
      if (node.op === "-") return a - b;
      if (node.op === "*") return a * b;
      if (node.op === "/") return b === 0 ? ERR("#DIV/0!") : a / b;
      return Math.pow(a, b);
    }
    return compareValues(left, right, node.op);
  }

  function evalCall(node, sheet) {
    const name = node.name.toUpperCase();
    const count = node.args.length;
    if (!FUNCTIONS.includes(name)) {
      throw new FormulaError(`unsupported function ${node.name} — use only: ${FUNC_LIST}`);
    }
    const evalArgs = () => node.args.map((arg) => evalNode(arg, sheet));

    if (name === "IF") {
      if (count < 2 || count > 3) throw new FormulaError("IF needs 2 or 3 arguments");
      const condition = evalNode(node.args[0], sheet);
      if (isErr(condition)) return condition;
      if (isRange(condition)) return ERR("#VALUE!");
      if (truthy(condition)) return evalNode(node.args[1], sheet);
      return count === 3 ? evalNode(node.args[2], sheet) : false;
    }
    if (name === "IFERROR") {
      if (count !== 2) throw new FormulaError("IFERROR needs 2 arguments");
      const value = evalNode(node.args[0], sheet);
      return isErr(value) ? evalNode(node.args[1], sheet) : value;
    }
    if (name === "ROUND") {
      if (count < 1 || count > 2) throw new FormulaError("ROUND needs 1 or 2 arguments");
      const values = evalArgs();
      if (isErr(values[0])) return values[0];
      const result = toNumber(values[0]);
      if (isErr(result)) return result;
      const digits = values.length > 1 ? toNumber(values[1]) : 0;
      if (isErr(digits)) return digits;
      return roundExcel(result, Math.trunc(digits));
    }
    if (name === "ABS") {
      if (count !== 1) throw new FormulaError("ABS needs 1 argument");
      const value = evalNode(node.args[0], sheet);
      if (isErr(value)) return value;
      const result = toNumber(value);
      return isErr(result) ? result : Math.abs(result);
    }
    if (name === "NOT") {
      if (count !== 1) throw new FormulaError("NOT needs 1 argument");
      const value = evalNode(node.args[0], sheet);
      if (isErr(value)) return value;
      if (isRange(value)) return ERR("#VALUE!");
      return !truthy(value);
    }
    if (name === "AND" || name === "OR") {
      if (count < 1) throw new FormulaError(`${name} needs at least 1 argument`);
      const values = flatten(evalArgs());
      for (const value of values) if (isErr(value)) return value;
      return name === "AND"
        ? values.every((value) => truthy(value))
        : values.some((value) => truthy(value));
    }
    if (name === "CONCAT" || name === "CONCATENATE") {
      const values = flatten(evalArgs());
      let out = "";
      for (const value of values) {
        if (isErr(value)) return value;
        out += toText(value);
      }
      return out;
    }

    const values = flatten(evalArgs());
    let sum = 0;
    let countNumbers = 0;
    let min = Infinity;
    let max = -Infinity;
    let nonEmpty = 0;
    for (const value of values) {
      if (name === "COUNTA") {
        if (isErr(value) || (value !== null && value !== undefined && value !== "")) nonEmpty += 1;
        continue;
      }
      if (isErr(value)) return value;
      if (typeof value === "number") {
        sum += value;
        countNumbers += 1;
        if (value < min) min = value;
        if (value > max) max = value;
      }
    }
    if (name === "SUM") return sum;
    if (name === "AVERAGE") return countNumbers === 0 ? ERR("#DIV/0!") : sum / countNumbers;
    if (name === "MIN") return countNumbers === 0 ? 0 : min;
    if (name === "MAX") return countNumbers === 0 ? 0 : max;
    if (name === "COUNT") return countNumbers;
    if (name === "COUNTA") return nonEmpty;
    return ERR("#VALUE!");
  }

  function evalNode(node, sheet) {
    switch (node.type) {
      case "num":
        return node.value;
      case "str":
        return node.value;
      case "bool":
        return node.value;
      case "ref":
        return getCell(node.sheet || sheet.name, node.col, node.row);
      case "range": {
        const sheetName = node.sheet || sheet.name;
        const otherSheet = node.toSheet || sheetName;
        if (otherSheet.toLowerCase() !== sheetName.toLowerCase()) {
          throw new FormulaError("a range must stay on one sheet");
        }
        lookup(sheetName);
        return {
          __range: true,
          sheet: sheetName,
          c1: Math.min(node.from.col, node.to.col),
          c2: Math.max(node.from.col, node.to.col),
          r1: Math.min(node.from.row, node.to.row),
          r2: Math.max(node.from.row, node.to.row),
        };
      }
      case "unary": {
        const value = evalNode(node.arg, sheet);
        if (isErr(value)) return value;
        const number = toNumber(value);
        if (isErr(number)) return number;
        return node.op === "-" ? -number : number;
      }
      case "binary":
        return evalBinary(node, sheet);
      case "call":
        return evalCall(node, sheet);
      default:
        throw new FormulaError("bad formula");
    }
  }

  return { getCell };
}

function displayNumber(value, format) {
  if (!Number.isFinite(value)) return String(value);
  switch (format) {
    case "integer":
      return Math.round(value).toLocaleString("en-US", { maximumFractionDigits: 0 });
    case "decimal":
      return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    case "currency": {
      const body = Math.abs(value).toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
      return `${value < 0 ? "-" : ""}$${body}`;
    }
    case "percent":
      return `${(value * 100).toLocaleString("en-US", {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      })}%`;
    case "text":
      return String(value);
    default:
      return String(value);
  }
}

function formatValue(value, format) {
  if (value === null || value === undefined) return "";
  if (isErr(value)) return value.__error;
  if (value instanceof Date) return isoDate(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") return displayNumber(value, format);
  return String(value);
}

function formatFromNumFmt(numFmt) {
  if (!numFmt) return undefined;
  if (numFmt === "@") return "text";
  if (numFmt === "#,##0") return "integer";
  if (numFmt === "#,##0.00") return "decimal";
  if (numFmt === "$#,##0.00") return "currency";
  if (numFmt === "0.0%") return "percent";
  if (/y/.test(numFmt) && /d/.test(numFmt)) return "date";
  return undefined;
}

function displayRead(value, numFmt) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return isoDate(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") return displayNumber(value, formatFromNumFmt(numFmt));
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    if (typeof value.error === "string") return value.error;
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text || "").join("");
    if (typeof value.text === "string") return value.text;
    if (value.result !== undefined) return displayRead(value.result, numFmt);
    return "";
  }
  return String(value);
}

function readInput(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    fail(`can't read ${basename(path)} — check the path`);
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`${basename(path)} is not valid JSON: ${error.message}`);
  }
}

function validateInput(data) {
  if (!data || typeof data !== "object") fail('the input must be a JSON object with a "sheets" array');
  if (!Array.isArray(data.sheets) || data.sheets.length === 0) fail('"sheets" must be a non-empty array');
  const seen = new Set();
  data.sheets.forEach((sheet, index) => {
    if (!sheet || typeof sheet !== "object") fail(`sheet ${index + 1} must be an object`);
    const name = sheet.name;
    if (typeof name !== "string" || name.trim() === "") fail(`sheet ${index + 1} needs a "name"`);
    if (name.length > 31) fail(`sheet name "${name}" is ${name.length} characters — Excel allows at most 31`);
    const bad = /[:\\\/?*\[\]]/.exec(name);
    if (bad) fail(`sheet name "${name}" contains "${bad[0]}" — Excel does not allow : \\ / ? * [ ]`);
    if (seen.has(name.toLowerCase())) fail(`two sheets are named "${name}" — give each sheet a different name`);
    seen.add(name.toLowerCase());

    if (!Array.isArray(sheet.columns) || sheet.columns.length === 0) {
      fail(`sheet "${name}" needs a non-empty "columns" array`);
    }
    sheet.columns.forEach((col, colIndex) => {
      if (!col || typeof col !== "object") fail(`sheet "${name}" column ${colIndex + 1} must be an object`);
      if (typeof col.header !== "string") fail(`sheet "${name}" column ${colIndex + 1} needs a "header" string`);
      if (col.format !== undefined && !FORMATS.includes(col.format)) {
        fail(`sheet "${name}" column "${col.header}" has format "${col.format}" — use ${FORMATS.join(", ")}`);
      }
      if (col.width !== undefined) {
        if (typeof col.width !== "number" || !Number.isFinite(col.width) || col.width <= 0 || col.width > 255) {
          fail(`sheet "${name}" column "${col.header}" has width ${JSON.stringify(col.width)} — use a number from 1 to 255`);
        }
      }
    });

    if (!Array.isArray(sheet.rows)) fail(`sheet "${name}" needs a "rows" array`);
    sheet.rows.forEach((row, rowIndex) => {
      if (!Array.isArray(row)) fail(`sheet "${name}" row ${rowIndex + 2} must be an array of values`);
      if (row.length > sheet.columns.length) {
        fail(`sheet "${name}" row ${rowIndex + 2} has ${row.length} values but the sheet has ${sheet.columns.length} columns`);
      }
      row.forEach((value, colIndex) => {
        if (value !== null && !["string", "number", "boolean"].includes(typeof value)) {
          fail(`sheet "${name}" ${cellAddress(colIndex + 1, rowIndex + 2)} must be text, a number, true/false or null`);
        }
        if (typeof value === "number" && !Number.isFinite(value)) {
          fail(`sheet "${name}" ${cellAddress(colIndex + 1, rowIndex + 2)} has a number that is not finite`);
        }
      });
    });

    if (sheet.freeze !== undefined && typeof sheet.freeze !== "boolean") {
      fail(`sheet "${name}": "freeze" must be true or false`);
    }
    if (sheet.filter !== undefined && typeof sheet.filter !== "boolean") {
      fail(`sheet "${name}": "filter" must be true or false`);
    }
  });
}

function convertValue(raw, col, sheetName, address) {
  if (raw === null) return null;
  const format = col.format;
  if (format === "text") {
    if (typeof raw === "boolean") return raw ? "TRUE" : "FALSE";
    return typeof raw === "string" ? raw : String(raw);
  }
  if (format === "date") {
    if (typeof raw === "string" && raw.trim() === "") return null;
    if (typeof raw !== "string") {
      fail(`${sheetName}!${address}: use a date string like "2026-01-31" in the date column`);
    }
    const date = parseISODate(raw);
    if (!date) fail(`${sheetName}!${address}: "${raw}" is not a date — use YYYY-MM-DD`);
    return date;
  }
  if (format === "integer" || format === "decimal" || format === "currency" || format === "percent") {
    if (typeof raw === "string" && raw.trim() === "") return null;
    if (typeof raw === "number") return raw;
    if (typeof raw === "boolean") {
      fail(`${sheetName}!${address}: true/false is not a number — column "${col.header}" is ${format}`);
    }
    const cleaned = raw.replace(/,/g, "").trim();
    const number = cleaned === "" ? NaN : Number(cleaned);
    if (!Number.isFinite(number)) {
      fail(`${sheetName}!${address}: "${raw}" is not a number but column "${col.header}" is ${format}`);
    }
    return number;
  }
  return raw;
}

function buildSheets(data) {
  return data.sheets.map((input) => {
    const colCount = input.columns.length;
    const grid = [];
    grid[0] = input.columns.map((col) => ({ kind: "value", value: col.header, header: true }));
    input.rows.forEach((row, rowIndex) => {
      const rowNumber = rowIndex + 2;
      const cells = [];
      for (let colIndex = 0; colIndex < colCount; colIndex += 1) {
        const col = input.columns[colIndex];
        const address = cellAddress(colIndex + 1, rowNumber);
        const raw = colIndex < row.length ? row[colIndex] : null;
        if (typeof raw === "string" && raw.startsWith("=")) {
          cells.push({ kind: "formula", text: raw, formula: raw.slice(1), state: "idle" });
        } else {
          cells.push({ kind: "value", value: convertValue(raw, col, input.name, address) });
        }
      }
      grid[rowNumber - 1] = cells;
    });
    return {
      name: input.name,
      columns: input.columns,
      colCount,
      rowCount: input.rows.length + 1,
      grid,
      input,
    };
  });
}

function evaluateAll(sheets, evaluator) {
  for (const sheet of sheets) {
    for (let row = 2; row <= sheet.rowCount; row += 1) {
      const cells = sheet.grid[row - 1] || [];
      for (let col = 1; col <= cells.length; col += 1) {
        const cell = cells[col - 1];
        if (cell && cell.kind === "formula") evaluator.getCell(sheet.name, col, row);
      }
    }
  }
}

function excelResult(value) {
  if (isErr(value)) return { error: value.__error };
  if (value === null || value === undefined) return 0;
  if (value instanceof Date) return value;
  if (typeof value === "number" && !Number.isFinite(value)) return { error: "#NUM!" };
  return value;
}

async function writeWorkbook(sheets, outputPath) {
  const wb = new ExcelJS.Workbook();
  for (const sheet of sheets) {
    const ws = wb.addWorksheet(sheet.name, {
      views: sheet.input.freeze === false ? [] : [{ state: "frozen", ySplit: 1 }],
    });

    for (let col = 1; col <= sheet.colCount; col += 1) {
      const cell = ws.getCell(1, col);
      cell.value = sheet.columns[col - 1].header;
      cell.font = { bold: true };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9E2F3" } };
      cell.border = { bottom: { style: "thin", color: { argb: "FF8EA9C1" } } };
    }

    for (let row = 2; row <= sheet.rowCount; row += 1) {
      const cells = sheet.grid[row - 1];
      for (let col = 1; col <= sheet.colCount; col += 1) {
        const item = cells[col - 1];
        const column = sheet.columns[col - 1];
        const cell = ws.getCell(row, col);
        if (item.kind === "formula") {
          cell.value = { formula: item.formula, result: excelResult(item.value) };
        } else if (item.value !== null) {
          cell.value = item.value;
        }
        if (column.format) cell.numFmt = NUM_FMTS[column.format];
      }
    }

    for (let col = 1; col <= sheet.colCount; col += 1) {
      const column = sheet.columns[col - 1];
      let width = column.width;
      if (width === undefined) {
        let longest = 0;
        for (let row = 1; row <= sheet.rowCount; row += 1) {
          const cells = sheet.grid[row - 1];
          const item = cells && cells[col - 1];
          if (!item) continue;
          const text = row === 1 ? column.header : formatValue(item.value, column.format);
          longest = Math.max(longest, text.length);
        }
        width = Math.max(10, Math.min(60, longest + 2));
      }
      ws.getColumn(col).width = width;
    }

    if (sheet.input.filter !== false) {
      ws.autoFilter = `A1:${colLetters(sheet.colCount)}${sheet.rowCount}`;
    }
  }

  try {
    mkdirSync(dirname(resolve(outputPath)), { recursive: true });
    await wb.xlsx.writeFile(outputPath);
  } catch (error) {
    fail(`couldn't write ${basename(outputPath)}: ${error.message}`);
  }
}

async function inspectWorkbook(path) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.readFile(path);
  } catch (error) {
    fail(`can't open ${basename(path)} as a workbook: ${error.message}`);
  }

  const problems = [];
  let sheetCount = 0;
  let formulaCount = 0;

  for (const ws of wb.worksheets) {
    sheetCount += 1;
    const lastRow = ws.rowCount || 1;
    const lastCol = ws.columnCount || 1;
    const longest = new Map();

    for (let row = 1; row <= lastRow; row += 1) {
      for (let col = 1; col <= lastCol; col += 1) {
        const cell = ws.getCell(row, col);
        const value = cell.value;
        const label = `${ws.name}!${cell.address}`;
        let display = "";

        if (value && typeof value === "object" && ("formula" in value || "sharedFormula" in value)) {
          formulaCount += 1;
          const result = cell.result;
          if (result === undefined || result === null) {
            problems.push(`${label} has no cached result — set a result when writing the formula`);
          } else if (result && typeof result === "object" && typeof result.error === "string") {
            problems.push(`${label} contains error ${result.error} — fix the formula or wrap it in IFERROR`);
          } else if (typeof result === "string") {
            if (ERROR_CODES.has(result)) {
              problems.push(`${label} contains error ${result} — fix the formula or wrap it in IFERROR`);
            }
            const problem = textProblem(result);
            if (problem) problems.push(textMessage(label, problem));
          }
          display = displayRead(result, cell.numFmt);
        } else if (value && typeof value === "object" && typeof value.error === "string") {
          problems.push(`${label} contains error ${value.error} — fix the formula or wrap it in IFERROR`);
          display = value.error;
        } else {
          if (typeof value === "string") {
            const problem = textProblem(value);
            if (problem) problems.push(textMessage(label, problem));
          } else if (value && typeof value === "object" && Array.isArray(value.richText)) {
            const text = value.richText.map((part) => part.text || "").join("");
            const problem = textProblem(text);
            if (problem) problems.push(textMessage(label, problem));
          } else if (value && typeof value === "object" && typeof value.text === "string") {
            const problem = textProblem(value.text);
            if (problem) problems.push(textMessage(label, problem));
          }
          display = displayRead(value, cell.numFmt);
        }

        longest.set(col, Math.max(longest.get(col) || 0, display.length));
      }
    }

    for (let col = 1; col <= lastCol; col += 1) {
      const width = ws.getColumn(col).width ?? 8.43;
      const needed = (longest.get(col) || 0) + 1;
      if (width < needed) {
        problems.push(`column ${colLetters(col)} on sheet "${ws.name}" would show ####: widen it to at least ${needed + 1}`);
      }
    }
  }

  return { problems, sheets: sheetCount, formulas: formulaCount };
}

function printOk(path, info) {
  console.log(
    `OK: ${basename(path)} — ${info.sheets} ${info.sheets === 1 ? "sheet" : "sheets"}, ` +
      `${info.formulas} ${info.formulas === 1 ? "formula" : "formulas"}`,
  );
}

function printProblems(problems) {
  for (const problem of problems) console.error(`ERROR: ${problem}`);
}

async function buildWorkbook(inputPath, outputPath) {
  if (samePath(inputPath, outputPath)) fail("the output must be a different file from the input");
  const data = readInput(inputPath);
  validateInput(data);
  const sheets = buildSheets(data);
  const evaluator = createEvaluator(sheets);

  try {
    evaluateAll(sheets, evaluator);
  } catch (error) {
    if (error instanceof FormulaError) {
      fail(`${error.where ? `${error.where}: ` : ""}${error.message}`);
    }
    throw error;
  }

  await writeWorkbook(sheets, outputPath);
  const info = await inspectWorkbook(outputPath);
  if (info.problems.length) {
    printProblems(info.problems);
    process.exitCode = 1;
    return;
  }
  printOk(outputPath, info);
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (command === "init") {
    if (argv.length !== 2) usage();
    const file = argv[1];
    mkdirSync(dirname(resolve(file)), { recursive: true });
    writeFileSync(file, `${JSON.stringify(SAMPLE_INPUT, null, 2)}\n`, "utf8");
    console.log(`OK: wrote ${basename(file)} — edit the content, then run build`);
    return;
  }

  if (command === "build") {
    if (argv.length !== 3) usage();
    await buildWorkbook(argv[1], argv[2]);
    return;
  }

  if (command === "check") {
    if (argv.length !== 2) usage();
    const info = await inspectWorkbook(argv[1]);
    if (info.problems.length) {
      printProblems(info.problems);
      process.exitCode = 1;
      return;
    }
    printOk(argv[1], info);
    return;
  }

  usage();
}

main().catch((error) => fail(error && error.message ? error.message : String(error)));
