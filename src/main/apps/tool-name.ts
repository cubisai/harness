import { createHash } from "node:crypto";

/** Leave room for Claude's mcp__cubiq__ prefix, and never let app dashes collide with the tool separator. */
export function pluginToolName(app: string, tool: string): string {
  const namespace = app.replace(/-/g, "_");
  const name = `plugin_${namespace}__${tool}`;
  if (!namespace.includes("__") && name.length <= 52) return name;
  // Reserved double-underscore prefix cannot occur in a plain namespace. Hash the complete pair, not a truncated name.
  return `plugin__${createHash("sha256").update(`${app}\0${tool}`).digest("hex").slice(0, 44)}`;
}
