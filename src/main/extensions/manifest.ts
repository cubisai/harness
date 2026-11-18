// Validation and canonical digest for Creator mode skill and MCP connector proposals.

import { createHash } from "node:crypto";
import { extname, isAbsolute } from "node:path";
import type { McpOAuthConfig, McpServerSpec, ProposalScope, ProposalStatus } from "../../shared/types";
import { stableStringify } from "../cache-policy";

export const SKILL_MAX_FILES = 32;
export const SKILL_MAX_TOTAL_BYTES = 1024 * 1024;
export const SKILL_MAX_FILE_BYTES = 128 * 1024;
export const SKILL_ALLOWED_EXTENSIONS = new Set([".md", ".txt", ".json", ".yaml", ".yml", ".csv"]);
export const CONNECTOR_MAX_BYTES = 64 * 1024;

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PLACEHOLDER_ONLY_RE = /^(\$\{[A-Z_][A-Z0-9_]*\})+$/;
/** A header may also carry a fixed auth scheme before one placeholder (`Bearer ${GITHUB_TOKEN}`): the scheme is public, the secret stays in the env. */
const SCHEME_PLACEHOLDER_RE = /^(?:Bearer|Token|Basic) \$\{[A-Z_][A-Z0-9_]*\}$/;
const SECRET_KEY_RE = /secret|token|password|apikey|api_key|privatekey/i;

export type { ProposalScope, ProposalStatus };

export type SkillDraft = {
  kind: "skill";
  name: string;
  description: string;
  files: { path: string; content: string }[];
};

export type ConnectorDraft = {
  kind: "connector";
  name: string;
  spec: McpServerSpec;
  note?: string;
};



export interface StoredProposal {
  id: string;
  threadId: string;
  scope: ProposalScope;
  draft: SkillDraft | ConnectorDraft;
  digest: string;
  status: ProposalStatus;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ValidateProposalContext {
  scope: ProposalScope;
  reservedNames?: Iterable<string>;
}

export type ValidateProposalResult =
  | { ok: true; proposal: { scope: ProposalScope; draft: SkillDraft | ConnectorDraft; digest: string } }
  | { ok: false; errors: string[] };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Extract all `${VAR}` placeholder names referenced by a connector spec. */
export function requiredVarsOf(spec: McpServerSpec): string[] {
  const vars = new Set<string>();
  const scan = (map?: Record<string, string>) => {
    if (!map) return;
    for (const val of Object.values(map)) {
      for (const m of val.matchAll(/\$\{([A-Z_][A-Z0-9_]*)\}/g)) {
        if (m[1]) vars.add(m[1]);
      }
    }
  };
  if (spec.type === "stdio") scan(spec.env);
  else scan(spec.headers);
  return [...vars].sort();
}

/** Canonicalize a draft (sorting skill files by path) and compute its sha256 digest with scope. */
export function computeProposalDigest(scope: ProposalScope, draft: SkillDraft | ConnectorDraft): string {
  const canonicalDraft: SkillDraft | ConnectorDraft =
    draft.kind === "skill"
      ? {
          kind: "skill",
          name: draft.name,
          description: draft.description,
          files: [...draft.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
        }
      : draft;
  return createHash("sha256")
    .update(stableStringify({ scope, draft: canonicalDraft }))
    .digest("hex");
}

function unquote(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    try {
      if (value.startsWith('"')) return JSON.parse(value) as string;
    } catch {
      // fall through
    }
    return value.slice(1, -1);
  }
  return value;
}

/** Validate and normalize `SKILL.md` frontmatter, ensuring `name` matches and `description` is JSON-encoded. */
function validateAndNormalizeSkillMd(content: string, expectedName: string, description: string, errors: string[]): string {
  const normalized = content.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0]?.trim() !== "---") {
    errors.push('SKILL.md must start with YAML frontmatter ("---").');
    return normalized;
  }
  const end = lines.findIndex((l, idx) => idx > 0 && l.trim() === "---");
  if (end === -1) {
    errors.push('SKILL.md YAML frontmatter must close with "---".');
    return normalized;
  }
  const fmLines = lines.slice(1, end);
  const fields = new Map<string, string>();
  for (const line of fmLines) {
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line.trim());
    if (match) fields.set(match[1]!.toLowerCase(), unquote(match[2]!.trim()));
  }
  if (fields.has("mode")) {
    errors.push('SKILL.md frontmatter must not include "mode:" (Creator v1 skills apply to all threads).');
  }
  const fmName = fields.get("name");
  if (fmName !== expectedName) {
    errors.push(`SKILL.md frontmatter "name" must equal "${expectedName}" (got ${fmName ? `"${fmName}"` : "none"}).`);
  }
  const encodedDesc = JSON.stringify(description.replace(/\s+/g, " ").trim());
  let replacedDesc = false;
  const updatedFm = fmLines.map((line) => {
    if (/^description:\s*/i.test(line.trim())) {
      replacedDesc = true;
      return `description: ${encodedDesc}`;
    }
    return line;
  });
  if (!replacedDesc) updatedFm.push(`description: ${encodedDesc}`);
  return ["---", ...updatedFm, "---", ...lines.slice(end + 1)].join("\n");
}

