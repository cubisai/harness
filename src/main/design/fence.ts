// Design threads run in Full permission mode, so nothing would otherwise stop an
// agent from deleting the project or writing past its design folder. This is the
// deny side of that bargain: given a write's paths or a shell command, it says
// why the action is out of bounds, or null when it stays inside the thread.

import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { insideDesignFolder } from "./write-scope";

/** True when `abs` is `root` or inside it. */
function within(root: string, abs: string): boolean {
  const rel = relative(root, abs);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Basename of a command token, without .exe: /usr/bin/rm -> rm. */
function program(token: string): string {
  return basename(token.replace(/\\/g, "/")).replace(/\.exe$/, "");
}

/** `~` and `~/x` expand to the home directory; anything else is untouched. */
function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return p;
}

/** Resolve an operand against the tracked working directory, after expanding `~`. */
function resolvePath(current: string, p: string): string {
  const expanded = expandHome(p);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(current, expanded);
}

/**
 * Scratch paths are writable, but a temp root that contains the thread itself is
 * not: otherwise a test or project living under the temp dir would be wide open.
 */
function scratchPath(abs: string, cwd: string): boolean {
  return [tmpdir(), "/tmp", "/private/tmp"].some((root) => {
    const r = resolve(root);
    return !within(r, cwd) && within(r, abs);
  });
}

/** The std streams, as written (on Windows `/dev/null` would resolve to `C:\dev\null`; `NUL` is cmd's). */
const STD_STREAMS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr"]);

/** A resolved path is writable when it is in the design folder, a std stream, or scratch. */
function allowedPath(cwd: string, design: string, current: string, p: string): boolean {
  if (STD_STREAMS.has(p) || (process.platform === "win32" && /^nul$/i.test(p))) return true;
  const abs = resolvePath(current, p);
  return insideDesignFolder(cwd, design, [abs]) || scratchPath(abs, cwd);
}

/** Drop every heredoc body (through its terminator line): those bytes are never inspected. */
function stripHeredocs(command: string): string {
  let out = "";
  let quote: "\"" | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote === "'") {
      out += c;
      if (c === "'") quote = null;
      continue;
    }
    if (quote === "\"") {
      out += c;
      if (c === "\"") quote = null;
      else if (c === "\\" && i + 1 < command.length) out += command[++i];
      continue;
    }
    if (c === "'" || c === "\"") {
      quote = c;
      out += c;
      continue;
    }
    const marker =
      c === "<" && command[i + 1] === "<" && command[i - 1] !== "<"
        ? /^<<-?\s*(?:'([^']*)'|"([^"]*)"|([A-Za-z_][A-Za-z0-9_]*))/.exec(command.slice(i))
        : null;
    if (!marker) {
      out += c;
      continue;
    }
    out += marker[0]!;
    i += marker[0]!.length - 1;
    const tag = marker[1] ?? marker[2] ?? marker[3]!;
    let pos = command.indexOf("\n", i + 1);
    if (pos === -1) return out;
    pos += 1;
    let end = -1;
    while (pos <= command.length) {
      const nl = command.indexOf("\n", pos);
      const lineEnd = nl === -1 ? command.length : nl;
      if (command.slice(pos, lineEnd).trim() === tag) {
        end = nl === -1 ? command.length : nl + 1;
        break;
      }
      if (nl === -1) break;
      pos = nl + 1;
    }
    if (end === -1) return out;
    out += "\n";
    i = end - 1;
  }
  return out;
}

