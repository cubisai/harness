import { z } from "zod";
import type { PluginInputSchema } from "../../shared/plugin-tools";

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;
const forbidden = new Set(["__proto__", "constructor", "prototype"]);

/** Validate before any schema reaches an engine. No refs, regexes, unions or open objects. */
export function parsePluginInput(raw: unknown): PluginInputSchema {
  let nodes = 0;
  const visit = (v: unknown, depth: number): PluginInputSchema => {
    if (++nodes > 64 || depth > 4 || !record(v)) throw new Error("Tool inputSchema is limited to 64 fields and four nested levels.");
    const type = v.type;
    if (!["object", "array", "string", "number", "integer", "boolean"].includes(String(type))) throw new Error("Each inputSchema field needs a supported type.");
    const allowed = ["type", "description", ...(type === "object" ? ["properties", "required", "additionalProperties"] : type === "array" ? ["items"] : type === "string" ? ["enum"] : [])];
    if (Object.keys(v).some((k) => !allowed.includes(k))) throw new Error("Unsupported inputSchema field (no refs, open objects or constraints).");
    if (v.description !== undefined && (typeof v.description !== "string" || v.description.length > 300)) throw new Error("Schema descriptions are at most 300 characters.");
    const out: PluginInputSchema = { type: type as PluginInputSchema["type"], ...(typeof v.description === "string" ? { description: v.description } : {}) };
    if (type === "object") {
      if (v.additionalProperties !== undefined && v.additionalProperties !== false) throw new Error("Tool input objects cannot have additional properties.");
      if (v.properties !== undefined && !record(v.properties)) throw new Error("inputSchema properties must be an object.");
      const properties: Record<string, PluginInputSchema> = {};
      for (const [key, value] of Object.entries(v.properties ?? {})) {
        if (!KEY.test(key) || forbidden.has(key)) throw new Error(`Invalid input field "${key}".`);
        properties[key] = visit(value, depth + 1);
      }
      const required = v.required ?? [];
      if (!Array.isArray(required) || !required.every((k) => typeof k === "string" && Object.hasOwn(properties, k)) || new Set(required).size !== required.length) throw new Error("inputSchema required must list unique declared fields.");
      Object.assign(out, { properties, required, additionalProperties: false });
    } else if (type === "array") out.items = visit(v.items, depth + 1);
    else if (v.enum !== undefined) {
      if (!Array.isArray(v.enum) || !v.enum.length || v.enum.length > 32 || !v.enum.every((x) => typeof x === "string" && x.length <= 200) || new Set(v.enum).size !== v.enum.length) throw new Error("A string enum needs 1-32 unique short strings.");
      out.enum = v.enum;
    }
    return out;
  };
  const parsed = visit(raw, 0);
  if (parsed.type !== "object") throw new Error("Tool inputSchema must have an object at its root.");
  return parsed;
}

function field(schema: PluginInputSchema): z.ZodType {
  let out: z.ZodType;
  switch (schema.type) {
    case "object": out = z.object(pluginInputShape(schema)).strict(); break;
    case "array": out = z.array(field(schema.items!)).max(1000); break;
    case "string": out = schema.enum ? z.enum(schema.enum as [string, ...string[]]) : z.string().max(32 * 1024); break;
    case "number": out = z.number(); break;
    case "integer": out = z.number().int(); break;
    case "boolean": out = z.boolean(); break;
  }
  return schema.description ? out.describe(schema.description) : out;
}

export function pluginInputShape(schema: PluginInputSchema): z.ZodRawShape {
  return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, value]) => {
    const parsed = field(value);
    return [key, schema.required?.includes(key) ? parsed : parsed.optional()];
  }));
}