function validateRelativeSkillPath(rawPath: unknown, errors: string[]): string | null {
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    errors.push("Every skill file needs a non-empty relative path.");
    return null;
  }
  if (rawPath.includes("\0")) {
    errors.push("Skill file paths must not contain NUL bytes.");
    return null;
  }
  if (rawPath.includes("\\")) {
    errors.push(`Invalid file path "${rawPath}": use forward slashes ("/") only.`);
    return null;
  }
  if (rawPath.startsWith("/") || rawPath.endsWith("/") || /^[A-Za-z]:/.test(rawPath) || isAbsolute(rawPath)) {
    errors.push(`Invalid file path "${rawPath}": path must be relative with no leading slash or drive letter.`);
    return null;
  }
  const segments = rawPath.split("/");
  for (const seg of segments) {
    if (!seg || seg === "." || seg === "..") {
      errors.push(`Invalid file path "${rawPath}": "." and ".." segments are not allowed.`);
      return null;
    }
    if (seg.startsWith(".")) {
      errors.push(`Invalid file path "${rawPath}": dotfiles and dot-directories are not allowed.`);
      return null;
    }
  }
  const ext = extname(segments[segments.length - 1]!).toLowerCase();
  if (!SKILL_ALLOWED_EXTENSIONS.has(ext)) {
    errors.push(
      `Disallowed file extension in "${rawPath}": allowed extensions are ${[...SKILL_ALLOWED_EXTENSIONS].join(", ")}.`,
    );
    return null;
  }
  return rawPath;
}

