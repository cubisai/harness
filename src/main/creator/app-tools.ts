// The Creator build loop for apps: write the draft with your own file tools, preview it in the App tab (it hot
// reloads), check it off screen, look at a connector's real data first. Installing goes through creator_propose.

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { HarnessTool, ToolOutput } from "../agents/types";
import type { AppCheckReport } from "../apps/check";
import { APP_MANIFEST, validateApp } from "../apps/manifest";
import { readAppFiles } from "../apps/registry";
import type { McpToolInfo } from "../mcp/servers";
import type { AppInfo, Thread } from "../../shared/types";

export const CREATOR_APP_PREVIEW_TOOL = "creator_app_preview";
export const CREATOR_APP_CHECK_TOOL = "creator_app_check";
export const CREATOR_CONNECTOR_TEST_TOOL = "creator_connector_test";

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const APP_TEMPLATES = ["dashboard"] as const;
const SAMPLE_BYTES = 3000;

export interface CreatorAppToolsDeps {
  /** `resources/creator/templates`. */
  templatesDir: string;
  /** The thread's drafts folder (`<thread folder>/.cubiq/app-drafts`), or null. */
  draftsDir(threadId: string): string | null;
  threadOf(threadId: string): Thread | null;
  /** The listing entry for a frame key (drafts included). */
  appInfo(key: string): AppInfo | null;
  /** Show the draft in the App tab of the window showing this thread. */
  openPreview(threadId: string, app: AppInfo): void;
  /** Reload the previewed frame when the draft folder changes. */
  watch(key: string, threadId: string, dir: string): void;
  check(key: string, src: string, opts: { scheme: "light" | "dark"; screenshot: boolean }): Promise<AppCheckReport>;
  /** Whether this thread's model can take one more image now. */
  takeImage(threadId: string): boolean;
  /** The tools a connector lists, for this thread's project (or global ones). */
  connectorTools(threadId: string, server: string): Promise<{ ok: true; tools: McpToolInfo[] } | { ok: false; error: string }>;
  /** Run one connector tool, refused before the call unless the server marks it read-only. */
  callReadOnly(threadId: string, server: string, tool: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean; data?: unknown }>;
}

function define<S extends z.ZodRawShape>(t: HarnessTool<S>): HarnessTool {
  return t as unknown as HarnessTool;
}

const error = (text: string): ToolOutput => ({ text, isError: true });

export const draftKey = (threadId: string, name: string): string => `d~${threadId}~${name}`;

/** Keys, types and lengths of a value, a few levels deep: enough to write an app against, small enough to read. */
export function shapeOf(v: unknown, depth = 0): unknown {
  if (v === null) return "null";
  if (Array.isArray(v)) return depth > 3 ? `array(${v.length})` : { array: v.length, ...(v.length ? { of: shapeOf(v[0], depth + 1) } : {}) };
  if (typeof v === "object") {
    if (depth > 3) return "object";
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>).slice(0, 40)) out[k] = shapeOf(val, depth + 1);
    return out;
  }
  return typeof v;
}