/** POSIX-ish word splitting. `quoted[i]` records that word i contained quotes. */
function tokenize(segment: string): { words: string[]; quoted: boolean[] } | null {
  const words: string[] = [];
  const quoted: boolean[] = [];
  let cur = "";
  let inWord = false;
  let wasQuoted = false;
  let quote: "\"" | "'" | null = null;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]!;
    if (quote === "'") {
      if (c === "'") quote = null;
      else cur += c;
    } else if (quote === "\"") {
      if (c === "\"") quote = null;
      else if (c === "\\" && i + 1 < segment.length && "\"\\$`\n".includes(segment[i + 1]!)) cur += segment[++i];
      else cur += c;
    } else if (c === "'" || c === "\"") {
      quote = c;
      inWord = true;
      wasQuoted = true;
    } else if (c === "\\" && i + 1 < segment.length) {
      cur += segment[++i];
      inWord = true;
    } else if (c === ">") {
      // A redirect is its own token (with an fd prefix like 2 or &), so a quoted word can't hide its target.
      let op = "";
      if (inWord && !wasQuoted && /^(?:\d+|&)$/.test(cur)) op = cur;
      else if (inWord) {
        words.push(cur);
        quoted.push(wasQuoted);
      }
      cur = "";
      inWord = false;
      wasQuoted = false;
      op += ">";
      if (segment[i + 1] === ">") op += segment[++i];
      if (segment[i + 1] === "|") op += segment[++i];
      if (segment[i + 1] === "&") {
        const dup = /^&(\d+|-)/.exec(segment.slice(i + 1));
        if (dup) {
          op += dup[0];
          i += dup[0].length;
        }
      }
      words.push(op);
      quoted.push(false);
    } else if (/\s/.test(c)) {
      if (inWord) {
        words.push(cur);
        quoted.push(wasQuoted);
        cur = "";
        inWord = false;
        wasQuoted = false;
      }
    } else {
      cur += c;
      inWord = true;
    }
  }
  if (quote) return null;
  if (inWord) {
    words.push(cur);
    quoted.push(wasQuoted);
  }
  return { words, quoted };
}

interface Segment {
  /** Separator before this segment: "", ";", "&&", "||", "|", "&", or "\n". */
  sep: string;
  words: string[];
  quoted: boolean[];
}

/** Split a command line on newlines and unquoted separators, then tokenize each part. */
function splitSegments(text: string): Segment[] | null {
  const segments: Segment[] = [];
  let buf = "";
  let quote: "\"" | "'" | null = null;
  let pending = "";
  const push = (next: string): boolean => {
    const parsed = tokenize(buf);
    if (!parsed) return false;
    if (parsed.words.length) segments.push({ sep: pending, ...parsed });
    buf = "";
    pending = next;
    return true;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote === "'") {
      buf += c;
      if (c === "'") quote = null;
      continue;
    }
    if (quote === "\"") {
      buf += c;
      if (c === "\"") quote = null;
      else if (c === "\\" && i + 1 < text.length) buf += text[++i];
      continue;
    }
    if (c === "'" || c === "\"") {
      quote = c;
      buf += c;
      continue;
    }
    if (c === "\\" && i + 1 < text.length) {
      buf += c + text[++i];
      continue;
    }
    if (c === "\n" || c === "(" || c === ")" || c === "`") {
      // A subshell, $(...) or `...` holds commands of its own: each side is read as one.
      if (!push(c === "\n" ? "\n" : ";")) return null;
      continue;
    }
    if (c === ";") {
      if (!push(";")) return null;
      continue;
    }
    if (c === "&") {
      if (text[i + 1] === "&") {
        if (!push("&&")) return null;
        i++;
        continue;
      }
      if (text[i + 1] === ">" || buf.endsWith(">")) {
        buf += c;
        continue;
      }
      if (!push("&")) return null;
      continue;
    }
    if (c === "|") {
      if (text[i + 1] === "|") {
        if (!push("||")) return null;
        i++;
        continue;
      }
      if (text[i + 1] === "&") {
        if (!push("|")) return null;
        i++;
        continue;
      }
      if (!push("|")) return null;
      continue;
    }
    buf += c;
  }
  if (quote) return null;
  if (!push("")) return null;
  return segments;
}

const WRAPPERS = new Set(["env", "command", "time", "nohup", "exec"]);
/** Shell words that lead into the real command: groups, negation and control flow. */
const KEYWORDS = new Set(["{", "}", "!", "if", "then", "else", "elif", "fi", "do", "done", "while", "until", "for", "case", "esac"]);

