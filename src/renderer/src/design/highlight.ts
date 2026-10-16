// A tiny, dependency-free syntax tokenizer for the inspector's Code tab. It is
// lossless: highlight(text, lang).map((t) => t.text).join("") === text always.

/** The kinds a token can carry; "plain" is unstyled text. */
export type SynKind = "keyword" | "string" | "number" | "comment" | "attr" | "plain";

/** One run of source text and how it should be coloured. */
export interface SynToken {
  text: string;
  kind: SynKind;
}

/** The languages the tokenizer knows; anything else is shown plain. */
export type SynLang = "html" | "css" | "js" | "plain";

/** Words coloured as keywords in js/json. */
const JS_KEYWORDS = new Set([
  "const",
  "let",
  "var",
  "function",
  "return",
  "if",
  "else",
  "for",
  "while",
  "do",
  "switch",
  "case",
  "break",
  "continue",
  "new",
  "class",
  "extends",
  "import",
  "from",
  "export",
  "default",
  "async",
  "await",
  "try",
  "catch",
  "finally",
  "throw",
  "typeof",
  "instanceof",
  "in",
  "of",
  "true",
  "false",
  "null",
  "undefined",
  "this",
  "yield",
  "delete",
  "void",
]);

const isHexDigit = (c: string): boolean => (c >= "0" && c <= "9") || (c >= "a" && c <= "f") || (c >= "A" && c <= "F");
const isDigit = (c: string): boolean => c >= "0" && c <= "9";
const isSpace = (c: string): boolean => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v";
const isCssIdentStart = (c: string): boolean => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_" || c === "-";
const isCssIdentChar = (c: string): boolean => isCssIdentStart(c) || isDigit(c);
const isJsIdentStart = (c: string): boolean => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_" || c === "$";
const isJsIdentChar = (c: string): boolean => isJsIdentStart(c) || isDigit(c);

/** True when a css/js number token starts at `i` (a digit, or `.`/`-` before one). */
function isNumberStart(text: string, i: number): boolean {
  const c = text[i];
  if (c === undefined) return false;
  if (isDigit(c)) return true;
  if (c === ".") return isDigit(text[i + 1] ?? "");
  if (c === "-") {
    const d = text[i + 1];
    return d !== undefined && (isDigit(d) || (d === "." && isDigit(text[i + 2] ?? "")));
  }
  return false;
}

/** The extension-based language of a path, case-insensitively. */
export function langOf(path: string): SynLang {
  const match = /\.([a-z0-9]+)$/i.exec(path);
  const ext = match ? match[1]!.toLowerCase() : "";
  if (ext === "html" || ext === "htm" || ext === "svg") return "html";
  if (ext === "css") return "css";
  if (ext === "js" || ext === "mjs" || ext === "jsx" || ext === "ts" || ext === "tsx" || ext === "json") return "js";
  return "plain";
}

type Push = (kind: SynKind, text: string) => void;
interface Builder {
  tokens: SynToken[];
  push: Push;
}

/** Adjacent tokens of the same kind are merged as they're pushed. */
function builder(): Builder {
  const tokens: SynToken[] = [];
  const push: Push = (kind, text) => {
    if (!text) return;
    const last = tokens[tokens.length - 1];
    if (last && last.kind === kind) last.text += text;
    else tokens.push({ text, kind });
  };
  return { tokens, push };
}

/** Read a quoted string starting at `i`; an unterminated one runs to the end. Returns the next index. */
function readQuoted(text: string, i: number, push: Push): number {
  const quote = text[i]!;
  const n = text.length;
  let k = i + 1;
  while (k < n && text[k] !== quote) {
    if (text[k] === "\\") k++;
    k++;
  }
  const stop = k < n ? k + 1 : n;
  push("string", text.slice(i, stop));
  return stop;
}

