// A tool's JSON Schema as a TypeScript declaration, so a script reads the
// shape of the arguments it has to pass instead of raw schema JSON.

type Schema = Record<string, unknown>;

/** How many object levels render inline before falling back to a record. */
const MAX_DEPTH = 4;

/** `declare function <name>(args: ...)`, documented with the tool's description. */
export function toTsDeclaration(name: string, description: string, schema: unknown): string {
  const root = isSchema(schema) ? schema : null;
  const args = root && properties(root).length ? `args: ${objectType(root, 0)}` : "args?: Record<string, never>";
  const summary = firstLine(description);
  return `${summary ? `/** ${escape(summary)} */` : "/** */"}\ndeclare function ${name}(${args}): Promise<string>;`;
}

/** An inline object type; objects nested deeper than MAX_DEPTH fall back to a record. */
function objectType(schema: Schema, depth: number): string {
  if (depth > MAX_DEPTH) return "Record<string, unknown>";
  const required = new Set(requiredKeys(schema));
  const pad = "  ".repeat(depth + 1);
  const lines = properties(schema).map(([key, prop]) => `${pad}${propDoc(prop)}${keyName(key)}${required.has(key) ? "" : "?"}: ${typeOf(prop, depth + 1)};`);
  return `{\n${lines.join("\n")}\n${"  ".repeat(depth)}}`;
}

/** The schema's properties, in declaration order. */
function properties(schema: Schema): [string, unknown][] {
  const props = schema.properties;
  return isSchema(props) ? Object.entries(props) : [];
}

const requiredKeys = (schema: Schema): string[] => (Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === "string") : []);

/** The type for one value: enums and unions first, then the declared type. */
function typeOf(schema: unknown, depth: number): string {
  if (!isSchema(schema)) return "unknown";
  if (Array.isArray(schema.enum)) return schema.enum.map(literal).join(" | ") || "unknown";
  const union = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : null;
  if (union) {
    const members = [...new Set(union.map((member) => typeOf(member, depth)))];
    return members.join(" | ") || "unknown";
  }
  const types = Array.isArray(schema.type) ? schema.type.filter((type): type is string => typeof type === "string") : typeof schema.type === "string" ? [schema.type] : [];
  if (types.length) return [...new Set(types.map((type) => baseType(type, schema, depth)))].join(" | ");
  return isSchema(schema.properties) ? objectType(schema, depth) : "unknown";
}

function baseType(type: string, schema: Schema, depth: number): string {
  switch (type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array": {
      const items = Array.isArray(schema.items) ? schema.items[0] : schema.items;
      if (items === undefined) return "unknown[]";
      const inner = typeOf(items, depth);
      return inner.includes(" | ") ? `(${inner})[]` : `${inner}[]`;
    }
    case "object":
      return objectType(schema, depth);
    default:
      return "unknown";
  }
}

/** A property's doc comment, omitted when the schema has no description. */
function propDoc(schema: unknown): string {
  if (!isSchema(schema) || typeof schema.description !== "string") return "";
  const line = firstLine(schema.description);
  return line ? `/** ${escape(line)} */ ` : "";
}

/** Identifiers stay bare; anything else is quoted. */
const keyName = (key: string): string => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key) ?? key);

const literal = (value: unknown): string => JSON.stringify(value) ?? "unknown";

const firstLine = (text: string): string => text.split("\n").find((line) => line.trim())?.trim() ?? "";

/** Keep a description from closing the doc comment early. */
const escape = (text: string): string => text.replace(/\*\//g, "*\\/");

const isSchema = (value: unknown): value is Schema => typeof value === "object" && value !== null && !Array.isArray(value);