function parseJson(text: string): unknown {
  const t = text.trim();
  if (!t || (t[0] !== "{" && t[0] !== "[")) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

function inputKeys(schema: unknown): { name: string; type?: string; required?: true }[] {
  if (!schema || typeof schema !== "object") return [];
  const props = (schema as { properties?: Record<string, { type?: unknown }> }).properties ?? {};
  const required = new Set(Array.isArray((schema as { required?: unknown }).required) ? ((schema as { required: string[] }).required) : []);
  return Object.entries(props)
    .slice(0, 20)
    .map(([name, p]) => ({ name, ...(typeof p?.type === "string" ? { type: p.type } : {}), ...(required.has(name) ? { required: true as const } : {}) }));
}

/** Creator-only app tools, bound to one thread. */
export function creatorAppTools(deps: CreatorAppToolsDeps, threadId: string): HarnessTool[] {
  const draftDir = (name: string): string | null => {
    const base = deps.draftsDir(threadId);
    return base ? join(base, name) : null;
  };

  return [
    define({
      name: CREATOR_APP_PREVIEW_TOOL,
      description:
        "Open your draft app in the user's App tab (it reloads by itself on every file change). The draft lives in the folder this returns; write it with your file tools. Pass template to start a new draft from one.",
      input: {
        name: z.string().describe("The app's name: lowercase letters, digits and dashes"),
        template: z.enum(APP_TEMPLATES).optional().describe("Seed a new draft from this template (only when the folder doesn't exist yet)"),
      },
      autoAllow: true,
      effect: "mutate",
      summarize: (a) => String(a.name ?? ""),
      run: async (args) => {
        if (!NAME_RE.test(args.name)) return error('App names are lowercase letters, digits and "-" (up to 64), starting with a letter or digit.');
        const thread = deps.threadOf(threadId);
        if (!thread) return error("Thread not found.");
        const dir = draftDir(args.name);
        if (!dir) return error("This thread has no folder for drafts.");
        let seeded = false;
        if (!existsSync(dir)) {
          if (thread.permissionMode === "plan") return error("Plan mode can't create files. Switch to Ask or Auto-edit first.");
          // A first call without a template makes the empty draft folder and says where to write: a normal step, not a failure.
          if (!args.template) {
            mkdirSync(dir, { recursive: true });
            return {
              text: JSON.stringify({
                path: dir,
                files: [],
                shown: false,
                next: 'Empty draft created. Write app.json and its entry page here with your file tools (or call again with template: "dashboard"), then call creator_app_preview again to show it.',
              }),
            };
          }
          const from = join(deps.templatesDir, args.template);
          if (!existsSync(from)) return error(`Template "${args.template}" is missing.`);
          mkdirSync(dir, { recursive: true });
          cpSync(from, dir, { recursive: true });
          const manifestPath = join(dir, APP_MANIFEST);
          try {
            const m = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
            m.name = args.name;
            writeFileSync(manifestPath, `${JSON.stringify(m, null, 2)}\n`, "utf-8");
          } catch {
            // The template's own app.json is valid JSON; validation below reports anything else.
          }
          seeded = true;
        }
        const { files, errors: readErrors } = readAppFiles(dir);
        const check = validateApp(args.name, files);
        const errors = [...readErrors, ...(check.ok ? [] : check.errors)];
        const key = draftKey(threadId, args.name);
        const info = deps.appInfo(key);
        if (info && check.ok) {
          deps.openPreview(threadId, info);
          deps.watch(key, threadId, dir);
        }
        return {
          text: JSON.stringify({
            path: dir,
            ...(seeded ? { seeded: args.template } : {}),
            files: files.map((f) => f.path),
            ...(errors.length ? { errors, shown: false } : { shown: true }),
            next: errors.length
              ? "Fix these in the draft folder, then call creator_app_preview again."
              : "Shown in the App tab; it reloads when you save. Run creator_app_check before proposing.",
          }),
          ...(errors.length ? { isError: true } : {}),
        };
      },
    }),
    define({
      name: CREATOR_APP_CHECK_TOOL,
      description:
        "Render your draft app off screen with real read-only connector data and report console errors, failed calls, whether it shows anything, its text, and a screenshot. Calls that can change data are not run. Run it before creator_propose.",
      input: {
        name: z.string(),
        scheme: z.enum(["light", "dark"]).optional().describe("Theme to render in (default light)"),
        screenshot: z.boolean().optional().describe("Include a 900x700 screenshot (default true)"),
      },
      autoAllow: true,
      effect: "read",
      summarize: (a) => String(a.name ?? ""),
      run: async (args) => {
        if (!NAME_RE.test(args.name)) return error("Invalid app name.");
        const dir = draftDir(args.name);
        if (!dir || !existsSync(dir)) return error(`No draft named "${args.name}". Create it and call creator_app_preview first.`);
        const { files, errors: readErrors } = readAppFiles(dir);
        const valid = validateApp(args.name, files);
        if (readErrors.length || !valid.ok) return error([...readErrors, ...(valid.ok ? [] : valid.errors)].join("\n"));
        const key = draftKey(threadId, args.name);
        const info = deps.appInfo(key);
        if (!info) return error("The draft can't be opened.");
        const wantImage = args.screenshot !== false;
        const image = wantImage && deps.takeImage(threadId);
        const r = await deps.check(key, info.url, { scheme: args.scheme ?? "light", screenshot: image });
        const { png, ...report } = r;
        const next = r.ok
          ? "Looks fine. Propose it with creator_propose kind: \"app\" when the user's ask is met."
          : "Fix what's listed, then check again.";
        const note = wantImage && !image ? " No screenshot: this conversation already carries as many images as its model takes; rely on the text above." : "";
        return { text: JSON.stringify({ ...report, next }) + note, ...(png ? { imagePng: png.toString("base64") } : {}) };
      },
    }),
    define({
      name: CREATOR_CONNECTOR_TEST_TOOL,
      description:
        "Look at a connector before writing an app against it: without tool, list its tools (read-only or not, inputs); with tool, run that one read-only tool once and get the result's shape and a sample.",
      input: {
        server: z.string(),
        tool: z.string().optional(),
        args: z.object({}).catchall(z.unknown()).optional().describe("Arguments for tool, matching its inputs"),
      },
      autoAllow: true,
      effect: "read",
      summarize: (a) => [a.server, a.tool].filter(Boolean).join("."),
      run: async (args) => {
        const listed = await deps.connectorTools(threadId, args.server);
        if (!listed.ok) return error(listed.error);
        if (!args.tool) {
          return {
            text: JSON.stringify({
              server: args.server,
              tools: listed.tools.slice(0, 80).map((t) => ({
                name: t.name,
                readOnly: t.readOnly === true,
                description: (t.description ?? "").replace(/\s+/g, " ").slice(0, 200),
                inputs: inputKeys(t.inputSchema),
              })),
              note: "Apps run read-only tools at once; any other tool asks the user on every call (or once with \"Always for this app\").",
            }),
          };
        }
        const found = listed.tools.find((t) => t.name === args.tool);
        if (!found) return error(`"${args.server}" has no tool "${args.tool}". Call without tool to list them.`);
        if (!found.readOnly) return error(`"${args.server}.${args.tool}" isn't marked read-only, so the test doesn't run it. Its inputs: ${JSON.stringify(inputKeys(found.inputSchema))}.`);
        const r = await deps.callReadOnly(threadId, args.server, args.tool, (args.args ?? {}) as Record<string, unknown>);
        if (r.isError) return error(r.text.slice(0, 4000));
        const value = r.data !== undefined ? r.data : parseJson(r.text);
        const json = value !== undefined ? JSON.stringify(value) : r.text;
        return {
          text: JSON.stringify({
            call: `${args.server}.${args.tool}`,
            appGets: r.data !== undefined ? "structured data (an object)" : value !== undefined ? "parsed JSON" : "text",
            shape: value !== undefined ? shapeOf(value) : "text",
            bytes: Buffer.byteLength(json, "utf-8"),
            sample: json.length > SAMPLE_BYTES ? `${json.slice(0, SAMPLE_BYTES)}…` : json,
          }),
        };
      },
    }),
  ];
}