// Sticky, so a match reads in place instead of slicing the rest of the text at every number.
const CSS_NUMBER = /-?(?:\d+(?:\.\d+)?|\.\d+)(?:[a-zA-Z]+|%)?/y;
const JS_NUMBER = /-?(?:0[xX][0-9a-fA-F]+|(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?)/y;

/** Read a number at `i` (the caller checked `isNumberStart`); returns the next index. */
function readNumber(text: string, i: number, re: RegExp, push: Push): number {
  re.lastIndex = i;
  const m = re.exec(text);
  const stop = m ? i + m[0].length : i + 1;
  push(m ? "number" : "plain", text.slice(i, stop));
  return stop;
}

/** Scan css: comments, strings, numbers/units/hex, at-rules and property names. */
function scanCss(text: string, push: Push): void {
  const n = text.length;
  let i = 0;
  let depth = 0;
  while (i < n) {
    const c = text[i]!;
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      push("comment", text.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      i = readQuoted(text, i, push);
      continue;
    }
    if (c === "#") {
      let k = i + 1;
      while (k < n && isHexDigit(text[k]!)) k++;
      const len = k - i - 1;
      if (len === 3 || len === 4 || len === 6 || len === 8) {
        push("number", text.slice(i, k));
        i = k;
        continue;
      }
    }
    if (c === "@") {
      let k = i + 1;
      while (k < n && /[a-zA-Z-]/.test(text[k]!)) k++;
      push("keyword", text.slice(i, k));
      i = k;
      continue;
    }
    if (isNumberStart(text, i)) {
      i = readNumber(text, i, CSS_NUMBER, push);
      continue;
    }
    if (c === "{") {
      push("plain", c);
      depth++;
      i++;
      continue;
    }
    if (c === "}") {
      push("plain", c);
      if (depth > 0) depth--;
      i++;
      continue;
    }
    if (isCssIdentStart(c)) {
      let k = i;
      while (k < n && isCssIdentChar(text[k]!)) k++;
      let j = k;
      while (j < n && isSpace(text[j]!)) j++;
      push(depth > 0 && text[j] === ":" ? "attr" : "plain", text.slice(i, k));
      i = k;
      continue;
    }
    push("plain", c);
    i++;
  }
}

/** Scan js/json: line and block comments, strings (incl. template), numbers and keywords. */
function scanJs(text: string, push: Push): void {
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i]!;
    if (c === "/" && text[i + 1] === "/") {
      let k = i + 2;
      while (k < n && text[k] !== "\n") k++;
      push("comment", text.slice(i, k));
      i = k;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      push("comment", text.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      i = readQuoted(text, i, push);
      continue;
    }
    if (isNumberStart(text, i)) {
      i = readNumber(text, i, JS_NUMBER, push);
      continue;
    }
    if (isJsIdentStart(c)) {
      let k = i;
      while (k < n && isJsIdentChar(text[k]!)) k++;
      const word = text.slice(i, k);
      push(JS_KEYWORDS.has(word) ? "keyword" : "plain", word);
      i = k;
      continue;
    }
    push("plain", c);
    i++;
  }
}

/** Scan html: comments, tags (tag name, attributes, values) and `<style>`/`<script>` bodies. */
function scanHtml(text: string, push: Push): void {
  const n = text.length;
  let i = 0;
  while (i < n) {
    if (text[i] === "<" && text.startsWith("<!--", i)) {
      const end = text.indexOf("-->", i + 4);
      const stop = end === -1 ? n : end + 3;
      push("comment", text.slice(i, stop));
      i = stop;
      continue;
    }
    if (text[i] === "<") {
      const open = i;
      i++;
      let closing = false;
      if (text[i] === "/") {
        closing = true;
        i++;
      }
      let doctype = false;
      if (!closing && text[i] === "!") {
        doctype = true;
        i++;
      }
      const nameStart = i;
      while (i < n && !/[\s/>=<>"']/.test(text[i]!)) i++;
      const name = text.slice(nameStart, i);
      push("plain", text.slice(open, nameStart));
      if (name) push("keyword", name);
      while (i < n && text[i] !== ">") {
        const c = text[i]!;
        if (isSpace(c)) {
          const ws = i;
          while (i < n && isSpace(text[i]!)) i++;
          push("plain", text.slice(ws, i));
          continue;
        }
        if (c === "/" || c === "=") {
          push("plain", c);
          i++;
          continue;
        }
        const as = i;
        while (i < n && !/[\s=/>"']/.test(text[i]!)) i++;
        // A stray quote in a tag (`<a "x">`) isn't an attribute; step over it so the loop always moves.
        if (i === as) {
          push("plain", c);
          i++;
          continue;
        }
        const attr = text.slice(as, i);
        let j = i;
        while (j < n && isSpace(text[j]!)) j++;
        if (j < n && text[j] === "=") {
          push("attr", attr);
          if (j > i) {
            push("plain", text.slice(i, j));
            i = j;
          }
          push("plain", "=");
          i++;
          const vs = i;
          while (i < n && isSpace(text[i]!)) i++;
          if (i > vs) push("plain", text.slice(vs, i));
          const q = text[i];
          if (q === '"' || q === "'") {
            i = readQuoted(text, i, push);
          } else {
            const uv = i;
            while (i < n && !isSpace(text[i]!) && text[i] !== ">") i++;
            push("string", text.slice(uv, i));
          }
        } else {
          push("attr", attr);
        }
      }
      if (i < n && text[i] === ">") {
        push("plain", ">");
        i++;
      }
      const tag = name.toLowerCase();
      if (!closing && !doctype && (tag === "style" || tag === "script")) {
        const idx = text.toLowerCase().indexOf(`</${tag}`, i);
        const end = idx === -1 ? n : idx;
        const content = text.slice(i, end);
        if (content) (tag === "style" ? scanCss : scanJs)(content, push);
        i = end;
      }
      continue;
    }
    const ts = i;
    while (i < n && text[i] !== "<") i++;
    push("plain", text.slice(ts, i));
  }
}

/**
 * Tokenize source text for one language. The result is lossless — joining every
 * token's text reproduces the input — and never empty-padded. Text over 200k
 * chars, and "plain" text, come back as a single plain token.
 */
export function highlight(text: string, lang: SynLang): SynToken[] {
  if (text.length === 0) return [];
  if (lang === "plain" || text.length > 200_000) return [{ text, kind: "plain" }];
  const { tokens, push } = builder();
  if (lang === "html") scanHtml(text, push);
  else if (lang === "css") scanCss(text, push);
  else scanJs(text, push);
  return tokens;
}