/** Validate a skill or connector proposal draft and return either the canonical proposal with digest or model-readable errors. */
export function validateProposal(input: unknown, ctx: ValidateProposalContext): ValidateProposalResult {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: ["Proposal draft must be an object."] };

  const kind = input.kind;
  if (kind !== "skill" && kind !== "connector") {
    return { ok: false, errors: ['Proposal draft "kind" must be "skill" or "connector".'] };
  }

  const name = typeof input.name === "string" ? input.name : "";
  if (!NAME_RE.test(name)) {
    errors.push("Name must match /^[a-z0-9][a-z0-9-]{0,63}$/ (lowercase letters, digits and dashes, 1–64 chars).");
  } else {
    const reserved = new Set(["cubiq", ...Array.from(ctx.reservedNames ?? [], (n) => n.toLowerCase())]);
    if (reserved.has(name.toLowerCase())) {
      errors.push(`Name "${name}" is reserved; pick a different name.`);
    }
  }

  if (kind === "skill") {
    const rawDesc = typeof input.description === "string" ? input.description.replace(/\s+/g, " ").trim() : "";
    if (!rawDesc) errors.push('Skill "description" must be a non-empty string.');

    if (!Array.isArray(input.files) || input.files.length === 0) {
      errors.push('Skill "files" must be a non-empty array of { path, content }.');
      return { ok: false, errors };
    }
    if (input.files.length > SKILL_MAX_FILES) {
      errors.push(`Skill may contain at most ${SKILL_MAX_FILES} files (got ${input.files.length}).`);
    }

    const seenLower = new Set<string>();
    const normalizedFiles: { path: string; content: string }[] = [];
    let totalBytes = 0;
    let hasSkillMd = false;

    for (let i = 0; i < input.files.length; i++) {
      const entry = input.files[i];
      if (!isRecord(entry)) {
        errors.push(`File #${i + 1} must be an object with { path, content }.`);
        continue;
      }
      const validPath = validateRelativeSkillPath(entry.path, errors);
      if (typeof entry.content !== "string") {
        errors.push(`File "${String(entry.path ?? i + 1)}" content must be a UTF-8 string.`);
        continue;
      }
      if (entry.content.includes("\0")) {
        errors.push(`File "${String(entry.path ?? i + 1)}" contains a NUL byte; binary content is not allowed.`);
        continue;
      }
      const bytes = Buffer.byteLength(entry.content, "utf-8");
      totalBytes += bytes;
      if (bytes > SKILL_MAX_FILE_BYTES) {
        errors.push(`File "${String(entry.path ?? i + 1)}" exceeds the ${SKILL_MAX_FILE_BYTES}-byte per-file limit (${bytes} bytes).`);
      }
      if (!validPath) continue;

      const lower = validPath.toLowerCase();
      if (seenLower.has(lower)) {
        errors.push(`Duplicate file path "${validPath}" (paths are compared case-insensitively).`);
        continue;
      }
      seenLower.add(lower);

      let content = entry.content.replace(/\r\n/g, "\n");
      if (validPath === "SKILL.md") {
        hasSkillMd = true;
        content = validateAndNormalizeSkillMd(content, name, rawDesc, errors);
      }
      normalizedFiles.push({ path: validPath, content });
    }

    if (totalBytes > SKILL_MAX_TOTAL_BYTES) {
      errors.push(`Skill files exceed the ${SKILL_MAX_TOTAL_BYTES}-byte total limit (${totalBytes} bytes).`);
    }
    if (!hasSkillMd) {
      errors.push('Skill "files" must include "SKILL.md" at the root.');
    }

    if (errors.length > 0) return { ok: false, errors };
    const sortedFiles = [...normalizedFiles].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const draft: SkillDraft = { kind: "skill", name, description: rawDesc, files: sortedFiles };
    return {
      ok: true,
      proposal: { scope: ctx.scope, draft, digest: computeProposalDigest(ctx.scope, draft) },
    };
  }

  // Connector validation
  const rawBytes = Buffer.byteLength(JSON.stringify(input), "utf-8");
  if (rawBytes > CONNECTOR_MAX_BYTES) {
    errors.push(`Connector proposal exceeds the ${CONNECTOR_MAX_BYTES}-byte limit (${rawBytes} bytes).`);
  }
  const note = typeof input.note === "string" && input.note.trim() ? input.note.trim() : undefined;
  const spec = input.spec;
  if (!isRecord(spec)) {
    errors.push('Connector "spec" must be an object.');
    return { ok: false, errors };
  }

  for (const key of Object.keys(spec)) {
    if (SECRET_KEY_RE.test(key)) {
      errors.push(`Connector spec must not contain secret field "${key}". Use \${VAR} placeholders in env or headers.`);
    }
  }

  const type = spec.type;
  if (type !== "stdio" && type !== "http" && type !== "sse") {
    errors.push('Connector spec "type" must be "stdio", "http", or "sse".');
    return { ok: false, errors };
  }

  let validatedSpec: McpServerSpec | null = null;

  if (type === "stdio") {
    for (const key of Object.keys(spec)) {
      if (key !== "type" && key !== "command" && key !== "args" && key !== "env") {
        errors.push(`Unexpected field "${key}" on stdio connector spec.`);
      }
    }
    const command = typeof spec.command === "string" ? spec.command.trim() : "";
    if (!command || /[\r\n\0]/.test(command)) {
      errors.push('Stdio connector "command" must be a non-empty single-line string.');
    }
    let args: string[] | undefined;
    if (spec.args !== undefined) {
      if (!Array.isArray(spec.args) || !spec.args.every((a): a is string => typeof a === "string" && !a.includes("\0"))) {
        errors.push('Stdio connector "args" must be an array of strings.');
      } else {
        args = [...spec.args];
      }
    }
    let env: Record<string, string> | undefined;
    if (spec.env !== undefined) {
      if (!isRecord(spec.env)) {
        errors.push('Stdio connector "env" must be an object mapping variable names to "${VAR}" placeholders.');
      } else {
        env = {};
        for (const [k, v] of Object.entries(spec.env)) {
          if (!ENV_KEY_RE.test(k)) {
            errors.push(`Invalid env variable name "${k}".`);
          }
          if (typeof v !== "string" || (v !== "" && !PLACEHOLDER_ONLY_RE.test(v))) {
            errors.push(`Env "${k}" must be empty or use only \${VAR} placeholders (never a literal secret value).`);
          } else {
            env[k] = v;
          }
        }
      }
    }
    if (errors.length === 0) {
      validatedSpec = { type: "stdio", command, ...(args ? { args } : {}), ...(env ? { env } : {}) };
    }
  } else {
    for (const key of Object.keys(spec)) {
      if (key !== "type" && key !== "url" && key !== "headers" && key !== "oauth") {
        errors.push(`Unexpected field "${key}" on ${type} connector spec.`);
      }
    }
    const rawUrl = typeof spec.url === "string" ? spec.url.trim() : "";
    let parsedUrl: URL | null = null;
    try {
      parsedUrl = new URL(rawUrl);
    } catch {
      errors.push(`Connector "url" is not a valid URL: "${rawUrl}".`);
    }
    if (parsedUrl) {
      if (parsedUrl.username || parsedUrl.password) {
        errors.push("Connector URL must not embed credentials; use headers with ${VAR} placeholders.");
      }
      const isHttps = parsedUrl.protocol === "https:";
      const isLocalHttp = parsedUrl.protocol === "http:" && (parsedUrl.hostname === "localhost" || parsedUrl.hostname === "127.0.0.1");
      if (!isHttps && !isLocalHttp) {
        errors.push('Connector URL must use "https:", or "http:" only for localhost / 127.0.0.1.');
      }
    }
    let headers: Record<string, string> | undefined;
    if (spec.headers !== undefined) {
      if (!isRecord(spec.headers)) {
        errors.push('Connector "headers" must be an object mapping header names to "${VAR}" placeholders.');
      } else {
        headers = {};
        for (const [k, v] of Object.entries(spec.headers)) {
          if (!k.trim() || /[\r\n\0]/.test(k)) {
            errors.push(`Invalid header name "${k}".`);
          }
          if (typeof v !== "string" || (v !== "" && !PLACEHOLDER_ONLY_RE.test(v) && !SCHEME_PLACEHOLDER_RE.test(v))) {
            errors.push(`Header "${k}" must be empty, \${VAR} placeholders, or "Bearer \${VAR}" / "Token \${VAR}" / "Basic \${VAR}" (never a literal token or secret).`);
          } else {
            headers[k] = v;
          }
        }
      }
    }
    let oauth: McpOAuthConfig | undefined;
    if (spec.oauth !== undefined) {
      if (!isRecord(spec.oauth)) {
        errors.push('Connector "oauth" must be an object.');
      } else {
        for (const key of Object.keys(spec.oauth)) {
          if (SECRET_KEY_RE.test(key) || (key !== "clientId" && key !== "scopes" && key !== "callbackPort")) {
            errors.push(`Disallowed field "oauth.${key}" on connector proposal.`);
          }
        }
        oauth = {};
        if (spec.oauth.clientId !== undefined) {
          if (typeof spec.oauth.clientId !== "string") errors.push('"oauth.clientId" must be a string.');
          else oauth.clientId = spec.oauth.clientId;
        }
        if (spec.oauth.scopes !== undefined) {
          if (typeof spec.oauth.scopes !== "string") errors.push('"oauth.scopes" must be a string.');
          else oauth.scopes = spec.oauth.scopes;
        }
        if (spec.oauth.callbackPort !== undefined) {
          if (typeof spec.oauth.callbackPort !== "number" || !Number.isInteger(spec.oauth.callbackPort)) {
            errors.push('"oauth.callbackPort" must be an integer.');
          } else {
            oauth.callbackPort = spec.oauth.callbackPort;
          }
        }
      }
    }
    if (errors.length === 0) {
      validatedSpec = {
        type,
        url: rawUrl,
        ...(headers ? { headers } : {}),
        ...(oauth && Object.keys(oauth).length > 0 ? { oauth } : {}),
      };
    }
  }

  if (errors.length > 0 || !validatedSpec) return { ok: false, errors };
  const draft: ConnectorDraft = { kind: "connector", name, spec: validatedSpec, ...(note ? { note } : {}) };
  return {
    ok: true,
    proposal: { scope: ctx.scope, draft, digest: computeProposalDigest(ctx.scope, draft) },
  };
}