/** Index of the real command word, skipping leading assignments and env-style wrappers. */
function commandIndex(words: string[]): number {
  let i = 0;
  while (i < words.length) {
    const w = words[i]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
      i++;
      continue;
    }
    if (KEYWORDS.has(w)) {
      i++;
      continue;
    }
    if (!WRAPPERS.has(program(w))) break;
    i++;
    while (i < words.length && words[i]!.startsWith("-")) i++;
  }
  return i;
}

const REDIR = /^(?:\d*|&)?>>?\|?$/;
const REDIR_FILE = /^((?:\d*|&)?>>?\|?)(.+)$/;

/** Redirect targets (files only, not fd dups like 2>&1) plus the token indexes they occupy. */
function redirects(words: string[], quoted: boolean[]): { files: string[]; skip: Set<number> } {
  const files: string[] = [];
  const skip = new Set<number>();
  for (let i = 0; i < words.length; i++) {
    if (quoted[i]) continue;
    const w = words[i]!;
    if (REDIR.test(w)) {
      skip.add(i);
      const next = words[i + 1];
      if (next !== undefined && !REDIR.test(next)) {
        skip.add(i + 1);
        if (!/^&\d+$/.test(next)) files.push(next);
        i++;
      }
      continue;
    }
    const m = REDIR_FILE.exec(w);
    if (!m) continue;
    skip.add(i);
    if (!/^&\d+$/.test(m[2]!)) files.push(m[2]!);
  }
  return { files, skip };
}

/** Non-flag words after `start`, leaving redirect operators and their targets out. */
function operands(words: string[], quoted: boolean[], start: number): string[] {
  const { skip } = redirects(words, quoted);
  const out: string[] = [];
  let flags = true;
  for (let i = start; i < words.length; i++) {
    if (skip.has(i)) continue;
    const w = words[i]!;
    if (flags && w === "--") {
      flags = false;
      continue;
    }
    if (flags && w.startsWith("-") && w !== "-") continue;
    out.push(w);
  }
  return out;
}

/** First non-flag word after `start`, used for `cd`'s target. */
function firstArg(words: string[], start: number): string | undefined {
  for (let i = start; i < words.length; i++) {
    const w = words[i]!;
    if (w.startsWith("-") && w !== "-") continue;
    return w;
  }
  return undefined;
}

const HARD_BLOCK = new Set([
  "sudo", "su", "doas", "dd", "diskutil", "fdisk", "kill", "pkill", "killall", "launchctl",
  "crontab", "shutdown", "reboot", "ssh", "scp", "sftp", "rsync", "chown",
]);
const GIT_READ = new Set(["status", "diff", "log", "show", "ls-files", "rev-parse", "blame", "grep", "branch"]);
const PKG = new Set(["npm", "pnpm", "yarn", "bun", "pip", "pip3", "brew", "cargo", "gem", "uv"]);
const PKG_SUB = new Set(["install", "i", "add", "remove", "rm", "uninstall", "un", "upgrade", "update", "link", "global"]);
const PATH_WRITE = new Set(["rm", "rmdir", "unlink", "shred", "touch", "mkdir", "truncate", "chmod", "tee"]);
const COPY = new Set(["mv", "cp", "ln", "install"]);
const SHELLS = new Set(["sh", "bash", "zsh", "python", "python3", "node"]);

/** Git is read-only here; branch is read-only only when it has no operands. */
function gitReason(words: string[], start: number): string | null {
  let i = start + 1;
  while (i < words.length) {
    const w = words[i]!;
    if (w === "-C" || w === "-c") {
      i += 2;
      continue;
    }
    if (w.startsWith("-")) {
      i++;
      continue;
    }
    break;
  }
  if (i >= words.length) return null;
  const sub = words[i]!;
  if (sub === "branch") return words.slice(i + 1).some((w) => !w.startsWith("-")) ? "git branch" : null;
  return GIT_READ.has(sub) ? null : `git ${sub}`;
}

/** Package managers may run scripts and inspect things, but not change installed packages. */
function packageReason(words: string[], start: number): string | null {
  const sub = words.slice(start + 1, start + 4).find((w) => PKG_SUB.has(w));
  return sub ? `${program(words[start]!)} ${sub}` : null;
}

