import { z } from "zod";
import type { HarnessTool } from "../agents/types";
import { findDuplicate } from "./dedupe";
import { SECRETISH } from "./extractor";
import { rank } from "./rank";
import { GLOBAL_SCOPE, type MemoryFact, type MemoryStore } from "./store";

/** The harness tool agents without native memory call to read the shared store. */
export const MEMORY_READ_TOOL = "memory_read";

/** The harness tool agents call to save, change or remove a shared-memory note. */
export const MEMORY_WRITE_TOOL = "memory_write";

/** Which store scope a note lives in: this project's, or the one shared by every project. */
const SCOPE = z.enum(["project", "global"]);

type ScopeChoice = z.infer<typeof SCOPE>;

/** Note-field budgets, in characters, after trimming. */
const NAME_MAX = 80;
const DESCRIPTION_MAX = 150;
const BODY_MAX = 2000;

/** Budgets for one memory_read reply. */
const READ_BODY_MAX = 4000;
const LIST_MAX_LINES = 60;
const LIST_MAX_CHARS = 4000;

function define<S extends z.ZodRawShape>(t: HarnessTool<S>): HarnessTool {
  return t as unknown as HarnessTool;
}

/** The store's scope id for a caller's scope choice. */
function scopeId(projectId: string, choice: ScopeChoice): string {
  return choice === "global" ? GLOBAL_SCOPE : projectId;
}

/** The scopes a call touches: the chosen one, or `order` when the caller left it out. */
function scopesFor(choice: ScopeChoice | undefined, order: [ScopeChoice, ScopeChoice]): ScopeChoice[] {
  return choice ? [choice] : order;
}

/** The one-line listing both search results and the list use. */
function lineFor(scope: ScopeChoice, fact: { file: string; type: string; updated?: string; name: string; description: string }): string {
  return `${scope}: ${fact.file} (${fact.type}${fact.updated ? `, ${fact.updated}` : ""}) — ${fact.name}: ${fact.description}`;
}

/** A "N chars; keep a note under M" error for an over-long field, or null. */
function overLimit(label: string, value: string, max: number): string | null {
  return value.length > max ? `${label} is ${value.length} chars; keep a note under ${max} (split it or summarise).` : null;
}

/** A scope's notes in display order: corrections first (newest marked first), then as listed. */
function orderForListing(store: MemoryStore, scope: string, notes: Omit<MemoryFact, "body">[]): Omit<MemoryFact, "body">[] {
  const meta = store.meta(scope);
  const marked = (f: Omit<MemoryFact, "body">): number | undefined => meta[f.file]?.correction;
  const corrections = notes.filter((n) => marked(n) !== undefined).sort((a, b) => marked(b)! - marked(a)! || (a.file < b.file ? -1 : 1));
  return corrections.length ? [...corrections, ...notes.filter((n) => marked(n) === undefined)] : notes;
}

/** Whether any of these strings looks like a credential. */
function looksSecret(...values: (string | undefined)[]): boolean {
  return values.some((v) => typeof v === "string" && SECRETISH.test(v));
}

/**
 * The shared-memory reader, as a harness tool: the HTTP tool server tells it
 * which project is calling (the URL's `?p=`), so an ACP or Codex agent gets the
 * same notes Claude reads natively.
 */
