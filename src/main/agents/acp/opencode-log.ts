/**
 * OpenCode's stderr diagnostics, read as logfmt. Run with `--print-logs
 * --log-level INFO`, OpenCode keeps JSON-RPC on stdout and writes one logfmt
 * line per event to stderr. A retrying model call and a permission ask it never
 * surfaces over ACP are both visible there, so the driver can explain a stall
 * the ACP stream alone can't.
 */

/**
 * Parse one logfmt line into its key/value pairs. A value is either bare (up to
 * the next space) or double-quoted, where `\"` unescapes to `"`. Returns null
 * when the line isn't logfmt at all (a token with no `=`, trailing junk), so a
 * stray non-logfmt stderr line is never mistaken for a log record.
 */
export function parseLogfmt(line: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  const n = line.length;
  let i = 0;
  while (i < n) {
    while (i < n && line[i] === " ") i++;
    if (i >= n) break;
    const keyStart = i;
    while (i < n && line[i] !== "=" && line[i] !== " ") i++;
    if (i >= n || line[i] !== "=") return null;
    const key = line.slice(keyStart, i);
    if (!key) return null;
    i++; // past "="
    let value: string;
    if (line[i] === '"') {
      i++;
      let s = "";
      let closed = false;
      while (i < n) {
        const ch = line[i]!;
        if (ch === "\\" && i + 1 < n) {
          s += line[i + 1];
          i += 2;
          continue;
        }
        if (ch === '"') {
          closed = true;
          i++;
          break;
        }
        s += ch;
        i++;
      }
      if (!closed) return null;
      value = s;
    } else {
      const valStart = i;
      while (i < n && line[i] !== " ") i++;
      value = line.slice(valStart, i);
    }
    out[key] = value;
    if (i < n && line[i] !== " ") return null;
  }
  return Object.keys(out).length ? out : null;
}

/** A permission ask OpenCode is waiting on but never sends over ACP. */
export interface OpenCodeAsking {
  kind: "asking";
  /** OpenCode's ask id (`per_…`), so repeated lines are said once. */
  id: string;
  /** The permission kind (e.g. `external_directory`). */
  permission: string;
  /** The glob patterns the ask covers; empty when unparsable. */
  patterns: string[];
}

/** A model call failure OpenCode logged and may retry. */
export interface OpenCodeStreamError {
  kind: "stream-error";
  provider?: string;
  model?: string;
  /** The error text, with OpenCode's trailing "(request id: …)" stripped. */
  error: string;
}

/** Drop a trailing ` (request id: …)` OpenCode appends to provider errors. */
function stripRequestId(error: string): string {
  return error.replace(/\s*\(request id: [^)]*\)\s*$/, "");
}

/**
 * Classify an OpenCode stderr line into the stall it explains, or null for
 * anything else. `message=asking` carries the permission and its patterns;
 * `message="stream error"` carries the failed provider/model and the error.
 */
export function classifyOpenCodeLog(line: string): OpenCodeAsking | OpenCodeStreamError | null {
  const fields = parseLogfmt(line);
  if (!fields) return null;
  if (fields.message === "asking") {
    let patterns: string[] = [];
    const raw = fields.patterns;
    if (raw !== undefined) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) patterns = parsed.filter((p): p is string => typeof p === "string");
      } catch {
        // An unrecognised patterns value just means we name the permission without them.
      }
    }
    return { kind: "asking", id: fields.id ?? "", permission: fields.permission ?? "", patterns };
  }
  if (fields.message === "stream error") {
    const error = fields["error.error"];
    if (!error) return null;
    return {
      kind: "stream-error",
      ...(fields.providerID ? { provider: fields.providerID } : {}),
      ...(fields.modelID ? { model: fields.modelID } : {}),
      error: stripRequestId(error),
    };
  }
  return null;
}
