/**
 * Safe evaluator for the small arithmetic formulas inline calculator blocks
 * may use. No `eval` / `Function`: the string is tokenized and parsed by hand,
 * and identifiers only ever read an existing own key of `vars`.
 */

/** Longest accepted formula, in characters. */
const FORMULA_MAX = 200;

type Token = { kind: "num"; value: number } | { kind: "id"; name: string } | { kind: "op"; value: string };

/** Split `src` into tokens, or null on any character we do not allow. */
function tokenize(src: string): Token[] | null {
  if (src.length > FORMULA_MAX) return null;
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src.charAt(i);
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "*" && src.charAt(i + 1) === "*") {
      tokens.push({ kind: "op", value: "**" });
      i += 2;
      continue;
    }
    if (c === "+" || c === "-" || c === "*" || c === "/" || c === "^" || c === "(" || c === ")") {
      tokens.push({ kind: "op", value: c });
      i++;
      continue;
    }
    if (c >= "0" && c <= "9") {
      let j = i;
      let dot = false;
      for (;;) {
        const d = src.charAt(j);
        if (d >= "0" && d <= "9") {
          j++;
          continue;
        }
        if (d === "." && !dot) {
          dot = true;
          j++;
          continue;
        }
        break;
      }
      tokens.push({ kind: "num", value: Number(src.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (/[A-Za-z0-9_]/.test(src.charAt(j))) j++;
      tokens.push({ kind: "id", name: src.slice(i, j) });
      i = j;
      continue;
    }
    return null;
  }
  return tokens;
}

/** Recursive-descent parser over `tokens`, reading values from `vars`. */
function parse(tokens: Token[], vars: Record<string, number>): number | null {
  let pos = 0;

  const peek = (): Token | undefined => tokens[pos];
  const eat = (value: string): boolean => {
    const t = peek();
    if (t && t.kind === "op" && t.value === value) {
      pos++;
      return true;
    }
    return false;
  };

  const primary = (): number | null => {
    const t = peek();
    if (!t) return null;
    if (t.kind === "num") {
      pos++;
      return t.value;
    }
    if (t.kind === "id") {
      if (!Object.prototype.hasOwnProperty.call(vars, t.name)) return null;
      pos++;
      return vars[t.name] ?? null;
    }
    if (t.value === "(") {
      pos++;
      const inner = expr();
      if (inner === null || !eat(")")) return null;
      return inner;
    }
    return null;
  };

  /** Exponentiation (`^` / `**`), right-associative and tighter than `*` and `/`; the exponent may be unary. */
  const power = (): number | null => {
    const base = primary();
    if (base === null) return null;
    if (eat("^") || eat("**")) {
      const exponent = unary();
      if (exponent === null) return null;
      return Math.pow(base, exponent);
    }
    return base;
  };

  const unary = (): number | null => {
    if (eat("-")) {
      const v = unary();
      return v === null ? null : -v;
    }
    return power();
  };

  const term = (): number | null => {
    let left = unary();
    if (left === null) return null;
    for (;;) {
      if (eat("*")) {
        const right = unary();
        if (right === null) return null;
        left *= right;
      } else if (eat("/")) {
        const right = unary();
        if (right === null || right === 0) return null;
        left /= right;
      } else break;
    }
    return left;
  };

  const expr = (): number | null => {
    let left = term();
    if (left === null) return null;
    for (;;) {
      if (eat("+")) {
        const right = term();
        if (right === null) return null;
        left += right;
      } else if (eat("-")) {
        const right = term();
        if (right === null) return null;
        left -= right;
      } else break;
    }
    return left;
  };

  const result = expr();
  if (result === null || pos !== tokens.length || !Number.isFinite(result)) return null;
  return result;
}

/** Evaluate `formula` with `vars`, or null if it is malformed or non-finite. */
export function evaluateFormula(formula: string, vars: Record<string, number>): number | null {
  if (typeof formula !== "string") return null;
  const tokens = tokenize(formula);
  if (tokens === null) return null;
  return parse(tokens, vars);
}

/** The identifiers `formula` uses, or null if it does not tokenize. */
export function formulaIds(formula: string): string[] | null {
  if (typeof formula !== "string") return null;
  const tokens = tokenize(formula);
  if (tokens === null) return null;
  const ids: string[] = [];
  for (const t of tokens) {
    if (t.kind === "id" && !ids.includes(t.name)) ids.push(t.name);
  }
  return ids;
}