export function memoryReadTool(deps: { store: MemoryStore; enabled: (projectId: string) => boolean }): HarnessTool {
  return define({
    name: MEMORY_READ_TOOL,
    description:
      'Read the shared memory (notes CubiQ keeps across agents and sessions). Scope "global" reads notes about the user that hold in every project; omit it to try this project then global. With a file name, returns that note in full; with query, searches names, descriptions and bodies; with neither, lists every note.',
    input: {
      file: z.string().optional().describe("A note's file name from the memory index, e.g. commit-style.md"),
      scope: SCOPE.optional().describe('"global" for notes about the user across every project, "project" for this project\'s; omit to search both'),
      query: z.string().optional().describe("Words to search for across note names, descriptions and bodies"),
    },
    autoAllow: true,
    effect: "read",
    run: async (args, ctx) => {
      if (!ctx?.projectId || !deps.enabled(ctx.projectId)) {
        return { text: "Project memory is off or unavailable for this session.", isError: true };
      }
      const projectId = ctx.projectId;
      try {
        if (args.file !== undefined) {
          for (const choice of scopesFor(args.scope, ["project", "global"])) {
            const scope = scopeId(projectId, choice);
            const fact = deps.store.read(scope, args.file);
            if (!fact) continue;
            deps.store.touch(scope, args.file);
            const updated = fact.updated ? ` · updated ${fact.updated}` : "";
            const body = fact.body.length > READ_BODY_MAX ? `${fact.body.slice(0, READ_BODY_MAX)}\n… (truncated)` : fact.body;
            return { text: `# ${fact.name}\n(${choice} · ${fact.type}${updated})\n${fact.description}\n\n${body}` };
          }
          return { text: `No note named ${args.file}. Call memory_read without a file to list them.`, isError: true };
        }
        if (args.query !== undefined) {
          const candidates: { choice: ScopeChoice; fact: MemoryFact; correction: boolean; recency: number }[] = [];
          for (const choice of scopesFor(args.scope, ["global", "project"])) {
            const scope = scopeId(projectId, choice);
            const meta = deps.store.meta(scope);
            const usage = deps.store.usage(scope);
            for (const note of deps.store.list(scope)) {
              const fact = deps.store.read(scope, note.file);
              if (!fact) continue;
              candidates.push({
                choice,
                fact,
                correction: meta[note.file]?.correction !== undefined,
                recency: Math.max(Date.parse(fact.updated ?? "") || 0, usage[note.file] ?? 0),
              });
            }
          }
          // The name is doubled so a title match outweighs a passing body mention.
          const scores = rank(args.query, candidates.map((c) => `${c.fact.name} ${c.fact.name} ${c.fact.description} ${c.fact.body}`));
          const hits = candidates
            .map((c, i) => ({ score: scores[i]! * (c.correction ? 1.5 : 1), recency: c.recency, file: c.fact.file, line: lineFor(c.choice, c.fact) }))
            .filter((h) => h.score > 0);
          if (!hits.length) return { text: `No notes match "${args.query}".` };
          hits.sort((a, b) => b.score - a.score || b.recency - a.recency || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
          return { text: hits.slice(0, 5).map((h) => h.line).join("\n") };
        }
        const lines: string[] = [];
        for (const choice of scopesFor(args.scope, ["global", "project"])) {
          const scope = scopeId(projectId, choice);
          for (const note of orderForListing(deps.store, scope, deps.store.list(scope))) lines.push(lineFor(choice, note));
        }
        if (!lines.length) return { text: "No notes yet." };
        const kept: string[] = [];
        let chars = 0;
        for (const line of lines) {
          if (kept.length >= LIST_MAX_LINES) break;
          const extra = (kept.length ? 1 : 0) + line.length;
          if (chars + extra > LIST_MAX_CHARS) break;
          kept.push(line);
          chars += extra;
        }
        if (kept.length === lines.length) return { text: kept.join("\n") };
        // The notice is one more line: give it the last slot within the 60-line cap.
        while (kept.length >= LIST_MAX_LINES) kept.pop();
        const render = () => `${kept.join("\n")}\n… ${lines.length - kept.length} more; use query to search`;
        while (kept.length && render().length > LIST_MAX_CHARS) kept.pop();
        return { text: render() };
      } catch (err) {
        return { text: err instanceof Error ? err.message : String(err), isError: true };
      }
    },
  });
}

/**
 * The shared-memory writer, as a harness tool, so an ACP or Codex agent can
 * save, change or remove notes the same way Claude does natively.
 */
export function memoryWriteTool(deps: { store: MemoryStore; enabled: (projectId: string) => boolean }): HarnessTool {
  return define({
    name: MEMORY_WRITE_TOOL,
    description:
      'Save, change or remove a note in the shared memory (CubiQ): op "add" saves a new note, "update" merges changes into an existing one, "delete" removes it. Scope "global" is for facts about the user that hold in every project, otherwise this project. Update a note instead of adding a near-duplicate, and never store secrets.',
    input: {
      op: z.enum(["add", "update", "delete"]).describe("add a new note, update an existing one, or delete it"),
      scope: SCOPE.optional().describe('"global" for facts about the user that hold in every project, otherwise this project'),
      file: z.string().optional().describe("The note's file name; required for update and delete"),
      name: z.string().optional().describe("The note's title (add/update)"),
      description: z.string().optional().describe("A one-line summary (add/update)"),
      type: z.enum(["user", "feedback", "project", "reference"]).optional().describe('"user" facts default to global scope; other types to this project'),
      body: z.string().optional().describe("The full note (add/update)"),
      correction: z.boolean().optional().describe("true when this note corrects or replaces an earlier belief"),
      supersedes: z.string().optional().describe("For add: the file of the note this one replaces; that note is deleted"),
    },
    autoAllow: true,
    effect: "mutate",
    run: async (args, ctx) => {
      if (!ctx?.projectId || !deps.enabled(ctx.projectId)) {
        return { text: "Project memory is off or unavailable for this session.", isError: true };
      }
      const projectId = ctx.projectId;
      try {
        const choice: ScopeChoice = args.scope ?? (args.type === "user" ? "global" : "project");
        const scope = scopeId(projectId, choice);
        const fail = (text: string) => ({ text, isError: true });

        if (args.op === "add") {
          const name = (args.name ?? "").trim();
          const description = (args.description ?? "").trim();
          const body = (args.body ?? "").trim();
          if (!name) return fail("Missing required field: name.");
          if (!description) return fail("Missing required field: description.");
          if (!body) return fail("Missing required field: body.");
          const over = overLimit("Name", name, NAME_MAX) ?? overLimit("Description", description, DESCRIPTION_MAX) ?? overLimit("Body", body, BODY_MAX);
          if (over) return fail(over);
          if (looksSecret(name, description, body)) return fail("That looks like a credential; memory never stores secrets.");
          const type = args.type ?? (choice === "global" ? "user" : "project");
          // A correction is marked, and a superseded note in the same scope is wrong now: delete it.
          const applyCorrection = (file: string): string => {
            const superseded = args.supersedes && args.supersedes !== file && deps.store.read(scope, args.supersedes) ? args.supersedes : null;
            if (args.correction) deps.store.markCorrection(scope, file, args.supersedes);
            if (superseded) deps.store.remove(scope, superseded);
            return superseded ? `; deleted superseded ${superseded}` : "";
          };
          const dup = findDuplicate(deps.store, scope, name, description);
          if (dup?.kind === "same") {
            deps.store.write(scope, { file: dup.file, name, description, type, body });
            return { text: `Updated existing note ${dup.file} (${choice})${applyCorrection(dup.file)}.` };
          }
          if (dup) {
            const similar = deps.store.read(scope, dup.file);
            return fail(`Similar note exists: ${dup.file} (${similar?.name ?? dup.file}). Update it with op "update" and file "${dup.file}" instead.`);
          }
          const file = deps.store.write(scope, { name, description, type, body });
          return { text: `Saved ${file} (${choice})${applyCorrection(file)}.` };
        }

        // Update and delete find the note where it lives when no scope was given: this project first, then global.
        const located = (file: string): { choice: ScopeChoice; scope: string } | null => {
          for (const c of scopesFor(args.scope, ["project", "global"])) if (deps.store.read(scopeId(projectId, c), file)) return { choice: c, scope: scopeId(projectId, c) };
          return null;
        };

        if (args.op === "update") {
          if (!args.file) return fail("Update needs a file. Call memory_read to list them.");
          const where = located(args.file);
          const current = where ? deps.store.read(where.scope, args.file) : null;
          if (!where || !current) return fail(`No note named ${args.file}. Call memory_read to list them.`);
          const name = args.name?.trim() || current.name;
          const description = args.description?.trim() || current.description;
          const body = args.body?.trim() || current.body;
          const type = args.type ?? current.type;
          const over = overLimit("Name", name, NAME_MAX) ?? overLimit("Description", description, DESCRIPTION_MAX) ?? overLimit("Body", body, BODY_MAX);
          if (over) return fail(over);
          if (looksSecret(name, description, body)) return fail("That looks like a credential; memory never stores secrets.");
          deps.store.write(where.scope, { file: args.file, name, description, type, body });
          if (args.correction) deps.store.markCorrection(where.scope, args.file);
          return { text: `Updated ${args.file} (${where.choice}).` };
        }

        if (!args.file) return fail("Delete needs a file. Call memory_read to list them.");
        const where = located(args.file);
        if (!where || !deps.store.remove(where.scope, args.file)) return fail(`No note named ${args.file}. Call memory_read to list them.`);
        return { text: `Deleted ${args.file} (${where.choice}).` };
      } catch (err) {
        return { text: err instanceof Error ? err.message : String(err), isError: true };
      }
    },
  });
}