/** Download outputs are file writes, whichever flag spelling was used. */
function outputTargets(cmd: string, words: string[], start: number): string[] {
  const short = cmd === "curl" ? "-o" : "-O";
  const long = cmd === "curl" ? "--output" : "--output-document";
  const out: string[] = [];
  for (let i = start; i < words.length; i++) {
    const w = words[i]!;
    if (w === short || w === long) {
      const next = words[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        out.push(next);
        i++;
      }
      continue;
    }
    if (w.startsWith(`${long}=`)) out.push(w.slice(long.length + 1));
    else if (w.startsWith(short) && w.length > short.length) out.push(w.slice(short.length));
  }
  return out;
}

/** `sed` is a write only with -i; then every file after its script must be in bounds. */
function sedFiles(words: string[], start: number): string[] {
  const files: string[] = [];
  let script = false;
  let expressions = false;
  for (let i = start; i < words.length; i++) {
    const w = words[i]!;
    if (w === "-i") {
      if (words[i + 1] === "") i++;
      continue;
    }
    if (w === "--in-place" || w.startsWith("--in-place=") || (w.startsWith("-i") && w.length > 2)) continue;
    if (w === "-e" || w === "--expression" || w === "-f" || w === "--file") {
      expressions = true;
      i++;
      continue;
    }
    if (w.startsWith("-e") && w.length > 2) {
      expressions = true;
      continue;
    }
    if (w.startsWith("-")) continue;
    if (!script && !expressions) {
      script = true;
      continue;
    }
    files.push(w);
  }
  return files;
}

/** Whether sed was given an in-place edit flag, alone or in a short-flag cluster. */
function sedInPlace(words: string[], start: number): boolean {
  return words.slice(start).some((w) => w.startsWith("--in-place") || /^-[A-Za-z]*i/.test(w));
}

/** find -delete, or -exec of rm/mv/shred, writes from its start paths. */
function findReason(cwd: string, design: string, current: string, words: string[], start: number): string | null {
  const args = words.slice(start);
  let dangerous = args.includes("-delete");
  for (let i = 0; i + 1 < args.length && !dangerous; i++) {
    if ((args[i] === "-exec" || args[i] === "-execdir") && ["rm", "mv", "shred"].includes(program(args[i + 1]!))) dangerous = true;
  }
  if (!dangerous) return null;
  const starts: string[] = [];
  for (const a of args) {
    if (a.startsWith("-")) break;
    starts.push(a);
  }
  for (const p of starts.length ? starts : [current]) {
    if (!allowedPath(cwd, design, current, p)) return `find outside ${design}/: ${p}`;
  }
  return null;
}

/** The insides of every $(...) and `...` not in single quotes (double-quoted ones included). */
function substitutions(text: string): string[] {
  const out: string[] = [];
  let quote: "'" | "\"" | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote === "'") {
      if (c === "'") quote = null;
      continue;
    }
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "\"") {
      quote = quote ? null : "\"";
      continue;
    }
    if (c === "'" && !quote) {
      quote = "'";
      continue;
    }
    if (c === "$" && text[i + 1] === "(") {
      let depth = 1;
      let j = i + 2;
      for (; j < text.length && depth; j++) {
        if (text[j] === "(") depth++;
        else if (text[j] === ")") depth--;
      }
      out.push(text.slice(i + 2, depth ? j : j - 1));
      i = j - 1;
    } else if (c === "`") {
      const end = text.indexOf("`", i + 1);
      out.push(text.slice(i + 1, end === -1 ? text.length : end));
      if (end === -1) break;
      i = end;
    }
  }
  return out;
}

