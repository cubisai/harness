/** The intentionally small JSON Schema subset accepted for plugin tool inputs. */
export interface PluginInputSchema {
  type: "object" | "array" | "string" | "number" | "integer" | "boolean";
  description?: string;
  properties?: Record<string, PluginInputSchema>;
  required?: string[];
  additionalProperties?: false;
  items?: PluginInputSchema;
  enum?: string[];
}

export interface PluginTool {
  name: string;
  description: string;
  inputSchema: PluginInputSchema;
}

export interface PluginCard {
  name: string;
  entry: string;
  height: number;
}
