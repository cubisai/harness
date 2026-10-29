// A TypeScript port of skilled's git-guardrails script
// (skills/git-guardrails/scripts/block-dangerous-git.py), so the guard runs
// with no Python and no skills library installed. Same rules, same wording:
// it matches the real invocation per shell segment (subcommand + flags), not
// a raw substring of the command line.

import type { GuardVerdict } from "./guard";

/** POSIX-ish word splitting, like Python's shlex.split; null on unbalanced quotes. */
function shlexSplit(s: string): string[] | null {
  const out: string[] = [];
  let cur = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote === "'") {
      if (c === "'") quote = null;
      else cur += c;
    } else if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "\\" && i + 1 < s.length && '"\\$`\n'.includes(s[i + 1]!)) cur += s[++i];
      else cur += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (c === "\\" && i + 1 < s.length) {
      cur += s[++i];
      inWord = true;
    } else if (/\s/.test(c)) {
      if (inWord) out.push(cur);
      cur = "";
      inWord = false;
    } else {
      cur += c;
      inWord = true;
    }
  }
  if (quote) return null;
  if (inWord) out.push(cur);
  return out;
}

function tokenize(segment: string): string[] {
  // Unbalanced quotes: fall back to plain whitespace.
  return shlexSplit(segment) ?? segment.split(/\s+/).filter(Boolean);
}

/** Basename of a command token, without .exe: /usr/bin/git -> git. */
function program(token: string): string {
  return token.replace(/\\/g, "/").split("/").pop()!.replace(/\.exe$/, "");
}

/** A short-option cluster like -fd, -df, -Dfx contains the letter, in any order. */
function clusterHas(token: string, letter: string): boolean {
  return token.startsWith("-") && !token.startsWith("--") && token.includes(letter);
}

/** tokens contains seq as a contiguous run, wherever it starts (npx/pnpm exec prefixes included). */
function hasSeq(tokens: string[], seq: string[]): boolean {
  const names = tokens.map(program);
  for (let i = 0; i + seq.length <= names.length; i++) {
    if (seq.every((s, j) => names[i + j] === s)) return true;
  }
  return false;
}

// Commands that destroy data or infrastructure no `git` undo can bring back.
const DESTRUCTIVE: [string[], string][] = [
  [["terraform", "destroy"], "terraform destroy tears down real infrastructure"],
  [["tofu", "destroy"], "tofu destroy tears down real infrastructure"],
  [["prisma", "migrate", "reset"], "prisma migrate reset drops the database"],
  [["dropdb"], "dropdb deletes a database"],
  [["docker", "volume", "rm"], "docker volume rm deletes stored data"],
  [["docker", "volume", "prune"], "docker volume prune deletes stored data"],
  [["kubectl", "delete", "namespace"], "kubectl delete namespace deletes everything in it"],
  [["kubectl", "delete", "ns"], "kubectl delete ns deletes everything in it"],
];
const SQL_CLIENTS = new Set(["psql", "mysql", "mariadb", "sqlite3", "mongosh", "sqlcmd"]);
const DESTRUCTIVE_SQL = /\b(drop\s+(database|schema|table)|truncate\s+table)\b/i;

function destructiveReason(tokens: string[]): string | null {
  for (const [seq, reason] of DESTRUCTIVE) if (hasSeq(tokens, seq)) return reason;
  if (tokens.some((t) => t === "-destroy" || t === "--destroy") && hasSeq(tokens, ["terraform", "apply"])) {
    return "terraform apply -destroy tears down real infrastructure";
  }
  if (tokens.some((t) => ["rails", "rake"].includes(program(t))) && tokens.some((t) => ["db:drop", "db:reset", "db:drop:all"].includes(t))) {
    return "db:drop / db:reset deletes the database";
  }
  if (tokens.some((t) => SQL_CLIENTS.has(program(t))) && DESTRUCTIVE_SQL.test(tokens.join(" "))) {
    return "DROP / TRUNCATE through a database client deletes data";
  }
  return null;
}

function segmentReason(tokens: string[]): string | null {
  if (!tokens.length) return null;
  const destructive = destructiveReason(tokens);
  if (destructive) return destructive;
  if (program(tokens[0]!) !== "git") return null;
  let i = 1;
  // Skip git's own global options, so `git -C . push` is still `push`.
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (["-C", "--git-dir", "--work-tree", "-c"].includes(t)) i += 2;
    else if (t.startsWith("-")) i += 1;
    else break;
  }
  if (i >= tokens.length) return null;
  const sub = tokens[i]!;
  const rest = tokens.slice(i + 1);
  if (sub === "push") return "git push is blocked (all forms, including --force)";
  if (sub === "reset" && rest.includes("--hard")) return "git reset --hard discards uncommitted work";
  if (sub === "clean" && rest.some((t) => t === "--force" || clusterHas(t, "f"))) return "git clean with force deletes untracked files";
  if (sub === "branch") {
    if (rest.includes("--delete") && (rest.includes("--force") || rest.includes("-f"))) return "git branch --delete --force discards an unmerged branch";
    if (rest.some((t) => clusterHas(t, "D"))) return "git branch -D discards an unmerged branch";
  }
  if ((sub === "checkout" || sub === "restore") && rest.includes(".") && !rest.includes("-p") && !rest.includes("--patch")) {
    return `git ${sub} . discards uncommitted changes in the working tree`;
  }
  return null;
}

/** The built-in verdict for one shell command line, checked segment by segment. */
export function builtInVerdict(command: string): GuardVerdict {
  if (!command.trim()) return { blocked: false, reason: "" };
  // Command-by-command across shell separators (&&, ||, ;, |, newline).
  for (const segment of command.split(/&&|\|\||;|\||\n/)) {
    const reason = segmentReason(tokenize(segment.trim()));
    if (reason) return { blocked: true, reason: `BLOCKED: '${command}' -- ${reason}. The user has prevented you from doing this.` };
  }
  return { blocked: false, reason: "" };
}
