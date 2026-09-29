import { z } from "zod";
import type { HarnessTool } from "../agents/types";
import type { MemoryStore } from "./store";

/** The harness tool agents without native memory call to read the shared store. */
export const MEMORY_READ_TOOL = "memory_read";

function define<S extends z.ZodRawShape>(t: HarnessTool<S>): HarnessTool {
  return t as unknown as HarnessTool;
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
      "Read the project's shared memory (notes CubiQ keeps across agents and sessions). With a file name, returns that note in full; without one, lists every note's file, type and one-line description.",
    input: {
      file: z.string().optional().describe("A note's file name from the memory index, e.g. commit-style.md; omit to list every note"),
    },
    autoAllow: true,
    run: async (args, ctx) => {
      if (!ctx?.projectId || !deps.enabled(ctx.projectId)) {
        return { text: "Project memory is off or unavailable for this session.", isError: true };
      }
      const projectId = ctx.projectId;
      if (args.file === undefined) {
        const facts = deps.store.list(projectId);
        if (!facts.length) return { text: "No notes yet." };
        return { text: facts.map((f) => `${f.file} (${f.type}) — ${f.name}: ${f.description}`).join("\n") };
      }
      const fact = deps.store.read(projectId, args.file);
      if (!fact) return { text: `No note named ${args.file}. Call memory_read without a file to list them.`, isError: true };
      return { text: `# ${fact.name}\n${fact.description}\n\n${fact.body}` };
    },
  });
}