/** The reason one command line must be denied, or null when it is in bounds. */
function analyze(cwd: string, design: string, command: string, depth = 0): string | null {
  if (depth > 4) return "couldn't read this command";
  const text = stripHeredocs(command);
  for (const inner of substitutions(text)) {
    const reason = analyze(cwd, design, inner, depth + 1);
    if (reason) return reason;
  }
  const segments = splitSegments(text);
  if (!segments) return "couldn't read this command";
  let current = resolve(cwd);
  for (let s = 0; s < segments.length; s++) {
    const { words, quoted } = segments[s]!;
    if (!words.length) continue;
    for (const p of redirects(words, quoted).files) {
      if (!allowedPath(cwd, design, current, p)) return `write outside ${design}/: ${p}`;
    }
    const ci = commandIndex(words);
    if (ci >= words.length) continue;
    const cmd = program(words[ci]!);
    if (cmd === "cd") {
      const arg = firstArg(words, ci + 1);
      current = arg === undefined ? homedir() : resolvePath(current, arg);
      continue;
    }
    if (HARD_BLOCK.has(cmd) || cmd === "mkfs" || cmd.startsWith("mkfs.")) return cmd;
    // A command string handed to another shell, or to eval, is read like this one.
    const script = cmd === "eval" ? words.slice(ci + 1).join(" ") : ["sh", "bash", "zsh", "dash"].includes(cmd) ? words[words.indexOf("-c", ci + 1) + 1] : undefined;
    if (script !== undefined && (cmd === "eval" || words.indexOf("-c", ci + 1) !== -1)) {
      const reason = analyze(cwd, design, script, depth + 1);
      if (reason) return reason;
    }
    if (cmd === "git") {
      const reason = gitReason(words, ci);
      if (reason) return reason;
    }
    if (PKG.has(cmd)) {
      const reason = packageReason(words, ci);
      if (reason) return reason;
    }
    if (cmd === "curl" || cmd === "wget") {
      for (let j = s + 1; j < segments.length && segments[j]!.sep === "|"; j++) {
        const next = segments[j]!;
        const ni = commandIndex(next.words);
        if (ni < next.words.length && SHELLS.has(program(next.words[ni]!))) return `${cmd} piped to ${program(next.words[ni]!)}`;
      }
      for (const p of outputTargets(cmd, words, ci + 1)) {
        if (!allowedPath(cwd, design, current, p)) return `${cmd} writes outside ${design}/: ${p}`;
      }
    }
    if (PATH_WRITE.has(cmd) || COPY.has(cmd)) {
      let ops = operands(words, quoted, ci + 1);
      if (cmd === "chmod") ops = ops.slice(1);
      for (const p of ops) if (!allowedPath(cwd, design, current, p)) return `${cmd} outside ${design}/: ${p}`;
    }
    if (cmd === "sed" && sedInPlace(words, ci + 1)) {
      for (const p of sedFiles(words, ci + 1)) {
        if (!allowedPath(cwd, design, current, p)) return `sed -i outside ${design}/: ${p}`;
      }
    }
    if (cmd === "find") {
      const reason = findReason(cwd, design, current, words, ci + 1);
      if (reason) return reason;
    }
    if (cmd === "xargs") {
      const sub = words.slice(ci + 1).find((w) => ["rm", "mv", "shred"].includes(program(w)));
      if (sub && !insideDesignFolder(cwd, design, [current])) return `${program(sub)} through xargs outside ${design}/`;
    }
  }
  return null;
}

/**
 * Why writing any of `paths` must be denied in a design thread, or null when
 * every path lands in `<cwd>/<design>`. No paths at all is denied too (an edit
 * that can't be placed). Non-design threads are never fenced.
 */
export function fenceWrite(cwd: string, design: string | undefined, paths: readonly string[]): string | null {
  if (!design) return null;
  if (!paths.length) return `This design thread can only change files in ${design}/, and this edit didn't say which files it changes`;
  if (insideDesignFolder(cwd, design, paths)) return null;
  const outside = paths.find((p) => !insideDesignFolder(cwd, design, [p])) ?? paths[0]!;
  return `This design thread can only change files in ${design}/: ${outside}`;
}

/**
 * Why `command` must be denied in a design thread, or null when it may run.
 * Non-design threads and empty commands are never fenced.
 */
export function fenceCommand(cwd: string, design: string | undefined, command: string): string | null {
  if (!design || !command.trim()) return null;
  try {
    const reason = analyze(cwd, design, command);
    return reason ? `Blocked in a design thread: ${reason}` : null;
  } catch {
    return "Blocked in a design thread: couldn't read this command";
  }
}
